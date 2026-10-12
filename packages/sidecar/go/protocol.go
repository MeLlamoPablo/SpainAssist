package main

// Messages between the desktop app and the sidecar: one JSON object per line, on stdin (from the
// app) and stdout (to it). The Node side is packages/sidecar/src/sidecar.ts; change both together.
//
// App → sidecar:
//
//	{"type":"config", "password", "key", "insecureUpstream", "roots"}   (first line)
//	{"type":"session", "id", "session", "listen"?, "hosts", "identity"}
//	    → {"type":"ack", "id", "port", "error"?}   (the first one opens the session's port)
//	{"type":"end", "session"}
//	{"type":"reply", "id", "signature"? | "error", "message"}  (answers a "call")
//
// Sidecar → app:
//
//	{"type":"ready", "spki"}
//	{"type":"call", "id", "method":"prepare"|"sign", "session", "identity", "host", "hash", "digest"}
//	{"type":"cancel", "id"}   (the call isn't needed any more: the browser gave up)
//	{"type":"event", "event":"handshake"|"upstream_error"|"tunnel_error", "session", "host", ...}
//	{"type":"log", "level", "message"}
//
// Secrets (the .p12 key, the proxy password) only arrive on stdin. Nothing secret is ever
// written to stdout or stderr.

type inMessage struct {
	Type string `json:"type"`
	ID   int64  `json:"id,omitempty"`

	// config
	Password         string   `json:"password,omitempty"`
	Key              string   `json:"key,omitempty"`
	InsecureUpstream bool     `json:"insecureUpstream,omitempty"`
	Roots            []string `json:"roots,omitempty"`

	// session, end. Listen: the port to reopen after a restart ("127.0.0.1:<port>").
	Session  string        `json:"session,omitempty"`
	Listen   string        `json:"listen,omitempty"`
	Hosts    []string      `json:"hosts,omitempty"`
	Identity *identitySpec `json:"identity,omitempty"`

	// reply
	Signature string `json:"signature,omitempty"`
	Error     string `json:"error,omitempty"`
	Message   string `json:"message,omitempty"`
}

// identitySpec is a client certificate for a session's hosts.
type identitySpec struct {
	// ID names the certificate in calls (the vault credential id).
	ID string `json:"id"`
	// Chain: Base64 DER certificates, leaf first.
	Chain []string `json:"chain"`
	// Key: Base64 PKCS#8 of a key kept in memory (a .p12). Empty: a remote key that signs through
	// "sign" calls (the DNIe in the phone). Remote keys are RSA PKCS#1 v1.5 only, over TLS 1.2.
	Key string `json:"key,omitempty"`
	// MaxConns: upstream connections per host. Default 2 for remote keys, 6 otherwise.
	MaxConns int `json:"maxConns,omitempty"`
}

type outMessage struct {
	Type  string `json:"type"`
	ID    int64  `json:"id,omitempty"`
	Error string `json:"error,omitempty"`

	// ready
	Port int    `json:"port,omitempty"`
	SPKI string `json:"spki,omitempty"`

	// call, event
	Method   string `json:"method,omitempty"`
	Event    string `json:"event,omitempty"`
	Session  string `json:"session,omitempty"`
	Identity string `json:"identity,omitempty"`
	Host     string `json:"host,omitempty"`
	Hash     string `json:"hash,omitempty"`
	Digest   string `json:"digest,omitempty"`
	Resumed  bool   `json:"resumed,omitempty"`
	Signed   bool   `json:"signed,omitempty"`
	Code     string `json:"code,omitempty"`

	// log, event
	Level   string `json:"level,omitempty"`
	Message string `json:"message,omitempty"`
}
