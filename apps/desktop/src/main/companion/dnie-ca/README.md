# DNIe CA certificates

Public CA certificates of the DNIe PKI (Dirección General de la Policía). The phone sends only
the card's leaf certificate, so `../dnie-chain.ts` completes the path with these: the
intermediate for the sidecar's TLS client certificate, and the intermediate plus root for
CAdES/XAdES/PAdES signatures. They live in `certificates.ts` as PEM text, so they are part of
the main-process bundle (and of the headless app that `tools/eval` runs with tsx): no packaging
step copies them. `openssl x509 -noout -text` reads each one pasted into a file.

| Constant | Subject CN | Issuer CN | Valid (UTC) | Serial | SHA-256 fingerprint |
|---|---|---|---|---|---|
| `AC_RAIZ_DNIE_2` | AC RAIZ DNIE 2 | AC RAIZ DNIE 2 (self-signed) | 2013-09-27 10:26:05 to 2043-09-27 10:26:05 | `2B1BBBCB61CF482452455D3D5EDBE2A3` | `C5:C3:80:EB:92:40:FB:36:A1:6E:15:F5:D6:BA:D0:BF:61:1F:6D:03:F0:EF:24:22:99:19:E7:D2:D8:12:6C:11` |
| `AC_DNIE_004` | AC DNIE 004 | AC RAIZ DNIE 2 | 2014-06-13 12:15:34 to 2029-06-13 12:15:34 | `439A9628B2660FEE539AEB66FCF15518` | `EB:AE:99:30:30:45:63:07:64:DC:5C:F9:D5:AF:9D:C0:09:35:4D:87:29:C4:07:B6:BF:9A:13:62:08:04:6F:6C` |
| `AC_DNIE_005` | AC DNIE 005 | AC RAIZ DNIE 2 | 2015-06-17 09:58:25 to 2030-06-17 09:58:25 | `68FC4E1957A3D005558144C143580BDD` | `82:8A:22:FF:05:93:24:83:C9:E8:D2:52:39:9B:A1:15:A5:7D:A7:58:69:D2:04:42:29:51:FF:A1:4C:8E:E8:28` |
| `AC_DNIE_006` | AC DNIE 006 | AC RAIZ DNIE 2 | 2015-07-28 12:47:29 to 2030-07-28 12:47:29 | `267DEAB7265C1BC055B779E14109F042` | `ED:A4:7E:8A:12:D7:E8:A7:27:21:C2:20:06:98:07:52:3E:74:6B:48:C2:44:14:43:17:7B:5F:BC:58:10:3B:BD` |

Every subject and issuer is `C=ES, O=DIRECCION GENERAL DE LA POLICIA, OU=DNIE, CN=<CN>`. The
three intermediates carry Authority Key Identifier `53:DC:6E:62:…:87:12:F0:9B`, the root's
Subject Key Identifier, and `openssl verify` accepts each against the root.

## Source and checks (downloaded 2026-10-18)

- Root: `https://www.dnielectronico.es/ZIP/ACRAIZ-DNIE2.zip`, linked from "AC Raíz"
  (`https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_077`).
- Intermediates: `https://www.dnielectronico.es/ZIP/ACDNIE00{4,5,6}.crt.zip`, linked from "AC
  Subordinadas" (`https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_078`).
  Shipped as DER; converted to PEM with `openssl x509`.
- The serial numbers, validity periods and SHA-1 fingerprints match the ones those two pages
  print (the pages give SHA-1 and MD5, not SHA-256): root `eb 4d 69 02 … 39 10 27 ce`, 004
  `3f 7a 70 b9 … 0d 65 82 9a`, 005 `e7 0c f3 b6 … 00 85 c1 95`, 006 `42 3b b4 97 … f6 55 b7 ee`.
- Second source: the root's SHA-256 fingerprint matches the AC RAIZ DNIE 2 entry of Spain's
  EU Trusted List (`https://tsl.digital.gob.es/TSL.xml`, issued 2026-09-24, found through
  `https://ec.europa.eu/tools/lotl/eu-lotl.xml`). The trusted list carries only the DNIe roots,
  not the intermediates; they are trusted because the root's key verifies their signatures.
- No newer intermediate exists: "AC Subordinadas" lists AC DNIE 001 to 006 only. 001 to 003
  expired on 2021-02-26 (per that page) and are not shipped.

When the Policía publishes a new intermediate (an AC DNIE 007), add its PEM to
`certificates.ts`, list it in `../dnie-chain.ts` and in this table. Until then, cards issued by
it fall back to the leaf alone.
