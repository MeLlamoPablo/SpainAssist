# FNMT CA certificates

Public CA certificates of FNMT-RCM. When the app turns a certificate FNMT just issued into a vault
credential (`../broker.ts`), it builds the path from these rather than trusting the bundle the
download page sends (docs/research/fnmt.md §3.5, §6.4), as FNMT's Configurador does. The sidecar
then sends that whole path in TLS client logins, which strict sedes need. They live in
`certificates.ts` as PEM text, so they are part of the main-process bundle (and of the headless
app that `tools/eval` runs with tsx): no packaging step copies them.

| Constant | Subject | Issuer | Valid (UTC) | Serial | SHA-256 fingerprint |
|---|---|---|---|---|---|
| `AC_RAIZ_FNMT_RCM` | C=ES, O=FNMT-RCM, OU=AC RAIZ FNMT-RCM | (self-signed) | 2008-10-29 15:59:56 to 2030-01-01 00:00:00 | `5D938D306736C8061D1AC754846907` | `EB:C5:57:0C:29:01:8C:4D:67:B1:AA:12:7B:AF:12:F7:03:B4:61:1E:BC:17:B7:DA:B5:57:38:94:17:9B:93:FA` |
| `AC_FNMT_USUARIOS` | C=ES, O=FNMT-RCM, OU=Ceres, CN=AC FNMT Usuarios | AC RAIZ FNMT-RCM | 2014-10-28 11:48:58 to 2029-10-28 11:48:58 | `455F3AE15C21CDBA544F82AA4751EBDB` | `60:12:93:CA:20:B0:9A:03:29:5D:19:62:56:C6:95:3F:F9:EB:A8:11:DB:8E:3C:E1:40:41:3C:1B:FF:E9:A8:69` |
| `AC_REPRESENTACION` | C=ES, O=FNMT-RCM, OU=CERES, CN=AC Representación | AC RAIZ FNMT-RCM | 2015-06-30 09:51:53 to 2029-12-31 10:51:53 | `61C2D4D4F6A9AE77559266B98DAFD621` | `8F:D1:6A:17:99:44:D5:D1:D4:20:AF:09:40:5E:DA:7A:BF:2A:9C:74:28:83:E8:C2:F8:9E:0D:90:AF:AF:75:4B` |
| `AC_SECTOR_PUBLICO` | C=ES, O=FNMT-RCM, OU=Ceres, organizationIdentifier=VATES-Q2826004J, CN=AC Sector Público | AC RAIZ FNMT-RCM | 2019-11-28 08:48:09 to 2029-11-28 08:48:09 | `348160C51F5EDBCB5DDF89CAB4573392` | `82:65:75:6D:D5:CD:8A:37:EE:61:E4:03:51:28:8E:4B:16:A8:9D:D2:48:C1:EC:4E:BA:25:AA:F1:61:AB:F4:98` |
| `AC_RAIZ_FNMT_RCM_G2` | C=ES, O=FNMT-RCM, organizationIdentifier=VATES-Q2826004J, CN=AC RAIZ FNMT-RCM G2 | (self-signed) | 2024-10-10 09:13:52 to 2049-10-04 09:13:51 | `1FB64F919EC501EAB12128BB117A003C7C5AEF1A` | `02:07:86:53:9F:02:B6:23:CF:DF:32:5B:2E:4E:45:E0:D9:E3:F1:B8:E5:EC:96:00:EB:F0:AC:8F:BF:03:FB:E2` |
| `AC_USUARIOS_G2` | C=ES, O=FNMT-RCM, organizationIdentifier=VATES-Q2826004J, CN=AC USUARIOS G2 | AC RAIZ FNMT-RCM G2 | 2024-12-16 10:54:50 to 2039-12-13 10:54:49 | `5DD5D6A543498EFE35685E8253C703E9A6DE89A9` | `28:3A:9F:9F:E9:67:4F:67:EF:D6:E2:7B:B5:43:E0:EC:19:2C:BE:FF:20:FC:83:6C:22:43:65:47:44:C5:AF:89` |
| `AC_REPRESENTACION_G2` | C=ES, O=FNMT-RCM, organizationIdentifier=VATES-Q2826004J, CN=AC REPRESENTACIÓN G2 | AC RAIZ FNMT-RCM G2 | 2024-12-16 11:01:31 to 2039-12-13 11:01:30 | `0A6CD3C0FFC1DB0F7CB5CDD49A6EF807AF2D7806` | `0D:F2:88:3B:60:74:D5:B7:D7:94:0B:69:CA:65:8A:3A:9A:74:7A:8E:17:1F:65:3A:D4:CE:02:30:08:7D:9D:64` |
| `AC_SECTOR_PUBLICO_G2` | C=ES, O=FNMT-RCM, organizationIdentifier=VATES-Q2826004J, CN=AC SECTOR PÚBLICO G2 | AC RAIZ FNMT-RCM G2 | 2024-12-16 10:58:13 to 2039-12-13 10:58:12 | `4993B39D79A35CA319AE7DE679FBFD3CD61C1F7A` | `98:33:29:B0:0C:30:52:D7:EC:CD:46:BF:2C:F3:E2:9D:05:AE:93:D1:AA:14:6B:D5:07:8C:37:26:AE:82:71:FE` |

## Source and checks (downloaded 2026-10-31)

- All from FNMT's "Certificados raíz de la FNMT" page
  (`https://www.sede.fnmt.gob.es/descargas/certificados-raiz-de-la-fnmt`), at
  `https://www.sede.fnmt.gob.es/documents/10445900/10526749/<name>.cer`: `AC_Raiz_FNMT-RCM_SHA256`,
  `AC_FNMT_Usuarios`, `AC_Representacion`, `AC_Sector_Publico`, `AC_Raiz_FNMT-RCM_G2`,
  `AC_Usuarios_G2`, `AC_Representacion_G2` and `AC_Sector_Publico_G2`. The G1 files are DER and
  the G2 ones PEM; all were converted to PEM with `openssl x509`.
- `AC_FNMT_Usuarios.cer` is byte for byte the `https://www.cert.fnmt.es/certs/ACUSU.crt` FNMT
  links elsewhere, and the G1 root is `https://www.cert.fnmt.es/certs/ACRAIZFNMT.crt`.
- `openssl verify` accepts each intermediate against its root (G1 or G2), and each root against
  itself.
- Not shipped: the TLS server, time-stamping, OCSP and component CAs, which never issue
  certificates a person requests.

Which CA signs a new citizen certificate (G1 *AC FNMT Usuarios* or *AC Usuarios G2*) is still
unverified (docs/research/fnmt.md, Appendix B), so both are here. When FNMT publishes a new
issuing CA, add its PEM to `certificates.ts`, list it in `../authorities.ts` and in this table.
Until then, its certificates keep only the chain the download page sent.
