package main

import (
	"crypto/x509"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"strings"
	"syscall"
)

// certError is why an intercepted request failed. Codes (also in X-Sa-Certificate-Error):
//   - declined, cancelled: the user didn't approve the login (on the phone or in the app);
//   - unavailable: the certificate isn't enabled or ready (e.g. the phone isn't paired);
//   - timeout: the signer didn't answer in time;
//   - rejected: the site refused the certificate (a TLS alert from the server);
//   - no_certificate: the site requires a certificate and none is enabled for it (probe.go);
//   - server_certificate: the site's own certificate isn't valid;
//   - unreachable: no connection to the site;
//   - failed: anything else (the card failed, a signature didn't verify...).
//
// The app may send other codes in its replies; they pass through.
type certError struct {
	code   string
	detail string
}

func (e *certError) Error() string { return e.code + ": " + e.detail }

func classify(err error) *certError {
	var ce *certError
	if errors.As(err, &ce) {
		return ce
	}
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &unknown) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return &certError{code: "server_certificate", detail: err.Error()}
	}
	message := err.Error()
	if strings.Contains(message, "remote error: tls:") {
		return &certError{code: "rejected", detail: message}
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return &certError{code: "unreachable", detail: message}
	}
	return &certError{code: "failed", detail: message}
}

// pageText is the error page in one of the app's languages ("es", "en").
type pageText struct {
	lang     string
	title    string
	fallback string
	site     string
	reasons  map[string]string
}

var pages = map[string]pageText{
	"es": {
		lang:     "es",
		title:    "No se pudo usar el certificado",
		fallback: "No se pudo iniciar sesión con el certificado.",
		site:     "Web",
		reasons: map[string]string{
			"declined":           "No se ha aprobado el inicio de sesión con el certificado.",
			"cancelled":          "Se ha cancelado el inicio de sesión con el certificado.",
			"unavailable":        "El certificado no está disponible para esta web ahora mismo.",
			"timeout":            "El certificado no respondió a tiempo.",
			"rejected":           "La web no ha aceptado el certificado.",
			"no_certificate":     "Esta web pide un certificado digital y no hay ninguno activado para ella.",
			"server_certificate": "El certificado de seguridad de esta web no es válido. No sigas.",
			"unreachable":        "No se pudo conectar con la web.",
		},
	},
	"en": {
		lang:     "en",
		title:    "The certificate couldn't be used",
		fallback: "Couldn't log in with the certificate.",
		site:     "Website",
		reasons: map[string]string{
			"declined":           "The login with the certificate wasn't approved.",
			"cancelled":          "The login with the certificate was cancelled.",
			"unavailable":        "The certificate isn't available for this website right now.",
			"timeout":            "The certificate didn't answer in time.",
			"rejected":           "The website didn't accept the certificate.",
			"no_certificate":     "This website asks for a digital certificate and none is enabled for it.",
			"server_certificate": "This website's security certificate isn't valid. Don't continue.",
			"unreachable":        "Couldn't connect to the website.",
		},
	},
}

// pageFor is the page text in lang, Spanish when the app sent no language or an unknown one.
func pageFor(lang string) pageText {
	if t, ok := pages[lang]; ok {
		return t
	}
	return pages["es"]
}

// The last line is for the app (packages/browser reads it): keep it in English and unchanged.
const errorPage = `<!doctype html>
<html lang="%s"><head><meta charset="utf-8"><title>%s</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5">
<h1>%s</h1>
<p>%s</p>
<p>%s: %s</p>
<p style="color: #666">SpainAssist certificate error (%s): %s</p>
</body></html>
`

// writeCertError answers the browser with a page in lang ("es", "en") that says why.
func writeCertError(w http.ResponseWriter, lang, hostname string, ce *certError) {
	t := pageFor(lang)
	reason, ok := t.reasons[ce.code]
	if !ok {
		reason = t.fallback
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Language", t.lang)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Sa-Certificate-Error", ce.code)
	w.WriteHeader(http.StatusBadGateway)
	title := html.EscapeString(t.title)
	fmt.Fprintf(w, errorPage, t.lang, title, title, html.EscapeString(reason), html.EscapeString(t.site),
		html.EscapeString(hostname), html.EscapeString(ce.code), html.EscapeString(truncate(ce.detail, 300)))
}

// netErrorCode names a failed connection the way Chromium does, so the app can explain it as if
// the browser had connected directly.
func netErrorCode(err error) string {
	var dns *net.DNSError
	switch {
	case errors.As(err, &dns):
		return "ERR_NAME_NOT_RESOLVED"
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(err.Error(), "refused"):
		return "ERR_CONNECTION_REFUSED"
	case errors.Is(err, syscall.ECONNRESET):
		return "ERR_CONNECTION_RESET"
	case errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH):
		return "ERR_ADDRESS_UNREACHABLE"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "ERR_CONNECTION_TIMED_OUT"
	}
	return "ERR_CONNECTION_FAILED"
}

// writeNetworkError answers a proxy request whose site couldn't be reached.
func writeNetworkError(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Sa-Network-Error", code)
	w.WriteHeader(http.StatusBadGateway)
	fmt.Fprintln(w, code)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
