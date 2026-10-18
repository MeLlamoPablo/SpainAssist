package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"time"
)

var quiet = log.New(io.Discard, "", 0)

type proxy struct {
	desk     desktop
	password string
	// key signs the per-host certificates the browser sees for intercepted hosts.
	key  crypto.Signer
	spki string
	// roots verifies upstream servers: nil is the platform's verifier.
	roots    *x509.CertPool
	insecure bool
	dialer   net.Dialer

	leaves sync.Map // hostname → *tls.Certificate

	mu       sync.Mutex
	sessions map[string]*session

	mitm  *connListener
	plain *httputil.ReverseProxy
}

func newProxy(cfg inMessage, desk desktop) (*proxy, error) {
	if len(cfg.Password) < 16 {
		return nil, errors.New("the proxy password is too short")
	}
	der, err := base64.StdEncoding.DecodeString(cfg.Key)
	if err != nil {
		return nil, fmt.Errorf("bad proxy key: %w", err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("bad proxy key: %w", err)
	}
	key, ok := parsed.(crypto.Signer)
	if !ok {
		return nil, errors.New("the proxy key can't sign")
	}
	spki, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(spki)

	p := &proxy{
		desk:     desk,
		password: cfg.Password,
		key:      key,
		spki:     base64.StdEncoding.EncodeToString(sum[:]),
		insecure: cfg.InsecureUpstream,
		dialer:   net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second},
		sessions: map[string]*session{},
		mitm:     newConnListener(),
	}
	if len(cfg.Roots) > 0 {
		p.roots = x509.NewCertPool()
		for _, pem := range cfg.Roots {
			if !p.roots.AppendCertsFromPEM([]byte(pem)) {
				return nil, errors.New("bad root certificate")
			}
		}
	}
	p.plain = &httputil.ReverseProxy{
		Director: forwardHeaders,
		Transport: &http.Transport{
			DialContext:         p.dialer.DialContext,
			MaxIdleConnsPerHost: 6,
			IdleConnTimeout:     90 * time.Second,
			DisableCompression:  true,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() == nil {
				writeNetworkError(w, netErrorCode(err))
			}
		},
		ErrorLog: quiet,
	}
	intercepted := &http.Server{
		Handler:           http.HandlerFunc(p.handleIntercepted),
		ConnContext:       mitmContext,
		ReadHeaderTimeout: 2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          quiet,
	}
	go func() { _ = intercepted.Serve(p.mitm) }()
	return p, nil
}

// listen opens a session's own proxy port. Each browser context gets one, so the port says
// which session a connection belongs to; every request still needs the per-launch password.
func (p *proxy) listen(s *session, addr string) (int, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return 0, err
	}
	server := &http.Server{
		Handler:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { p.serveSession(w, r, s) }),
		ReadHeaderTimeout: 30 * time.Second,
		ErrorLog:          quiet,
	}
	s.setServer(server, ln)
	go func() { _ = server.Serve(ln) }()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

// serveSession handles requests to a session's proxy port: CONNECT tunnels, and plain http://
// requests.
func (p *proxy) serveSession(w http.ResponseWriter, r *http.Request, s *session) {
	if !p.authorize(r) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="SpainAssist"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	switch {
	case r.Method == http.MethodConnect:
		p.connect(w, r, s)
	case r.URL.IsAbs() && r.URL.Scheme == "http":
		p.plain.ServeHTTP(w, r)
	default:
		http.Error(w, "not a proxy request", http.StatusBadRequest)
	}
}

// authorize checks the per-launch password (Basic, any username).
func (p *proxy) authorize(r *http.Request) bool {
	const prefix = "Basic "
	auth := r.Header.Get("Proxy-Authorization")
	if !strings.HasPrefix(auth, prefix) {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(auth[len(prefix):])
	if err != nil {
		return false
	}
	_, password, ok := strings.Cut(string(raw), ":")
	return ok && subtle.ConstantTimeCompare([]byte(password), []byte(p.password)) == 1
}

func (p *proxy) connect(w http.ResponseWriter, r *http.Request, s *session) {
	target, err := canonicalTarget(r.Host)
	if err != nil {
		http.Error(w, "bad CONNECT target", http.StatusBadRequest)
		return
	}
	intercept := s.intercepts(target)
	var upstream net.Conn
	if !intercept {
		// Dial before answering, so a site that is down fails the CONNECT and the app can tell
		// the browser why (Chromium itself only reports a failed tunnel).
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		upstream, err = p.dialer.DialContext(ctx, "tcp", target)
		cancel()
		if err != nil {
			code := netErrorCode(err)
			p.desk.send(outMessage{
				Type: "event", Event: "tunnel_error", Session: s.id, Host: target, Code: code,
				Message: err.Error(),
			})
			writeNetworkError(w, code)
			return
		}
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "can't tunnel", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		if upstream != nil {
			upstream.Close()
		}
		return
	}
	if _, err := conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		conn.Close()
		if upstream != nil {
			upstream.Close()
		}
		return
	}
	client := conn
	if n := rw.Reader.Buffered(); n > 0 {
		early, _ := rw.Reader.Peek(n)
		client = &prefixConn{Conn: conn, prefix: append([]byte(nil), early...)}
	}
	if intercept {
		p.intercept(client, s, target)
	} else {
		p.tunnel(client, upstream, s, target)
	}
}

// tunnel copies bytes both ways: Chromium does TLS with the real host and checks its certificate.
func (p *proxy) tunnel(client, upstream net.Conn, s *session, target string) {
	untrack := s.track(target, false, client, upstream)
	defer untrack()
	errc := make(chan error, 2)
	go func() { _, err := io.Copy(upstream, client); errc <- err }()
	go func() { _, err := io.Copy(client, upstream); errc <- err }()
	<-errc
	client.Close()
	upstream.Close()
	<-errc
}

// intercept finishes TLS with the browser and hands the connection to the intercepted server.
func (p *proxy) intercept(client net.Conn, s *session, target string) {
	hostname, _, _ := net.SplitHostPort(target)
	tlsConn := tls.Server(client, &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return p.leaf(hostname)
		},
	})
	mc := &mitmConn{Conn: tlsConn, session: s.id, target: target}
	mc.untrack = s.track(target, true, mc)
	p.mitm.push(mc)
}

// leaf is the certificate the browser sees for an intercepted host: signed by the per-launch
// key, whose SPKI Chromium trusts. Valid for this host only.
func (p *proxy) leaf(hostname string) (*tls.Certificate, error) {
	if cert, ok := p.leaves.Load(hostname); ok {
		return cert.(*tls.Certificate), nil
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: hostname},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(7 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(hostname); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{hostname}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, p.key.Public(), p.key)
	if err != nil {
		return nil, err
	}
	cert := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: p.key}
	actual, _ := p.leaves.LoadOrStore(hostname, cert)
	return actual.(*tls.Certificate), nil
}

// handleIntercepted serves one request from the browser on an intercepted connection.
func (p *proxy) handleIntercepted(w http.ResponseWriter, r *http.Request) {
	mc, _ := r.Context().Value(mitmKey{}).(*mitmConn)
	if mc == nil {
		http.Error(w, "no connection", http.StatusInternalServerError)
		return
	}
	hostname, port, _ := net.SplitHostPort(mc.target)
	if !sameHost(r.Host, hostname, port) {
		http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
		return
	}
	// A session that ended while the request was in flight stays ended.
	var id *identity
	if s := p.lookup(mc.session); s != nil {
		id = s.identityFor(mc.target)
	}
	if id == nil {
		writeCertError(w, hostname, &certError{code: "unavailable", detail: "the certificate is no longer enabled for this site"})
		return
	}
	id.proxy.ServeHTTP(w, r)
}

func (p *proxy) lookup(id string) *session {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[id]
}

// session returns a session, creating it: only configure opens sessions.
func (p *proxy) session(id string) *session {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.sessions[id]
	if s == nil {
		s = newSession(id)
		p.sessions[id] = s
	}
	return s
}

// configure opens a session's port (on the first message) and sets which hosts it intercepts
// and with which certificate. The ack carries the port.
func (p *proxy) configure(m inMessage) {
	if m.Session == "" {
		p.desk.send(outMessage{Type: "ack", ID: m.ID, Error: "no session"})
		return
	}
	s := p.session(m.Session)
	port := s.port()
	if port == 0 {
		addr, err := loopback(m.Listen)
		if err == nil {
			port, err = p.listen(s, addr)
		}
		if err != nil {
			p.desk.send(outMessage{Type: "ack", ID: m.ID, Error: err.Error()})
			return
		}
	}
	var hosts []string
	for _, h := range m.Hosts {
		target, err := canonicalTarget(h)
		if err != nil {
			p.desk.send(outMessage{Type: "ack", ID: m.ID, Port: port, Error: fmt.Sprintf("bad host %q", h)})
			return
		}
		hosts = append(hosts, target)
	}
	var next *identity
	if m.Identity != nil && len(hosts) > 0 {
		current := s.current()
		if current != nil && current.same(*m.Identity) {
			next = current
		} else {
			id, err := p.newIdentity(m.Session, *m.Identity)
			if err != nil {
				p.desk.send(outMessage{Type: "ack", ID: m.ID, Port: port, Error: err.Error()})
				return
			}
			next = id
		}
	}
	if old := s.set(hosts, next); old != nil && old != next {
		old.close()
	}
	p.desk.send(outMessage{Type: "ack", ID: m.ID, Port: port})
}

func (p *proxy) endSession(id string) {
	p.mu.Lock()
	s := p.sessions[id]
	delete(p.sessions, id)
	p.mu.Unlock()
	if s != nil {
		if old := s.set(nil, nil); old != nil {
			old.close()
		}
		s.closeServer()
		s.closeAll()
	}
}

// forwardHeaders keeps the request as the browser sent it: no X-Forwarded-For, no Go user agent.
func forwardHeaders(r *http.Request) {
	r.Header["X-Forwarded-For"] = nil
	if _, ok := r.Header["User-Agent"]; !ok {
		r.Header.Set("User-Agent", "")
	}
}

// canonicalTarget is "host:port" in lower case, port 443 by default.
func canonicalTarget(h string) (string, error) {
	host, port, err := net.SplitHostPort(h)
	if err != nil {
		host, port = h, "443"
	}
	host = strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if host == "" || port == "" || strings.ContainsAny(host, "/@ ") {
		return "", fmt.Errorf("bad host %q", h)
	}
	return net.JoinHostPort(host, port), nil
}

func sameHost(requestHost, hostname, port string) bool {
	h, p, err := net.SplitHostPort(requestHost)
	if err != nil {
		h, p = requestHost, "443"
	}
	return strings.EqualFold(strings.TrimSuffix(strings.Trim(h, "[]"), "."), hostname) && p == port
}

// --- Plumbing ---------------------------------------------------------------------------------

// prefixConn replays bytes the HTTP server had already buffered before the hijack.
type prefixConn struct {
	net.Conn
	prefix []byte
}

func (c *prefixConn) Read(b []byte) (int, error) {
	if len(c.prefix) > 0 {
		n := copy(b, c.prefix)
		c.prefix = c.prefix[n:]
		return n, nil
	}
	return c.Conn.Read(b)
}

type mitmKey struct{}

// mitmConn is an intercepted browser connection and where it was going.
type mitmConn struct {
	net.Conn
	session string
	target  string
	untrack func()
	once    sync.Once
}

func (c *mitmConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		if c.untrack != nil {
			c.untrack()
		}
	})
	return err
}

func mitmContext(ctx context.Context, c net.Conn) context.Context {
	if mc, ok := c.(*mitmConn); ok {
		return context.WithValue(ctx, mitmKey{}, mc)
	}
	return ctx
}

// connListener hands intercepted connections to an http.Server.
type connListener struct {
	ch   chan net.Conn
	done chan struct{}
	once sync.Once
}

func newConnListener() *connListener {
	return &connListener{ch: make(chan net.Conn), done: make(chan struct{})}
}

func (l *connListener) push(c net.Conn) {
	select {
	case l.ch <- c:
	case <-l.done:
		c.Close()
	}
}

func (l *connListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.ch:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *connListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *connListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)} }
