# Webhook ingester

The only public way into Coolify. GitHub's push webhook calls `POST https://hooks.<domain>/github`;
the ingester checks GitHub's signature and sends Coolify a new request built from the few fields
Coolify deploys from. Coolify's dashboard, API and realtime ports answer on loopback only (see
[infra/README.md](../../infra/README.md)), so no request reaches Coolify's PHP unless GitHub
signed it, and then only as this rebuilt copy: a PHP request-parsing bug (like
CVE-2026-109618/109619) has nothing to parse but a small JSON document we wrote.

## What reaches Coolify

`POST http://coolify:8080/webhooks/source/github/events/manual` (Coolify's endpoint for apps
cloned with a deploy key; `manual()` in `app/Http/Controllers/Webhook/Github.php`, checked
against Coolify 4.4.7) with three headers, `Content-Type: application/json`,
`X-GitHub-Event: push` and `X-Hub-Signature-256` (a new signature with the same secret), and
this body:

```json
{
  "ref": "refs/heads/master",
  "after": "<40 or 64 hex digits>",
  "repository": { "full_name": "MeLlamoPablo/SpainAssist" },
  "commits": [{ "message": "", "added": [], "removed": [], "modified": ["every", "changed", "file"] }]
}
```

- **Files**: Coolify unions every commit's added, removed and modified files to match apps'
  watch paths, so one commit carries them all. Paths are non-empty strings of at most 4096
  characters without control characters.
- **Messages**: Coolify only checks whether every commit asks to skip the deploy (`[skip ci]` or
  `[skip cd]`). The ingester decides that the same way and sends `[skip ci]` or an empty message.
- **Refused or answered here**: requests without a valid signature (401), other repositories
  (422), anything that isn't a well-formed push (400), non-JSON bodies (415), bodies over 25 MB
  (413), and any other method or path (404). `ping` gets `pong`; other events, tag pushes and
  branch deletions get a 200 and go no further.

Coolify's answer (status and up to 64 KB) goes back to GitHub, so its delivery log still shows
which apps were queued; 502 when Coolify doesn't answer.

## Running

No dependencies and no build: Node 24 runs the TypeScript as is.

```sh
GITHUB_WEBHOOK_SECRET=… GITHUB_REPOSITORY=owner/name node src/main.ts
```

| Variable | Default | |
| --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` | required | The hook's secret (at least 16 characters) |
| `GITHUB_REPOSITORY` | required | `owner/name`: the only repository forwarded |
| `COOLIFY_WEBHOOK_URL` | `http://coolify:8080/webhooks/source/github/events/manual` | |
| `PORT` / `HOST` | `8795` / `0.0.0.0` | |

In production it is a container next to Coolify (`infra/terraform/webhook_ingester.tf`):
`node:24-slim` with `src/` mounted read-only, on the `coolify` network, routed by Coolify's
Traefik through Docker labels. `./tf.sh apply` uploads changes from your checkout and restarts
it; a push doesn't deploy it. Logs: `docker logs sa-webhook-ingester` (one line per delivery:
its id, the outcome and Coolify's status).

When upgrading Coolify, check that `manual()` still reads only these fields.

Tests: `corepack pnpm --filter @sa/webhook-ingester test`.
