package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"sync"
	"time"
)

// The DNIe signs only RSA PKCS#1 v1.5 (no PSS), so remote keys stay on TLS 1.2, where these
// schemes are allowed for client certificates (docs/research/dnie.md §3.1).
var pkcs1Schemes = []tls.SignatureScheme{
	tls.PKCS1WithSHA256, tls.PKCS1WithSHA384, tls.PKCS1WithSHA512, tls.PKCS1WithSHA1,
}

var hashNames = map[crypto.Hash]string{
	crypto.SHA1:   "SHA-1",
	crypto.SHA256: "SHA-256",
	crypto.SHA384: "SHA-384",
	crypto.SHA512: "SHA-512",
}

const (
	// The user may still have to approve on the phone and hold the card.
	prepareTimeout = 5 * time.Minute
	// The card is ready by then: a signature takes a few seconds.
	signTimeout = 2 * time.Minute
)

// identity is a session's client certificate and its upstream connections. Its pool keeps
// connections open and serializes handshakes per host, so a login costs as few signatures as
// possible: each full handshake is one card operation, and a resumed one is none.
type identity struct {
	p       *proxy
	session string
	spec    identitySpec
	chain   [][]byte
	leaf    *x509.Certificate
	// signer is the key in memory; nil for a remote key.
	signer crypto.Signer
	cache  tls.ClientSessionCache

	transport *http.Transport
	proxy     *httputil.ReverseProxy
	locks     sync.Map // addr → *sync.Mutex
}

func (p *proxy) newIdentity(session string, spec identitySpec) (*identity, error) {
	if spec.ID == "" || len(spec.Chain) == 0 {
		return nil, errors.New("an identity needs an id and a certificate")
	}
	chain := make([][]byte, 0, len(spec.Chain))
	for _, c := range spec.Chain {
		der, err := base64.StdEncoding.DecodeString(c)
		if err != nil {
			return nil, fmt.Errorf("bad certificate: %w", err)
		}
		chain = append(chain, der)
	}
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return nil, fmt.Errorf("bad certificate: %w", err)
	}
	id := &identity{
		p:       p,
		session: session,
		spec:    spec,
		chain:   chain,
		leaf:    leaf,
		cache:   tls.NewLRUClientSessionCache(64),
	}
	maxConns := spec.MaxConns
	if spec.Key != "" {
		der, err := base64.StdEncoding.DecodeString(spec.Key)
		if err != nil {
			return nil, errors.New("bad key")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(der)
		if err != nil {
			return nil, errors.New("bad key")
		}
		signer, ok := parsed.(crypto.Signer)
		if !ok || !samePublicKey(signer.Public(), leaf.PublicKey) {
			return nil, errors.New("the key doesn't match the certificate")
		}
		id.signer = signer
		if maxConns <= 0 {
			maxConns = 6
		}
	} else {
		if _, ok := leaf.PublicKey.(*rsa.PublicKey); !ok {
			return nil, errors.New("remote keys must be RSA")
		}
		if maxConns <= 0 {
			maxConns = 2
		}
	}
	id.transport = &http.Transport{
		DialTLSContext:        id.dialTLS,
		MaxConnsPerHost:       maxConns,
		MaxIdleConnsPerHost:   maxConns,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
	}
	id.proxy = &httputil.ReverseProxy{
		Director:      id.direct,
		Transport:     id.transport,
		FlushInterval: -1,
		ErrorHandler:  id.fail,
		ErrorLog:      quiet,
	}
	return id, nil
}

func (id *identity) same(spec identitySpec) bool {
	if id.spec.ID != spec.ID || id.spec.Key != spec.Key || id.spec.MaxConns != spec.MaxConns ||
		len(id.spec.Chain) != len(spec.Chain) {
		return false
	}
	for i := range spec.Chain {
		if id.spec.Chain[i] != spec.Chain[i] {
			return false
		}
	}
	return true
}

func (id *identity) close() {
	id.transport.CloseIdleConnections()
}

func (id *identity) direct(r *http.Request) {
	r.URL.Scheme = "https"
	if mc, ok := r.Context().Value(mitmKey{}).(*mitmConn); ok {
		r.URL.Host = mc.target
	}
	forwardHeaders(r)
}

// fail answers the browser when the upstream request failed: a page that says why, and a header
// the app reads (X-Sa-Certificate-Error).
func (id *identity) fail(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		return // the browser went away
	}
	hostname := r.URL.Hostname()
	if mc, ok := r.Context().Value(mitmKey{}).(*mitmConn); ok {
		hostname, _, _ = net.SplitHostPort(mc.target)
	}
	ce := classify(err)
	id.p.desk.send(outMessage{
		Type: "event", Event: "upstream_error", Session: id.session, Identity: id.spec.ID,
		Host: hostname, Code: ce.code, Message: ce.detail,
	})
	writeCertError(w, hostname, ce)
}

func (id *identity) lock(addr string) *sync.Mutex {
	l, _ := id.locks.LoadOrStore(addr, &sync.Mutex{})
	return l.(*sync.Mutex)
}

// dialTLS opens an upstream connection with the client certificate. Remote keys are prepared
// first (the user may have to approve on the phone), outside any handshake, so slow approvals
// never hit a server's handshake timeout.
func (id *identity) dialTLS(ctx context.Context, _, addr string) (net.Conn, error) {
	hostname, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if id.signer == nil {
		if err := id.prepare(ctx, hostname); err != nil {
			return nil, err
		}
	}
	// One handshake at a time per host: the next one can resume the session of the first.
	lock := id.lock(addr)
	lock.Lock()
	defer lock.Unlock()

	raw, err := id.p.dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, &certError{code: "unreachable", detail: err.Error()}
	}
	signed := false
	cert, key := id.certificate(ctx, hostname, &signed)
	config := &tls.Config{
		ServerName:         hostname,
		RootCAs:            id.p.roots,
		InsecureSkipVerify: id.p.insecure,
		MinVersion:         tls.VersionTLS12,
		Renegotiation:      tls.RenegotiateOnceAsClient,
		ClientSessionCache: id.cache,
		NextProtos:         []string{"http/1.1"},
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			return cert, nil
		},
	}
	if id.signer == nil {
		config.MaxVersion = tls.VersionTLS12
	}
	conn := tls.Client(raw, config)
	if err := conn.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, classify(err)
	}
	id.p.desk.send(outMessage{
		Type: "event", Event: "handshake", Session: id.session, Identity: id.spec.ID,
		Host: hostname, Resumed: conn.ConnectionState().DidResume, Signed: signed,
	})
	if key == nil {
		return conn, nil
	}
	return &upstreamConn{Conn: conn, cancel: key.renegotiation(lock)}, nil
}

// upstreamConn ends a remote key's connection context when the connection closes.
type upstreamConn struct {
	net.Conn
	cancel context.CancelFunc
}

func (c *upstreamConn) Close() error {
	c.cancel()
	return c.Conn.Close()
}

func (id *identity) prepare(ctx context.Context, hostname string) error {
	ctx, cancel := context.WithTimeout(ctx, prepareTimeout)
	defer cancel()
	reply, err := id.p.desk.call(ctx, outMessage{
		Method: "prepare", Session: id.session, Identity: id.spec.ID, Host: hostname,
	})
	if err != nil {
		return &certError{code: "timeout", detail: "the certificate wasn't ready in time"}
	}
	if reply.Error != "" {
		return &certError{code: reply.Error, detail: reply.Message}
	}
	return nil
}

// certificate is the client certificate for one connection; the remote key is nil for a key in
// memory.
func (id *identity) certificate(ctx context.Context, hostname string, signed *bool) (*tls.Certificate, *remoteKey) {
	cert := &tls.Certificate{Certificate: id.chain, Leaf: id.leaf}
	if id.signer != nil {
		cert.PrivateKey = &localKey{Signer: id.signer, signed: signed}
		return cert, nil
	}
	key := &remoteKey{id: id, ctx: ctx, host: hostname, signed: signed}
	cert.PrivateKey = key
	cert.SupportedSignatureAlgorithms = pkcs1Schemes
	return cert, key
}

// localKey is a key in memory; it records that the handshake signed.
type localKey struct {
	crypto.Signer
	signed *bool
}

func (k *localKey) Sign(rand io.Reader, digest []byte, opts crypto.SignerOpts) ([]byte, error) {
	*k.signed = true
	return k.Signer.Sign(rand, digest, opts)
}

// remoteKey signs through the desktop app (the DNIe in the phone): PKCS#1 v1.5 over the digest.
type remoteKey struct {
	id     *identity
	ctx    context.Context
	host   string
	signed *bool
	// lock is the host's handshake lock, set once the connection is open: any later signature
	// is for a renegotiation.
	lock *sync.Mutex
}

// renegotiation moves the key from the dial's context to the connection's, once the first
// handshake is done. The dial's context ends with the request that opened the connection, but a
// server may renegotiate on a later request (Apache's per-location SSLVerifyClient). The
// returned func ends the connection's context.
func (k *remoteKey) renegotiation(lock *sync.Mutex) context.CancelFunc {
	ctx, cancel := context.WithCancel(context.Background())
	k.ctx, k.lock = ctx, lock
	return cancel
}

func (k *remoteKey) Public() crypto.PublicKey { return k.id.leaf.PublicKey }

func (k *remoteKey) Sign(_ io.Reader, digest []byte, opts crypto.SignerOpts) ([]byte, error) {
	if _, pss := opts.(*rsa.PSSOptions); pss {
		return nil, &certError{code: "failed", detail: "the card can't sign with RSA-PSS"}
	}
	hash := opts.HashFunc()
	name, ok := hashNames[hash]
	if !ok || len(digest) != hash.Size() {
		return nil, &certError{code: "failed", detail: "unsupported hash"}
	}
	if k.lock != nil {
		// A renegotiation: the phone's approval from the dial may be gone, so ask again, like a
		// new connection does.
		k.lock.Lock()
		defer k.lock.Unlock()
		if err := k.id.prepare(k.ctx, k.host); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(k.ctx, signTimeout)
	defer cancel()
	reply, err := k.id.p.desk.call(ctx, outMessage{
		Method: "sign", Session: k.id.session, Identity: k.id.spec.ID, Host: k.host,
		Hash: name, Digest: base64.StdEncoding.EncodeToString(digest),
	})
	if err != nil {
		return nil, &certError{code: "timeout", detail: "no signature in time"}
	}
	if reply.Error != "" {
		return nil, &certError{code: reply.Error, detail: reply.Message}
	}
	signature, err := base64.StdEncoding.DecodeString(reply.Signature)
	if err != nil {
		return nil, &certError{code: "failed", detail: "bad signature"}
	}
	// A different card, or a broken signer: fail here with a clear reason.
	pub := k.id.leaf.PublicKey.(*rsa.PublicKey)
	if err := rsa.VerifyPKCS1v15(pub, hash, digest, signature); err != nil {
		return nil, &certError{code: "failed", detail: "the signature doesn't match the certificate"}
	}
	*k.signed = true
	return signature, nil
}

func samePublicKey(a, b crypto.PublicKey) bool {
	da, err1 := x509.MarshalPKIXPublicKey(a)
	db, err2 := x509.MarshalPKIXPublicKey(b)
	return err1 == nil && err2 == nil && bytes.Equal(da, db)
}
