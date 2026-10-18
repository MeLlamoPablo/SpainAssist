# @sa/relay-server

Relays frames between the desktop app and the phone app ("Spain Assist") when the user
signs with their DNIe on the phone. The frames are end-to-end encrypted by `@sa/companion`: the
relay can't read them, and it has no accounts and no database. Hono + `ws` on Node.

## API

| Method & path | What |
| --- | --- |
| `GET /v1/rooms/{roomId}/desktop` (WebSocket) | The desktop's side of a room (`Authorization: Bearer <room key>`) |
| `GET /v1/rooms/{roomId}/phone` (WebSocket) | The phone's side |
| `GET /p` | Landing page of pairing links (`/p#<payload>`) for phones without the app |
| `GET /.well-known/assetlinks.json` | Android App Links for the pairing links (when configured) |
| `GET /health` | `{ "status": "ok" }` |

**Rooms.** A room id is 16 random bytes (Base64url, 22 characters) chosen by the desktop, and it
travels in the QR code. The desktop's first connection creates the room and binds it to its key
(only its SHA-256 is kept). A phone may only join an existing room (`4404` otherwise). Each side
has at most one connection: a newer one closes the older with `4409`, so a phone can reconnect
at once even when its old socket is half-dead. A relay restart forgets every room. The desktop
creates its room again when it reconnects, and phones then join as before.

**Frames.** Binary frames go to the other side unchanged (dropped when it isn't connected). Text
frames are control messages:
- the relay sends `{"type":"peer","present":true|false}` on connect and whenever the other side
  comes or goes;
- a client may send `{"type":"ping"}` and gets `{"type":"pong"}`.

The relay also pings every 20 s and drops sockets that miss a pong.

**Close codes.** `4401` missing or wrong desktop key, `4404` no such room, `4408` room expired,
`4409` replaced, `4429` limit reached, `1009` frame over the size limit. Bad paths are refused before the upgrade (HTTP 404/429).

**Limits** (in memory; a restart resets them):

| Limit | Default |
| --- | --- |
| Room lifetime | 72 h 10 min (the desktop ends pairings at 72 h) |
| Room with nobody connected | removed after 30 min |
| Bytes forwarded per room | 512 MiB |
| Binary frame | 1 MiB (the channel's fragments are 256 KiB) |
| Rooms per client address | 20 |
| Connections per client address | 40 |
| Receiver backlog | 16 MiB, then the slow receiver is disconnected |

**Privacy.** No personal data ever reaches the relay in clear: documents, certificates and
signatures are inside the encrypted frames. The pairing payload is in the link's fragment, which
browsers never send. The log has the role, the outcome and close codes only, with no room ids
and no addresses.

**Pairing links.** The desktop shows `https://<relay host>/p#<payload>` as a QR code. With App
Links verified (`ANDROID_CERT_SHA256`), Android opens it straight in the app. Otherwise the page
offers "Abrir en la app" (an `intent://` link to the app's `sa-firma://pair?d=<payload>`; Chrome
goes to the Play Store when the app is missing) and "Instalar la app". The app's own scanner reads
the QR too.

## Configuration

| Variable | Default | What |
| --- | --- | --- |
| `HOST` / `PORT` | 127.0.0.1 / 8794 | Listen address (`corepack pnpm services` uses 0.0.0.0, for phones on the same Wi-Fi) |
| `TRUST_PROXY` | off | Client address from `X-Forwarded-For` (behind our reverse proxy only) |
| `ANDROID_PACKAGE` | `es.spainassist.firma` | App id for App Links and the landing page |
| `ANDROID_CERT_SHA256` | empty | Comma-separated SHA-256 fingerprints of the app's signing certificates |
| `INSTALL_URL` | Play Store page | Where "Instalar la app" points |
| `ROOMS_PER_ADDRESS` / `CONNECTIONS_PER_ADDRESS` | 20 / 40 | Per client address |
| `MAX_CONNECTIONS` | 300 | In total, all addresses |
| `ROOM_MEGABYTES` | 512 | Bytes forwarded per room |

Local development: `corepack pnpm services` starts it on port 8794. `corepack pnpm dev:local`
points the app at it and puts this machine's LAN address in the QR, so a real phone on the same
Wi-Fi can pair (the debug app accepts `ws://`). Tests run it on a random port.

Production: Coolify app `relay-server` (`infra/terraform/coolify.tf`) on `relay.<domain>`.
Fingerprints come from the `android_cert_sha256` Terraform variable.
