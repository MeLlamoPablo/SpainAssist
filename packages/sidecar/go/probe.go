package main

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"sync"
	"time"
)

// Chromium must never see a client certificate request. Headed Chromium answers one with its
// own picker of the certificates in the OS store (Windows, macOS): the agent can't see or answer
// it, and the tab ignores clicks while it is open. So the first time a host is tunnelled, the
// sidecar checks whether it asks for a certificate during the handshake. Hosts that do are
// always intercepted: with the session's certificate when it is enabled for them, otherwise with
// none ("anonymous").
//
// A certificate asked for later, in a TLS 1.2 renegotiation, is not seen: none of the
// government hosts we know does that (docs/research/browser.md §1.8).

const probeTimeout = 5 * time.Second

// errProbed ends a probe's handshake: the server asked for a certificate, nothing more to learn.
var errProbed = errors.New("the server asked for a client certificate")

type probe struct {
	done chan struct{}
	asks bool
}

// asksForCertificate says whether a host asks for a client certificate during the handshake.
// Hosts are probed once per launch; concurrent connections wait for the same probe. Unknown
// (a probe that failed, or ctx ended first) is false: the connection is tunnelled as before.
func (p *proxy) asksForCertificate(ctx context.Context, target string) bool {
	p.probeMu.Lock()
	pr := p.probes[target]
	first := pr == nil
	if first {
		pr = &probe{done: make(chan struct{})}
		p.probes[target] = pr
	}
	p.probeMu.Unlock()
	if first {
		// Not tied to ctx: the answer is kept for the next connections even if this one is gone.
		asks, known := p.probe(target)
		pr.asks = asks
		if !known {
			p.probeMu.Lock()
			delete(p.probes, target)
			p.probeMu.Unlock()
		}
		close(pr.done)
	}
	select {
	case <-pr.done:
		return pr.asks
	case <-ctx.Done():
		return false
	}
}

// probe does a handshake of its own with the host and stops at a certificate request. known is
// false when the host couldn't be reached: the next connection asks again.
func (p *proxy) probe(target string) (asks, known bool) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	raw, err := p.dialer.DialContext(ctx, "tcp", target)
	if err != nil {
		return false, false
	}
	defer raw.Close()
	hostname, _, _ := net.SplitHostPort(target)
	asked := false
	conn := tls.Client(raw, &tls.Config{
		ServerName: hostname,
		// Nothing is sent over this connection: the browser checks the site's certificate on
		// its own connection, or the sidecar does when it intercepts.
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS12,
		NextProtos:         []string{"h2", "http/1.1"},
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			asked = true
			return nil, errProbed
		},
	})
	err = conn.HandshakeContext(ctx)
	if asked {
		return true, true
	}
	var netErr net.Error
	if err != nil && errors.As(err, &netErr) {
		return false, false
	}
	// A complete handshake, or one the browser would fail too (not TLS, no common version...).
	return false, true
}

// newAnonymous is the upstream for intercepted hosts without an enabled certificate: the
// server's request gets an empty Certificate message, like a browser whose user chose none.
func (p *proxy) newAnonymous() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Director: directIntercepted,
		Transport: &http.Transport{
			DialContext: p.dialer.DialContext,
			TLSClientConfig: &tls.Config{
				RootCAs:            p.roots,
				InsecureSkipVerify: p.insecure,
				MinVersion:         tls.VersionTLS12,
				Renegotiation:      tls.RenegotiateOnceAsClient,
			},
			MaxIdleConnsPerHost:   6,
			IdleConnTimeout:       90 * time.Second,
			ExpectContinueTimeout: time.Second,
			DisableCompression:    true,
		},
		FlushInterval: -1,
		// Tells the app the site asked for a certificate and got none (packages/browser).
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Set("X-Sa-Certificate-Requested", "none")
			return nil
		},
		ErrorHandler: p.failAnonymous,
		ErrorLog:     quiet,
	}
}

// failAnonymous answers the browser when an anonymous upstream request failed. A handshake the
// server refused means it requires a certificate.
func (p *proxy) failAnonymous(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		return
	}
	hostname := r.URL.Hostname()
	session := ""
	if mc, ok := r.Context().Value(mitmKey{}).(*mitmConn); ok {
		hostname, _, _ = net.SplitHostPort(mc.target)
		session = mc.session
	}
	ce := classify(err)
	if ce.code == "rejected" {
		ce = &certError{code: "no_certificate", detail: ce.detail}
	}
	p.desk.send(outMessage{
		Type: "event", Event: "upstream_error", Session: session, Host: hostname, Code: ce.code,
		Message: ce.detail,
	})
	writeCertError(w, p.language(), hostname, ce)
}

// probeState is the proxy's probe cache.
type probeState struct {
	probeMu sync.Mutex
	probes  map[string]*probe
}
