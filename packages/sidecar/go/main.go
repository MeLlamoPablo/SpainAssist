// Command sa-sidecar is SpainAssist's TLS helper for the agent's browser.
//
// It is an HTTP proxy on loopback. Each browser context gets its own port (the session), and
// every request needs the per-launch password. Connections are plain TCP tunnels, so Chromium checks
// every site's certificate itself, except for the hosts where a session enabled a client
// certificate (Cl@ve's certificate gateway, AEAT, Seguridad Social...). For those, the sidecar
// finishes TLS with the browser using a per-launch key that Chromium is told to trust
// (--ignore-certificate-errors-spki-list), and talks to the real host itself: TLS with the
// platform's verifier and the client certificate. The key is a .p12 key in memory, or the DNIe
// in the user's phone, which signs each handshake through the desktop app.
//
// Why a native sidecar: Electron's TLS can't sign a handshake with a key it doesn't hold
// (docs/research/dnie.md §1–2). The protocol with the app is in protocol.go.
package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
)

func main() {
	in := bufio.NewReaderSize(os.Stdin, 64<<10)
	h := newHost(os.Stdout)

	cfg, err := readMessage(in)
	if err != nil || cfg.Type != "config" {
		fail("expected a config message first")
	}
	p, err := newProxy(cfg, h)
	if err != nil {
		fail(err.Error())
	}
	h.send(outMessage{Type: "ready", SPKI: p.spki})

	for {
		m, err := readMessage(in)
		if err != nil {
			// stdin closed: the app quit or crashed. Never outlive it.
			os.Exit(0)
		}
		switch m.Type {
		case "session":
			p.configure(m)
		case "end":
			p.endSession(m.Session)
		case "reply":
			h.reply(m)
		default:
			h.log("warn", fmt.Sprintf("unknown message %q", m.Type))
		}
	}
}

// loopback accepts only loopback listen addresses: the proxy is never reachable from the network.
func loopback(listen string) (string, error) {
	if listen == "" {
		return "127.0.0.1:0", nil
	}
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return "", err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return "", fmt.Errorf("listen address must be loopback, got %q", listen)
	}
	return listen, nil
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "sa-sidecar:", message)
	os.Exit(2)
}
