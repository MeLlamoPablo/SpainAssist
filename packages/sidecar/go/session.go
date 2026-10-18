package main

import (
	"io"
	"net"
	"net/http"
	"sync"
)

// session is one browser context (its own proxy port): which hosts it intercepts, with which
// certificate, and its open connections.
type session struct {
	id string

	mu     sync.Mutex
	server *http.Server
	ln     net.Listener
	hosts  map[string]bool
	ident  *identity
	conns  map[*tracked]struct{}
}

type tracked struct {
	target      string
	intercepted bool
	closers     []io.Closer
}

func (t *tracked) close() {
	for _, c := range t.closers {
		_ = c.Close()
	}
}

func newSession(id string) *session {
	return &session{id: id, hosts: map[string]bool{}, conns: map[*tracked]struct{}{}}
}

func (s *session) setServer(server *http.Server, ln net.Listener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.server = server
	s.ln = ln
}

// port is the session's proxy port, 0 before it listens.
func (s *session) port() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln == nil {
		return 0
	}
	return s.ln.Addr().(*net.TCPAddr).Port
}

func (s *session) closeServer() {
	s.mu.Lock()
	server, ln := s.server, s.ln
	s.server, s.ln = nil, nil
	s.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
	// server.Close only closes listeners its Serve goroutine has started on: close the port
	// here too, so it is shut when this returns.
	if ln != nil {
		_ = ln.Close()
	}
}

func (s *session) intercepts(target string) bool {
	return s.identityFor(target) != nil
}

func (s *session) identityFor(target string) *identity {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ident != nil && s.hosts[target] {
		return s.ident
	}
	return nil
}

func (s *session) current() *identity {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ident
}

// track remembers a connection so a new configuration can close it. Call the result when the
// connection ends.
func (s *session) track(target string, intercepted bool, closers ...io.Closer) func() {
	t := &tracked{target: target, intercepted: intercepted, closers: closers}
	s.mu.Lock()
	s.conns[t] = struct{}{}
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.conns, t)
		s.mu.Unlock()
	}
}

// set replaces the configuration and returns the previous identity. Connections whose handling
// changes are closed, so the browser opens new ones: tunnels to hosts that are now intercepted,
// and intercepted connections to hosts that aren't any more or now use another certificate.
func (s *session) set(hosts []string, ident *identity) *identity {
	next := map[string]bool{}
	if ident != nil {
		for _, h := range hosts {
			next[h] = true
		}
	}
	s.mu.Lock()
	old := s.ident
	s.hosts = next
	s.ident = ident
	var stale []*tracked
	for t := range s.conns {
		now := ident != nil && next[t.target]
		if t.intercepted != now || (t.intercepted && old != ident) {
			stale = append(stale, t)
			delete(s.conns, t)
		}
	}
	s.mu.Unlock()
	for _, t := range stale {
		t.close()
	}
	return old
}

func (s *session) closeAll() {
	s.mu.Lock()
	all := make([]*tracked, 0, len(s.conns))
	for t := range s.conns {
		all = append(all, t)
		delete(s.conns, t)
	}
	s.mu.Unlock()
	for _, t := range all {
		t.close()
	}
}
