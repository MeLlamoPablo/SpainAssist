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
| `GET /android` | Download page of the Android APK offered outside Google Play (when configured; otherwise it redirects to the store) |
| `GET /android/latest.json` | The latest APK, for the desktop's update notice (see below) |
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
| Backlog of all receivers | 512 MiB, then the receivers furthest behind are disconnected |
| Open connections | 300 in total |

**Memory.** Frames are forwarded at once, so what the relay holds is the receivers' backlog
(`bufferedAmount`), plus up to one frame being received per socket. The total backlog is summed
from every socket on each forwarded frame (no running count that could drift), and kept under
`MAX_BUFFERED_MEGABYTES`; without it, 300 receivers × 16 MiB could reach 4.7 GiB. The
per-receiver limit stays at 16 MiB because a document request (up to 24 MiB) arrives in one burst,
and a phone on a slower link than the desktop's falls behind by a good part of it. Worst case:
512 MiB of backlog + 300 × 1 MiB of incoming frames + ~100 MiB for Node ≈ 0.9 GiB, inside the
container's 1 GiB (`infra/terraform/coolify.tf`). A disconnected receiver reconnects, and the desktop
sends again what the phone hasn't answered, as after any dropped connection.

**Privacy.** No personal data ever reaches the relay in clear: documents, certificates and
signatures are inside the encrypted frames. The pairing payload is in the link's fragment, which
browsers never send. The log has the role, the outcome and close codes only, with no room ids
and no addresses.

**Pairing links.** The desktop shows `https://<relay host>/p#<payload>` as a QR code. With App
Links verified (`ANDROID_CERT_SHA256`), Android opens it straight in the app. Otherwise the page
offers "Descargar Spain Assist para Android", linking to the Play Store (or to `/android` while
an APK is configured). After installing, the app's own scanner can read the QR. The page follows
the system's light or dark theme and serves its fonts locally, without third-party requests.

**Android APK outside Google Play.** While Google Play reviews the app, we offer the universal
APK that Google Play signs (Play Console > App bundle explorer > Downloads > "Signed, universal
APK"), hosted as an asset of its `android/vX.Y.Z` GitHub release. It has the signature of the
Play install, so each updates the other (`docs/research/play-policy.md`, "Distribution outside
Play"). With `ANDROID_APK_URL`, `ANDROID_APK_VERSION` and `ANDROID_APK_SHA256` set:
- `/p`'s button goes to `/android`. That link has no fragment, so the pairing payload still
  never leaves the phone's browser;
- `/android` (Spanish, the style of `/p`, no scripts) has the download button, the version, the
  steps to install an APK, the file's SHA-256 and a link to the source of that version (the
  `android/vX.Y.Z` tag);
- `/android/latest.json` answers `{ "version", "url", "sha256", "page" }`, where `page` is the
  absolute URL of `/android` (with `TRUST_PROXY`, in the scheme of `X-Forwarded-Proto`). The
  desktop reads it (`apps/desktop/src/main/companion/phone-app.ts`) to tell a phone whose app is
  older, with a QR to `page`.

Without them (all three unset or empty), everything points to the store again: `/p` links to
`INSTALL_URL` or the Play page, `/android` redirects there (302), and `/android/latest.json`
answers `{ "store": "<that URL>" }` with status 200, so the desktop names Google Play in its
notices. Going back to Google Play is only that: unset the three variables. Setting only some of
them stops the relay at start. `/android/latest.json` is cached for 5 minutes (`max-age=300`).

## Configuration

| Variable | Default | What |
| --- | --- | --- |
| `HOST` / `PORT` | 127.0.0.1 / 8794 | Listen address (`corepack pnpm services` uses 0.0.0.0, for phones on the same Wi-Fi) |
| `TRUST_PROXY` | off | Client address from `X-Forwarded-For` (behind our reverse proxy only) |
| `ANDROID_PACKAGE` | `es.spainassist.firma` | App id for App Links and the landing page |
| `ANDROID_CERT_SHA256` | empty | Comma-separated SHA-256 fingerprints of the app's signing certificates |
| `INSTALL_URL` | Play Store page | Where "Descargar Spain Assist para Android" points while no APK is configured |
| `ANDROID_APK_URL` | unset | Direct `https://` URL of the APK (a GitHub release asset). With the next two: all three or none |
| `ANDROID_APK_VERSION` | unset | Its version, `X.Y.Z` (the page links to the tag `android/vX.Y.Z`) |
| `ANDROID_APK_SHA256` | unset | SHA-256 of the APK file, 64 hex digits (`shasum -a 256 <file>`) |
| `ROOMS_PER_ADDRESS` / `CONNECTIONS_PER_ADDRESS` | 20 / 40 | Per client address |
| `MAX_CONNECTIONS` | 300 | In total, all addresses |
| `ROOM_MEGABYTES` | 512 | Bytes forwarded per room (binary and text frames) |
| `BUFFERED_MEGABYTES` | 16 | Backlog of one receiver before it is disconnected |
| `MAX_BUFFERED_MEGABYTES` | 512 | Backlog of all receivers together |

Local development: `corepack pnpm services` starts it on port 8794. `corepack pnpm dev:local`
points the app at it and puts this machine's LAN address in the QR, so a real phone on the same
Wi-Fi can pair (the debug app accepts `ws://`). Tests run it on a random port.

Production: Coolify app `relay-server` (`infra/terraform/coolify.tf`) on `relay.<domain>`.
Fingerprints come from the `android_cert_sha256` Terraform variable. The APK's three variables
go in `relay_server_env` (`terraform.tfvars`, set by a human).
