package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

const password = "test-password-0123456789"

// --- Fixtures ---------------------------------------------------------------------------------

type issued struct {
	der  []byte
	cert *x509.Certificate
	key  crypto.Signer
}

func newCA(t *testing.T) issued {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return issued{der, cert, key}
}

func newClient(t *testing.T, ca issued, cn string, key crypto.Signer) issued {
	t.Helper()
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, key.Public(), ca.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return issued{der, cert, key}
}

func rsaKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func pkcs8(t *testing.T, key crypto.Signer) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(der)
}

func b64(der []byte) string { return base64.StdEncoding.EncodeToString(der) }

// upstream is a site that asks for a client certificate and reports what it got.
type upstream struct {
	*httptest.Server
	target string
	roots  string
}

type seen struct {
	CN      string `json:"cn"`
	Version uint16 `json:"version"`
	Host    string `json:"host"`
	XFF     string `json:"xff"`
}

func newUpstream(t *testing.T, maxVersion uint16) *upstream {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := seen{Version: r.TLS.Version, Host: r.Host, XFF: r.Header.Get("X-Forwarded-For")}
		if len(r.TLS.PeerCertificates) > 0 {
			s.CN = r.TLS.PeerCertificates[0].Subject.CommonName
		}
		_ = json.NewEncoder(w).Encode(s)
	}))
	srv.TLS = &tls.Config{ClientAuth: tls.RequestClientCert, MaxVersion: maxVersion}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	roots := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	return &upstream{Server: srv, target: strings.TrimPrefix(srv.URL, "https://"), roots: string(roots)}
}

// fakeDesktop answers prepare/sign calls and records everything.
type fakeDesktop struct {
	mu      sync.Mutex
	sent    []outMessage
	prepare func(m outMessage) inMessage
	sign    func(m outMessage) inMessage
}

func (d *fakeDesktop) send(m outMessage) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sent = append(d.sent, m)
}

func (d *fakeDesktop) call(ctx context.Context, m outMessage) (inMessage, error) {
	d.send(m)
	if err := ctx.Err(); err != nil {
		return inMessage{}, err
	}
	switch m.Method {
	case "prepare":
		if d.prepare != nil {
			return d.prepare(m), nil
		}
		return inMessage{}, nil
	case "sign":
		return d.sign(m), nil
	}
	return inMessage{Error: "failed"}, nil
}

func (d *fakeDesktop) count(match func(outMessage) bool) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for _, m := range d.sent {
		if match(m) {
			n++
		}
	}
	return n
}

func (d *fakeDesktop) last(match func(outMessage) bool) (outMessage, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := len(d.sent) - 1; i >= 0; i-- {
		if match(d.sent[i]) {
			return d.sent[i], true
		}
	}
	return outMessage{}, false
}

func signWith(key *rsa.PrivateKey) func(outMessage) inMessage {
	return func(m outMessage) inMessage {
		digest, _ := base64.StdEncoding.DecodeString(m.Digest)
		hash := map[string]crypto.Hash{"SHA-1": crypto.SHA1, "SHA-256": crypto.SHA256, "SHA-384": crypto.SHA384, "SHA-512": crypto.SHA512}[m.Hash]
		sig, err := rsa.SignPKCS1v15(rand.Reader, key, hash, digest)
		if err != nil {
			return inMessage{Error: "failed", Message: err.Error()}
		}
		return inMessage{Signature: b64(sig)}
	}
}

type harness struct {
	t    *testing.T
	p    *proxy
	desk *fakeDesktop
}

func newHarness(t *testing.T, roots ...string) *harness {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	desk := &fakeDesktop{}
	p, err := newProxy(inMessage{Type: "config", Password: password, Key: pkcs8(t, key), Roots: roots}, desk)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, p: p, desk: desk}
	t.Cleanup(func() {
		for _, id := range []string{"s1", "s2"} {
			p.endSession(id)
		}
		p.mitm.Close()
	})
	return h
}

// addr opens (or returns) a session's proxy port.
func (h *harness) addr(session string) string {
	h.t.Helper()
	if port := h.p.session(session).port(); port != 0 {
		return fmt.Sprintf("127.0.0.1:%d", port)
	}
	h.p.configure(inMessage{Type: "session", ID: 1, Session: session})
	ack, ok := h.desk.last(func(m outMessage) bool { return m.Type == "ack" })
	if !ok || ack.Error != "" || ack.Port == 0 {
		h.t.Fatalf("no session port: %+v", ack)
	}
	return fmt.Sprintf("127.0.0.1:%d", ack.Port)
}

// client is a browser in `session`; it records the SPKI of the certificate it was shown.
type client struct {
	*http.Client
	transport *http.Transport
	mu        sync.Mutex
	spkis     []string
}

func (h *harness) client(session, pass string) *client {
	c := &client{}
	proxyURL := &url.URL{Scheme: "http", Host: h.addr(session), User: url.UserPassword("sa", pass)}
	c.transport = &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
			VerifyConnection: func(cs tls.ConnectionState) error {
				sum := sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
				c.mu.Lock()
				c.spkis = append(c.spkis, base64.StdEncoding.EncodeToString(sum[:]))
				c.mu.Unlock()
				return nil
			},
		},
	}
	c.Client = &http.Client{Transport: c.transport, Timeout: 20 * time.Second}
	return c
}

func (c *client) lastSPKI() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.spkis) == 0 {
		return ""
	}
	return c.spkis[len(c.spkis)-1]
}

func (c *client) fetch(t *testing.T, u string) (*http.Response, seen, string) {
	t.Helper()
	resp, err := c.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var s seen
	_ = json.Unmarshal(body, &s)
	return resp, s, string(body)
}

func (h *harness) configure(t *testing.T, session string, hosts []string, spec *identitySpec) {
	t.Helper()
	h.p.configure(inMessage{Type: "session", ID: 7, Session: session, Hosts: hosts, Identity: spec})
	ack, ok := h.desk.last(func(m outMessage) bool { return m.Type == "ack" })
	if !ok || ack.Error != "" {
		t.Fatalf("configure failed: %+v", ack)
	}
}

func spkiOf(der []byte) string {
	cert, _ := x509.ParseCertificate(der)
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return base64.StdEncoding.EncodeToString(sum[:])
}

func isHandshake(m outMessage) bool { return m.Type == "event" && m.Event == "handshake" }

// --- Tests ------------------------------------------------------------------------------------

func TestTunnelsByDefault(t *testing.T) {
	up := newUpstream(t, 0)
	h := newHarness(t, up.roots)
	c := h.client("s1", password)
	resp, s, _ := c.fetch(t, up.URL+"/")
	if resp.StatusCode != 200 || s.CN != "" {
		t.Fatalf("got %d %+v", resp.StatusCode, s)
	}
	if c.lastSPKI() != spkiOf(up.Certificate().Raw) {
		t.Fatal("the browser should see the site's own certificate")
	}
}

func TestRequiresThePassword(t *testing.T) {
	up := newUpstream(t, 0)
	h := newHarness(t, up.roots)
	for _, pass := range []string{"", "wrong-password-0123456789"} {
		_, err := h.client("s1", pass).Get(up.URL + "/")
		if err == nil || !strings.Contains(err.Error(), "Proxy Authentication Required") {
			t.Fatalf("pass %q: expected a 407, got %v", pass, err)
		}
	}
	conn, _ := net.Dial("tcp", h.addr("s1"))
	defer conn.Close()
	_, _ = conn.Write([]byte("CONNECT " + up.target + " HTTP/1.1\r\nHost: " + up.target + "\r\n\r\n"))
	line := make([]byte, 64)
	n, _ := conn.Read(line)
	if !strings.Contains(string(line[:n]), "407") {
		t.Fatalf("expected 407, got %q", line[:n])
	}
}

func TestLocalKeyIsPresentedOnlyToEnabledHosts(t *testing.T) {
	up := newUpstream(t, 0)
	h := newHarness(t, up.roots)
	ca := newCA(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := newClient(t, ca, "PRUEBA EC", key)
	h.configure(t, "s1", []string{up.target}, &identitySpec{ID: "cert-1", Chain: []string{b64(cert.der)}, Key: pkcs8(t, key)})

	c := h.client("s1", password)
	for i := 0; i < 3; i++ {
		resp, s, body := c.fetch(t, up.URL+"/")
		if resp.StatusCode != 200 || s.CN != "PRUEBA EC" {
			t.Fatalf("got %d %s", resp.StatusCode, body)
		}
		if s.XFF != "" {
			t.Fatalf("X-Forwarded-For leaked: %q", s.XFF)
		}
	}
	if c.lastSPKI() != h.p.spki {
		t.Fatal("the browser should see the sidecar's pinned key")
	}
	if n := h.desk.count(isHandshake); n != 1 {
		t.Fatalf("upstream handshakes: %d, want 1 (connection reuse)", n)
	}

	// Another session (another browser context) isn't intercepted.
	other := h.client("s2", password)
	_, s, _ := other.fetch(t, up.URL+"/")
	if s.CN != "" || other.lastSPKI() != spkiOf(up.Certificate().Raw) {
		t.Fatalf("session s2 was intercepted: %+v", s)
	}
}

func TestRemoteKeySignsOverTLS12(t *testing.T) {
	up := newUpstream(t, 0) // offers TLS 1.3
	h := newHarness(t, up.roots)
	ca := newCA(t)
	key := rsaKey(t)
	cert := newClient(t, ca, "PRUEBA DNIE", key)
	h.desk.sign = signWith(key)
	h.configure(t, "s1", []string{up.target}, &identitySpec{ID: "dnie-1", Chain: []string{b64(cert.der)}})

	c := h.client("s1", password)
	resp, s, body := c.fetch(t, up.URL+"/")
	if resp.StatusCode != 200 || s.CN != "PRUEBA DNIE" || s.Version != tls.VersionTLS12 {
		t.Fatalf("got %d %s", resp.StatusCode, body)
	}
	if n := h.desk.count(func(m outMessage) bool { return m.Method == "prepare" }); n != 1 {
		t.Fatalf("prepare calls: %d", n)
	}
	sign, ok := h.desk.last(func(m outMessage) bool { return m.Method == "sign" })
	if !ok || sign.Identity != "dnie-1" || sign.Session != "s1" || sign.Host != "127.0.0.1" {
		t.Fatalf("sign call: %+v", sign)
	}
	if hs, _ := h.desk.last(isHandshake); !hs.Signed {
		t.Fatal("the handshake should report a signature")
	}
}

func TestDeclinedLoginShowsAnErrorPage(t *testing.T) {
	up := newUpstream(t, 0)
	h := newHarness(t, up.roots)
	ca := newCA(t)
	key := rsaKey(t)
	cert := newClient(t, ca, "PRUEBA DNIE", key)
	h.desk.prepare = func(outMessage) inMessage { return inMessage{Error: "declined", Message: "the user said no"} }
	h.configure(t, "s1", []string{up.target}, &identitySpec{ID: "dnie-1", Chain: []string{b64(cert.der)}})

	resp, _, body := h.client("s1", password).fetch(t, up.URL+"/")
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Sa-Certificate-Error") != "declined" {
		t.Fatalf("got %d %q", resp.StatusCode, resp.Header.Get("X-Sa-Certificate-Error"))
	}
	if !strings.Contains(body, "No se ha aprobado") || !strings.Contains(body, "the user said no") {
		t.Fatalf("body: %s", body)
	}
	if n := h.desk.count(func(m outMessage) bool { return m.Method == "sign" }); n != 0 {
		t.Fatal("nothing should be signed")
	}
}

func TestSignatureFromAnotherKeyFails(t *testing.T) {
	up := newUpstream(t, 0)
	h := newHarness(t, up.roots)
	ca := newCA(t)
	cert := newClient(t, ca, "PRUEBA DNIE", rsaKey(t))
	h.desk.sign = signWith(rsaKey(t)) // another card
	h.configure(t, "s1", []string{up.target}, &identitySpec{ID: "dnie-1", Chain: []string{b64(cert.der)}})

	resp, _, body := h.client("s1", password).fetch(t, up.URL+"/")
	if resp.Header.Get("X-Sa-Certificate-Error") != "failed" || !strings.Contains(body, "doesn&#39;t match") {
		t.Fatalf("got %d %q %s", resp.StatusCode, resp.Header.Get("X-Sa-Certificate-Error"), body)
	}
}

// Go's TLS server can't renegotiate, so this drives the key the way a renegotiation on a pooled
// connection does: after the request that dialed has ended.
func TestRemoteKeySignsRenegotiationsAfterTheDial(t *testing.T) {
	h := newHarness(t)
	ca := newCA(t)
	key := rsaKey(t)
	cert := newClient(t, ca, "PRUEBA DNIE", key)
	h.desk.sign = signWith(key)
	id, err := h.p.newIdentity("s1", identitySpec{ID: "dnie-1", Chain: []string{b64(cert.der)}})
	if err != nil {
		t.Fatal(err)
	}
	dial, endRequest := context.WithCancel(context.Background())
	signed := false
	_, remote := id.certificate(dial, "sede.example", &signed)
	closeConn := remote.renegotiation(id.lock("sede.example:443"))
	endRequest()

	digest := sha256.Sum256([]byte("handshake"))
	if _, err := remote.Sign(rand.Reader, digest[:], crypto.SHA256); err != nil {
		t.Fatalf("renegotiation signature: %v", err)
	}
	var methods []string
	for _, m := range h.desk.sent {
		if m.Method != "" {
			methods = append(methods, m.Method)
		}
	}
	if strings.Join(methods, ",") != "prepare,sign" {
		t.Fatalf("calls: %v", methods)
	}
	h.desk.prepare = func(outMessage) inMessage { return inMessage{Error: "declined"} }
	if _, err := remote.Sign(rand.Reader, digest[:], crypto.SHA256); err == nil || classify(err).code != "declined" {
		t.Fatalf("a declined approval should stop the signature: %v", err)
	}
	h.desk.prepare = nil
	closeConn()
	if _, err := remote.Sign(rand.Reader, digest[:], crypto.SHA256); err == nil {
		t.Fatal("a closed connection should not sign")
	}
}

func TestEndedSessionsStayEnded(t *testing.T) {
	h := newHarness(t)
	h.addr("s1")
	h.p.endSession("s1")
	mc := &mitmConn{session: "s1", target: "sede.example:443"}
	req := httptest.NewRequest("GET", "https://sede.example/", nil)
	req = req.WithContext(context.WithValue(req.Context(), mitmKey{}, mc))
	rec := httptest.NewRecorder()
	h.p.handleIntercepted(rec, req)
	if rec.Header().Get("X-Sa-Certificate-Error") != "unavailable" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("X-Sa-Certificate-Error"))
	}
	if h.p.lookup("s1") != nil {
		t.Fatal("the ended session came back")
	}
}

func TestEnablingAHostClosesItsTunnels(t *testing.T) {
	up := newUpstream(t, 0)
	h := newHarness(t, up.roots)
	c := h.client("s1", password)
	if _, s, _ := c.fetch(t, up.URL+"/"); s.CN != "" {
		t.Fatal("expected a tunnel first")
	}
	ca := newCA(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := newClient(t, ca, "PRUEBA EC", key)
	h.configure(t, "s1", []string{up.target}, &identitySpec{ID: "cert-1", Chain: []string{b64(cert.der)}, Key: pkcs8(t, key)})
	// The kept-alive tunnel was closed: the next request goes through a new, intercepted one.
	time.Sleep(50 * time.Millisecond)
	if _, s, _ := c.fetch(t, up.URL+"/"); s.CN != "PRUEBA EC" {
		t.Fatalf("expected the certificate after enabling it, got %+v", s)
	}
	// Disabling it closes the intercepted connection again.
	h.configure(t, "s1", nil, nil)
	time.Sleep(50 * time.Millisecond)
	if _, s, _ := c.fetch(t, up.URL+"/"); s.CN != "" {
		t.Fatalf("expected a tunnel after disabling, got %+v", s)
	}
}

func TestMisdirectedHostIsRefused(t *testing.T) {
	up := newUpstream(t, 0)
	h := newHarness(t, up.roots)
	ca := newCA(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := newClient(t, ca, "PRUEBA EC", key)
	h.configure(t, "s1", []string{up.target}, &identitySpec{ID: "cert-1", Chain: []string{b64(cert.der)}, Key: pkcs8(t, key)})
	req, _ := http.NewRequest("GET", up.URL+"/", nil)
	req.Host = "evil.example"
	resp, err := h.client("s1", password).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("got %d", resp.StatusCode)
	}
}

func TestInvalidServerCertificateIsReported(t *testing.T) {
	up := newUpstream(t, 0)
	ca := newCA(t)
	// Trust an unrelated CA only (httptest servers all share one certificate).
	h := newHarness(t, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.der})))
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := newClient(t, ca, "PRUEBA EC", key)
	h.configure(t, "s1", []string{up.target}, &identitySpec{ID: "cert-1", Chain: []string{b64(cert.der)}, Key: pkcs8(t, key)})
	resp, _, _ := h.client("s1", password).fetch(t, up.URL+"/")
	if resp.Header.Get("X-Sa-Certificate-Error") != "server_certificate" {
		t.Fatalf("got %d %q", resp.StatusCode, resp.Header.Get("X-Sa-Certificate-Error"))
	}
}

func TestBadIdentitiesAreRejected(t *testing.T) {
	h := newHarness(t)
	ca := newCA(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cert := newClient(t, ca, "PRUEBA EC", key)
	otherKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	for name, spec := range map[string]identitySpec{
		"mismatched key": {ID: "c", Chain: []string{b64(cert.der)}, Key: pkcs8(t, otherKey)},
		"remote EC key":  {ID: "c", Chain: []string{b64(cert.der)}},
		"no chain":       {ID: "c"},
	} {
		spec := spec
		h.p.configure(inMessage{Type: "session", ID: 9, Session: "s1", Hosts: []string{"a.example:443"}, Identity: &spec})
		ack, _ := h.desk.last(func(m outMessage) bool { return m.Type == "ack" })
		if ack.Error == "" {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

func TestUnreachableSitesSayWhy(t *testing.T) {
	h := newHarness(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().String()
	ln.Close()

	// https: the CONNECT fails, and the app hears why.
	if _, err := h.client("s1", password).Get("https://" + dead + "/"); err == nil {
		t.Fatal("expected the tunnel to fail")
	}
	ev, ok := h.desk.last(func(m outMessage) bool { return m.Event == "tunnel_error" })
	if !ok || ev.Code != "ERR_CONNECTION_REFUSED" || ev.Host != dead || ev.Session != "s1" {
		t.Fatalf("event: %+v", ev)
	}
	// http: the answer carries the reason.
	resp, err := h.client("s1", password).Get("http://" + dead + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Sa-Network-Error") != "ERR_CONNECTION_REFUSED" {
		t.Fatalf("got %d %q", resp.StatusCode, resp.Header.Get("X-Sa-Network-Error"))
	}
}

func TestEachSessionHasItsOwnPort(t *testing.T) {
	h := newHarness(t)
	a, b := h.addr("s1"), h.addr("s2")
	if a == b || h.addr("s1") != a {
		t.Fatalf("ports: %s %s", a, b)
	}
	h.p.endSession("s1")
	if conn, err := net.DialTimeout("tcp", a, time.Second); err == nil {
		conn.Close()
		t.Fatal("an ended session's port should be closed")
	}
}

func TestReadMessageHandlesLongLines(t *testing.T) {
	long := strings.Repeat("A", 100_000)
	r := bufio.NewReaderSize(bytes.NewBufferString(`{"type":"reply","id":3,"signature":"`+long+"\"}\n"), 4096)
	m, err := readMessage(r)
	if err != nil || m.Signature != long || m.ID != 3 {
		t.Fatalf("got %v", err)
	}
}

func TestLoopbackOnly(t *testing.T) {
	if _, err := loopback("0.0.0.0:8080"); err == nil {
		t.Fatal("0.0.0.0 must be refused")
	}
	if addr, err := loopback(""); err != nil || addr != "127.0.0.1:0" {
		t.Fatal("default must be loopback")
	}
}
