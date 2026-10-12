# AutoScript fixture

`autoscript.min.js` (renamed only to exclude unmodified vendor code from Biome) is the official clienteafirma 1.10.1 script copied unchanged from the
interrupted session's research prototype (clienteafirma master 0d7f3cf, 2026-08-22).
Upstream: https://github.com/ctt-gob-es/clienteafirma
The project is dual licensed under GPL-2.0 and EUPL-1.1. This file has no leading license
header in the research copy; its original contents are preserved. It is a test fixture only
and is never shipped as part of the replacement shim. Tests load it twice to exercise actual
global declarations and callbacks; all HTTP requests are fulfilled locally by Playwright.
