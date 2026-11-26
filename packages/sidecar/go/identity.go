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
//
// A lazy identity starts without a certificate: the app sends it in the reply to a "prepare"
// call, with the key when the sidecar keeps it in memory. So the app asks the user for nothing
// until a site asks for the certificate.
type identity struct {
	p       *proxy
	session string
	spec    identitySpec
	cache   tls.ClientSessionCache

	// mu guards the certificate and the key: a "prepare" reply can set them.
	mu    sync.Mutex
	chain [][]byte
	leaf  *x509.Certificate
	// signer is the key in memory; nil for a remote key, and for a lazy identity before its
	// first "prepare" reply.
	signer crypto.Signer

	transport *http.Transport
	proxy     *httputil.ReverseProxy
	locks     sync.Map // addr → *sync.Mutex
}

func (p *proxy) newIdentity(session string, spec identitySpec) (*identity, error) {
	if spec.ID == "" || (len(spec.Chain) == 0 && spec.Key != "") {
		return nil, errors.New("an identity needs an id and a certificate")
	}
	id := &identity{
		p:       p,
		session: session,
		spec:    spec,
		cache:   tls.NewLRUClientSessionCache(64),
	}
	if err := id.load(spec.Chain, spec.Key); err != nil {
		return nil, err
	}
	maxConns := spec.MaxConns
	if maxConns <= 0 && spec.Key != "" {
		maxConns = 6
	}
	if maxConns <= 0 {
		maxConns = 2
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
		Director:      directIntercepted,
		Transport:     id.transport,
		FlushInterval: -1,
		ErrorHandler:  id.fail,
		ErrorLog:      quiet,
	}
	return id, nil
}

// load sets the certificate (chain: Base64 DER, leaf first) and the key in memory (key: Base64
// PKCS#8), from the session's message or from a "prepare" reply. An empty chain keeps the
// certificate the identity has; an empty key keeps a remote key remote.
func (id *identity) load(chain []string, key string) error {
	id.mu.Lock()
	defer id.mu.Unlock()
	ders, leaf := id.chain, id.leaf
	if len(chain) > 0 {
		ders = make([][]byte, 0, len(chain))
		for _, c := range chain {
			der, err := base64.StdEncoding.DecodeString(c)
			if err != nil {
				return fmt.Errorf("bad certificate: %w", err)
			}
			ders = append(ders, der)
		}
		parsed, err := x509.ParseCertificate(ders[0])
		if err != nil {
			return fmt.Errorf("bad certificate: %w", err)
		}
		leaf = parsed
	}
	signer := id.signer
	if key != "" {
		der, err := base64.StdEncoding.DecodeString(key)
		if err != nil {
			return errors.New("bad key")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(der)
		if err != nil {
			return errors.New("bad key")
		}
		s, ok := parsed.(crypto.Signer)
		if !ok || leaf == nil || !samePublicKey(s.Public(), leaf.PublicKey) {
			return errors.New("the key doesn't match the certificate")
		}
		signer = s
	}
	if leaf != nil && signer == nil {
		if _, ok := leaf.PublicKey.(*rsa.PublicKey); !ok {
			return errors.New("remote keys must be RSA")
		}
	}
	id.chain, id.leaf, id.signer = ders, leaf, signer
	return nil
}

// current is the certificate and the key in memory, as the last "prepare" reply left them.
func (id *identity) current() (chain [][]byte, leaf *x509.Certificate, signer crypto.Signer) {
	id.mu.Lock()
	defer id.mu.Unlock()
	return id.chain, id.leaf, id.signer
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
	writeCertError(w, id.p.language(), hostname, ce)
}

func (id *identity) lock(addr string) *sync.Mutex {
	l, _ := id.locks.LoadOrStore(addr, &sync.Mutex{})
	return l.(*sync.Mutex)
}

// dialTLS opens an upstream connection with the client certificate. Without the key in memory
// (a remote key, or a lazy identity that has none yet), the app prepares it first when the host
// asks for a certificate in its handshake (probe.go): the user may have to approve, on the phone
// or in the app. That is outside any handshake, so slow approvals never hit a server's handshake
// timeout. A host that doesn't ask costs the user nothing.
func (id *identity) dialTLS(ctx context.Context, _, addr string) (net.Conn, error) {
	hostname, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	signed := false
	var key *remoteKey
	if _, _, signer := id.current(); signer == nil {
		key = &remoteKey{id: id, ctx: ctx, host: hostname, signed: &signed}
		if id.p.asksForCertificate(ctx, addr) {
			if err := id.prepare(ctx, hostname); err != nil {
				return nil, err
			}
			key.prepared = true
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
	config := &tls.Config{
		ServerName:         hostname,
		RootCAs:            id.p.roots,
		InsecureSkipVerify: id.p.insecure,
		MinVersion:         tls.VersionTLS12,
		CipherSuites:       upstreamCipherSuites,
		Renegotiation:      tls.RenegotiateOnceAsClient,
		ClientSessionCache: id.cache,
		NextProtos:         []string{"http/1.1"},
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			return id.certificate(key, &signed)
		},
	}
	if _, _, signer := id.current(); signer == nil {
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

// prepare asks the app to get the key ready for a connection to hostname. The reply of a lazy
// identity carries its certificate, and its key when the sidecar keeps it in memory.
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
	if err := id.load(reply.Chain, reply.Key); err != nil {
		return &certError{code: "failed", detail: err.Error()}
	}
	if _, leaf, _ := id.current(); leaf == nil {
		return &certError{code: "unavailable", detail: "the app sent no certificate"}
	}
	return nil
}

// certificate is the client certificate for one connection, when the server asks for it. key is
// the connection's remote key (nil when the key was in memory at the dial). The app prepares the
// key here, inside the handshake, when it didn't before the dial: the probe didn't see this host
// ask, or the server asks in a renegotiation and the identity has no certificate yet.
func (id *identity) certificate(key *remoteKey, signed *bool) (*tls.Certificate, error) {
	chain, leaf, signer := id.current()
	if signer == nil && key != nil && (leaf == nil || (key.lock == nil && !key.prepared)) {
		if err := id.prepare(key.ctx, key.host); err != nil {
			return nil, err
		}
		key.prepared = true
		chain, leaf, signer = id.current()
	}
	cert := &tls.Certificate{Certificate: chain, Leaf: leaf}
	if signer != nil {
		cert.PrivateKey = &localKey{Signer: signer, signed: signed}
		return cert, nil
	}
	if key == nil || leaf == nil {
		return nil, &certError{code: "unavailable", detail: "the certificate has no key"}
	}
	key.leaf = leaf
	cert.PrivateKey = key
	cert.SupportedSignatureAlgorithms = pkcs1Schemes
	return cert, nil
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
	// leaf is the certificate the connection presented with this key.
	leaf *x509.Certificate
	// prepared: the app prepared the key for this connection's first handshake.
	prepared bool
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

func (k *remoteKey) Public() crypto.PublicKey { return k.leaf.PublicKey }

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
	pub := k.leaf.PublicKey.(*rsa.PublicKey)
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
