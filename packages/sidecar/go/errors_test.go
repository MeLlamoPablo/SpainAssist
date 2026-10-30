package main

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"testing"
)

// A failed dial, read or write the way Go reports it: the errno in an os.SyscallError
// ("connectex", "wsarecv"... on Windows) in a net.OpError.
func netOpError(op, call string, errno error) error {
	addr := &net.TCPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 443}
	return &net.OpError{Op: op, Net: "tcp", Addr: addr, Err: os.NewSyscallError(call, errno)}
}

// localizedErrno is a Windows errno as Windows prints it in the system's language (on this OS,
// syscall.Errno(10061) would print "errno 10061").
type localizedErrno struct {
	errno   syscall.Errno
	message string
}

func (e localizedErrno) Error() string { return e.message }
func (e localizedErrno) Unwrap() error { return e.errno }

// Spanish Windows's message for WSAECONNREFUSED.
var refusedInSpanish = localizedErrno{wsaECONNREFUSED,
	"No se puede establecer una conexión ya que el equipo de destino denegó expresamente dicha conexión."}

func TestNetErrorCodeOfWindowsErrnos(t *testing.T) {
	for _, c := range []struct {
		name string
		err  error
		want string
	}{
		{"WSAECONNREFUSED", netOpError("dial", "connectex", syscall.Errno(10061)), "ERR_CONNECTION_REFUSED"},
		{"WSAECONNRESET", netOpError("read", "wsarecv", syscall.Errno(10054)), "ERR_CONNECTION_RESET"},
		{"WSAECONNABORTED", netOpError("write", "wsasend", syscall.Errno(10053)), "ERR_CONNECTION_ABORTED"},
		{"WSAETIMEDOUT", netOpError("dial", "connectex", syscall.Errno(10060)), "ERR_CONNECTION_TIMED_OUT"},
		{"WSAEHOSTUNREACH", netOpError("dial", "connectex", syscall.Errno(10065)), "ERR_ADDRESS_UNREACHABLE"},
		{"WSAENETUNREACH", netOpError("dial", "connectex", syscall.Errno(10051)), "ERR_ADDRESS_UNREACHABLE"},
		{"WSAENETDOWN", netOpError("dial", "connectex", syscall.Errno(10050)), "ERR_INTERNET_DISCONNECTED"},
		{"ERROR_CONNECTION_REFUSED", netOpError("dial", "connectex", syscall.Errno(1225)), "ERR_CONNECTION_REFUSED"},
		{"ERROR_NETWORK_UNREACHABLE", netOpError("dial", "connectex", syscall.Errno(1231)), "ERR_ADDRESS_UNREACHABLE"},
		{"ERROR_HOST_UNREACHABLE", netOpError("dial", "connectex", syscall.Errno(1232)), "ERR_ADDRESS_UNREACHABLE"},
		{"ERROR_CONNECTION_ABORTED", netOpError("read", "wsarecv", syscall.Errno(1236)), "ERR_CONNECTION_ABORTED"},
		{"a message in Spanish", netOpError("dial", "connectex", refusedInSpanish), "ERR_CONNECTION_REFUSED"},
		// http.Transport and the reverse proxy wrap what the dial returned.
		{"wrapped", fmt.Errorf("proxy: %w", netOpError("dial", "connectex", syscall.Errno(10061))), "ERR_CONNECTION_REFUSED"},
		// WSAEADDRNOTAVAIL: no Chromium name of ours.
		{"other errno", netOpError("dial", "connectex", syscall.Errno(10049)), "ERR_CONNECTION_FAILED"},
	} {
		if got := netErrorCode(c.err); got != c.want {
			t.Errorf("%s: %v: got %s, want %s", c.name, c.err, got, c.want)
		}
	}
}

func TestNetErrorCodeOfThisOSErrnos(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{netOpError("dial", "connect", syscall.ECONNREFUSED), "ERR_CONNECTION_REFUSED"},
		{netOpError("read", "read", syscall.ECONNRESET), "ERR_CONNECTION_RESET"},
		{netOpError("dial", "connect", syscall.EHOSTUNREACH), "ERR_ADDRESS_UNREACHABLE"},
		{netOpError("dial", "connect", syscall.ENETUNREACH), "ERR_ADDRESS_UNREACHABLE"},
		{netOpError("dial", "connect", syscall.ETIMEDOUT), "ERR_CONNECTION_TIMED_OUT"},
		{&net.DNSError{Err: "no such host", Name: "sede.example", IsNotFound: true}, "ERR_NAME_NOT_RESOLVED"},
		// The dialer's own deadline.
		{&net.OpError{Op: "dial", Net: "tcp", Err: os.ErrDeadlineExceeded}, "ERR_CONNECTION_TIMED_OUT"},
		{context.Canceled, "ERR_CONNECTION_FAILED"},
		// Messages aren't read: on Windows they are in the system's language.
		{errors.New("connection refused"), "ERR_CONNECTION_FAILED"},
	} {
		if got := netErrorCode(c.err); got != c.want {
			t.Errorf("%v: got %s, want %s", c.err, got, c.want)
		}
	}
}

func TestClassify(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{fmt.Errorf("dial: %w", &certError{code: "declined"}), "declined"},
		{fmt.Errorf("tls: %w", x509.UnknownAuthorityError{}), "server_certificate"},
		{fmt.Errorf("tls: %w", x509.HostnameError{Host: "sede.example", Certificate: &x509.Certificate{}}), "server_certificate"},
		// What crypto/tls returns when the server answers the handshake with an alert.
		{&net.OpError{Op: "remote error", Err: errors.New("tls: bad certificate")}, "rejected"},
		{netOpError("dial", "connectex", refusedInSpanish), "unreachable"},
		{errors.New("a signature didn't verify"), "failed"},
	} {
		if got := classify(c.err).code; got != c.want {
			t.Errorf("%v: got %s, want %s", c.err, got, c.want)
		}
	}
}
