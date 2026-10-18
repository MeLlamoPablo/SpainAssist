# Email for the agent (read + send) — research memo

*Date: 2026-10-08 · Scope: how the assistant can read the user's inbox (appointment confirmations,
notices from government sites, verification codes/links) and send email from the user's own
account, with secrets kept local. Sources: an Exa Agent Ultra run (`agent_run_3fd0ea29f32140cd82056720da1e72ba`,
$6.71, full report in the appendix) plus a follow-up check of Google's support pages. No code yet.*

## TL;DR

- **One IMAP/SMTP adapter (ImapFlow + Nodemailer) with app passwords** for Gmail, iCloud, Yahoo
  and Spanish providers (Movistar, …). No Google Cloud project, no OAuth verification, no CASA.
- **Outlook.com/Hotmail need Microsoft OAuth**: app passwords no longer work for their IMAP/SMTP
  (since 2024-09-16). Use `@azure/msal-node` (public client, system browser + PKCE) with Graph
  (`Mail.Read`, `Mail.Send`, `offline_access`) or IMAP/SMTP with `IMAP.AccessAsUser.All` /
  `SMTP.Send`. Microsoft publisher verification is free; register in a company Entra tenant.
- **Gmail OAuth only later**, if many users can't make an app password. IMAP with OAuth does
  *not* skip Google: XOAUTH2 needs the restricted `https://mail.google.com/` scope, so it has the
  same restricted-scope review (and likely CASA, because mail goes to a hosted LLM) as the Gmail
  API's `gmail.readonly`.
- **No existing pi package is a safe drop-in** (they take passwords through tools, keep tokens
  in plain files, or ask for broad scopes). Use them as references; write our own small
  extension with the credentials in main.
- **Safeguards:** sending only through a draft the user approves in native UI (the model can't
  confirm); email content is untrusted input; OTP codes and verification links are secrets the
  model sees only as handles.

## Gmail: IMAP + app password vs Gmail API + OAuth

| | IMAP + app password | Gmail API + OAuth |
| --- | --- | --- |
| Google relationship | None | OAuth client, brand verification, restricted-scope review, likely yearly CASA (we send mail text to a hosted LLM) |
| Search | Full Gmail syntax via `X-GM-RAW` (ImapFlow `gmraw`) | Same syntax |
| Labels / threads | `X-GM-LABELS` / `X-GM-THRID` | Native |
| Push | IMAP IDLE while the app runs | Pub/Sub (needs a server) or polling |
| Send | `smtp.gmail.com:587`; Gmail saves to Sent | `messages.send` |
| Who can use it | Needs 2-Step Verification; not for 2SV with security keys only, Advanced Protection, or Workspace accounts where admins blocked it | Everyone |
| Access granted | Full mailbox + send, long-lived until revoked | Scoped (`readonly` + `send`) |
| Breaks when | User changes Google password (Google revokes all app passwords) | User revokes, token expires |
| Future risk | Google says app passwords "aren't recommended"; may be removed like "less secure apps" | Policy and review changes |

Facts checked on 2026-10-08:
- IMAP is always on in Gmail; the setting was removed in January 2025.
  [support.google.com/mail/answer/7126229](https://support.google.com/mail/answer/7126229)
- App password requirements, exclusions, revoke-on-password-change, "not recommended".
  [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833)
- Max 15 simultaneous IMAP connections per Gmail account.

Inference (not stated by Google): with app passwords we use no Google API/OAuth client, so the
Google API Services User Data Policy and CASA don't apply to us. We still owe users GDPR-grade
handling and a clear disclosure that mail text goes to the model provider.

### Onboarding UX

1. Turn on 2-Step Verification, if needed (the hard step: needs a phone).
2. Open `myaccount.google.com/apppasswords`, name it ("Spain Assist"), Create.
3. Paste the 16-letter code with the email address. We fill server settings from the domain, so
   the user never sees "IMAP" or ports.

iCloud (appleid.apple.com → app-specific passwords) and Yahoo work the same way, so one flow with
per-provider instructions covers them.

**Idea to test:** the assistant opens the app-passwords page in our Playwright browser; the user
signs in and clicks Create; main reads the code from the page straight into the vault, never
through the model (same pattern as OTP handles). Google may add sign-in checks for automated
browsers. Test with a test account only.

On auth failure (e.g. after a password change), mark the account "reconnect needed" and ask the
user; never retry in a loop.

## Libraries

| Library | Status (2026-10) | Use |
| --- | --- | --- |
| `imapflow` | Active, MIT, Node 20+, own types | IMAP |
| `nodemailer` 10 | Active, MIT-0, own types | SMTP + MIME composition; disable file/URL content loading |
| `postal-mime` | Recommended by mailparser's author for new projects | Parse messages (bounded size) |
| `mailparser` | Maintenance mode | Only if we need streaming attachments |
| `@azure/msal-node` | Active, official | Microsoft OAuth + token cache |
| `@microsoft/microsoft-graph-client` | Official, optional | Graph; plain `fetch` is fine for a small surface |
| `googleapis` | Maintenance mode (security fixes only) | Only if we add Gmail OAuth later |

Avoid `node-imap` (weak maintenance).

## Existing pi packages and MCP servers (references only)

- `@e9n/pi-gmail` (MIT): full Gmail API tool set; good tool-shape reference.
- `@guquan-2002/pi-gmail` (MIT): confirms writes, refuses them non-interactively (good); asks
  for `gmail.modify`, tokens in plain files.
- `@patimweb/pi-email` (MIT): IMAP/SMTP + Graph; `email_setup` tool takes passwords (model sees
  them), needs Node 26+, uses `node-imap`.
- `pi-google-services`: unverified shared OAuth client capped at 100 users.
- Mario Zechner's `gmcli` + pi skill: Gmail CLI, reference only.
- Outlook MCP: `mpalermiti/outlook-mcp` (personal accounts, OS keyring) and
  `Ixtria/outlook-mcp-hardened` (read-only defaults, explicit send enablement).
- `GongRzhe/Gmail-MCP-Server` is archived.

pi now has built-in MCP support, but a direct extension with registered tools is simpler for us.

## Proposed design

```text
Native UI (connect account, approve send)
        │
Main: mail service ── vault (safeStorage): app passwords / MSAL cache
  ├─ IMAP/SMTP adapter (ImapFlow + Nodemailer)
  ├─ Microsoft adapter (MSAL + Graph or IMAP/SMTP OAuth)
  ├─ local drafts, attachment handles, send ledger
  └─ OTP/link extractor → opaque handles
        │ host bridge (zod-validated)
pi extension tools → model
```

| Tool | Input | Output |
| --- | --- | --- |
| `email_accounts` | — | Account ids + status |
| `email_search` | Account, bounded filters (Gmail: `gmraw`), page | Handles, minimal headers, short snippets |
| `email_read` | Handle, sections | Bounded, sanitized text + attachment metadata |
| `email_draft_create` / `_update` | Recipients, subject, body, attachment handles | Local draft id + preview |
| `email_send` | Draft id | `approval_required` / `cancelled` / `accepted` / `uncertain` |

Rules:
- Send needs a one-use approval in native UI bound to the exact draft (account, To/Cc/Bcc, text,
  attachment bytes). Any edit voids it. No `confirmed: true` argument.
- Keep a send ledger; after a possible-accept failure report `uncertain` instead of retrying.
- No delete, rules, forwarding, bulk send or raw SMTP/IMAP options.
- Attachments only through vault/document handles, never model-chosen paths or URLs.
- Email content is untrusted: strip HTML, block remote content, never take instructions from it,
  check public-office addresses independently.
- OTPs and tokenized links: a local extractor returns a handle; a browser action restricted to
  the expected site uses it. Show the raw value only in user UI. (Today codes the user types go
  into pages through `browser_fill_from_user`, which the model never sees; handles extend that.)
- Fetch only what the current procedure needs; scrub logs with `@sa/pii`.

## Open questions

1. Is Gmail at launch with app passwords enough, or do we need OAuth for users without 2SV?
2. Microsoft: Graph or IMAP/SMTP with OAuth? (Graph is the cleaner API; IMAP/SMTP reuses the
   one adapter.)
3. Does the guided app-password flow in our browser work reliably with Google's sign-in checks?

---

## Appendix: Exa Agent Ultra report (2026-10-07, verbatim)

The question asked about IMAP vs Gmail API vs Graph vs JMAP vs unified APIs, Node libraries,
existing pi packages and MCP servers, and tool design. Note: it recommends the Gmail API for
Gmail; this memo changes that to IMAP + app password (see above), because IMAP with OAuth needs
the same Google review and app passwords need none.

#### Recommendation — 7 October 2026

**Build a small, local mail service behind your own pi tools, with three adapters:**

1. **Gmail API + Google desktop OAuth** for Gmail.
2. **Microsoft Graph + delegated desktop OAuth** for Outlook.com/Hotmail and Microsoft 365.
3. **ImapFlow + Nodemailer** for iCloud, Yahoo and other providers, using provider-approved OAuth where available and app passwords where necessary.

Keep authentication, token refresh, credential storage and send approval **outside the model-facing tool interface**. Use community pi/MCP integrations as implementation references, not as an unmodified production security boundary.

Two important corrections to the premise:

- **`gmail.send` is sensitive, not restricted; `gmail.readonly` is restricted.** Google’s security-assessment requirement depends on the scopes and data flow—not merely whether you use the Gmail API. Gmail IMAP OAuth actually requires the broader restricted `https://mail.google.com/` scope. [Google scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes), [Gmail XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).
- **Local credentials do not mean local email processing.** Sending retrieved email to a hosted LLM is a separate disclosure of mailbox data, with Google-policy, privacy and potentially assessment consequences. Treat that architectural decision explicitly. [Google restricted-scope requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### 1. Transport, provider coverage and authentication

#### Which approach fits?

| Approach | Coverage | Main trade-off | Recommendation |
|---|---|---|---|
| Gmail API | Gmail and Google Workspace | Good Gmail-specific search, messages and threads; restricted-scope review for reading | Primary Gmail adapter |
| Microsoft Graph | Personal Outlook.com/Hotmail and Microsoft 365 | Delegated mail permissions; organizational consent policies can intervene | Primary Microsoft adapter |
| IMAP/SMTP with OAuth | Gmail, Microsoft and some other providers | Shared mail protocol, but provider-specific OAuth; Google requires broad mailbox scope | Supported alternative, not a verification shortcut |
| IMAP/SMTP with app passwords | iCloud, Yahoo and providers offering them | Broad, usually long-lived credentials; manual setup and account-policy restrictions | Compatibility fallback |
| IMAP/SMTP with ordinary passwords | Providers that still explicitly support it | Weakest credential model; not a modern Google/Microsoft strategy | Last-resort provider-specific support |
| JMAP | Supporting providers such as Fastmail | Modern JSON mail/submission model, but insufficient mainstream coverage | Optional later adapter |
| Hosted unified API | Vendor-supported Gmail, Microsoft and IMAP providers | Less integration work, recurring charges and remote credential/data custody | Incompatible with your strict local-custody requirement |
| Locally deployed EmailEngine | IMAP/SMTP and supported Gmail/Graph integrations | Existing REST abstraction, but commercial licensing and operational footprint | Usually excessive for a consumer desktop app |

Provider/API references: [Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes), [Graph mail overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0), [Microsoft IMAP/SMTP OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth), [Fastmail standards](https://www.fastmail.help/hc/en-us/articles/1500000278382-Email-standards), [EmailEngine](https://emailengine.app/).

**Why not make everything IMAP?** It reduces protocol implementations, but does not unify OAuth registration or consent. For Gmail it increases requested access compared with read-plus-send API scopes. App passwords also do not provide a dependable cross-provider strategy. The hybrid approach costs more engineering initially but gives the two major providers a better consumer login experience and clearer least-privilege permissions.

#### Desktop OAuth: yes, for both Google and Microsoft

**Google:** register a **Desktop app** OAuth client. Use the system browser, authorization code with PKCE, and a loopback listener bound only to the local interface. Desktop loopback redirects remain supported; the loopback deprecations affecting other client types do not prohibit this desktop flow. Do not use an embedded Electron login webview. Installed applications cannot protect a confidential client secret; Google’s installed-app client configuration must not be confused with a confidential web-server credential. [Native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [loopback migration guidance](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration).

**Microsoft:** use `@azure/msal-node` with `PublicClientApplication`, system-browser authorization code + PKCE and a registered localhost redirect. Microsoft has an explicit Electron tutorial. Register the appropriate audience: personal accounts for consumer-only support, or organizational **and** personal accounts for both. Do not bundle a confidential application secret. [Microsoft Electron tutorial](https://learn.microsoft.com/en-us/entra/identity-platform/tutorial-v2-nodejs-desktop).

Recommended permissions:

- **Gmail:** `gmail.readonly`; request `gmail.send` when sending is enabled. Avoid `gmail.modify` unless mailbox mutation is genuinely needed.
- **Graph:** delegated `Mail.Read`, `Mail.Send` and refresh capability through `offline_access`. `Mail.Read` and `Mail.Send` support personal accounts and do not inherently require administrator consent, although organizational policy can override user consent.
- **Store drafts locally initially.** Creating drafts in the provider mailbox expands permissions: Gmail uses `gmail.compose`; Graph’s create-draft operation requires `Mail.ReadWrite`. Local draft storage does not require those additional provider permissions. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference), [Graph create draft](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0).

#### Google verification and CASA: the real launch constraint

For a public consumer application, plan for brand/consent-screen verification, a verified domain, privacy policy, demonstrated scope usage and the restricted-scope review associated with reading mail.

**Security assessment is a separate question.** Google’s current documentation requires an annual assessment when restricted data is accessed from or through servers. A genuinely client-only application is materially different; Google has explicitly recommended client-side-only storage as a way to avoid server-processing assessment requirements. However, that is **not an exemption from OAuth verification**. Obtain Google’s determination for your exact design rather than assuming “Electron means exempt.” [Current restricted-scope policy](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [Google’s client-side architecture guidance](https://developers.googleblog.com/en/get-smart-about-preparing-your-app-for-oauth-verification/).

For your app, the critical question is whether email bodies, snippets, attachments or derived restricted data go to a **hosted LLM**. If yes, budget on the assumption that server-side restricted-data handling must be reviewed. Keeping refresh tokens on the laptop alone does not settle it. Google permits appropriate productivity uses, including generative-AI summaries, but prohibits using this data to train or improve general-purpose models beyond permitted user-specific uses. Select suitable inference retention/training terms and disclose the transfer. [Workspace user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

Do not budget from an obsolete universal “CASA costs $15,000–$75,000” claim. Google says it charges no assessment fee; independent assessor pricing varies, and eligible free Tier 2 arrangements exist. Assessment/revalidation is generally annual. A testing-mode project is not a production workaround: mail authorizations in that mode expire after seven days, and test-user limits apply. [Assessment FAQ](https://support.google.com/cloud/answer/13463817?hl=en-uk), [OAuth audience/testing rules](https://support.google.com/cloud/answer/15549945?hl=en).

#### Microsoft publisher verification

Publisher verification is **free identity verification**, not a Google-style paid annual security assessment. It improves trust and matters particularly for organizational tenants using risk-based consent policies. An app registration associated with a personal Microsoft account cannot receive publisher verification; register under your company’s Entra tenant while allowing personal accounts as an application audience. These are different concepts. Work/school administrators can still block consent or require approval. [Microsoft publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview).

#### Basic authentication and app-password status

- **Google:** ordinary-password “less secure app” access is no longer the supported route. Google’s current Workspace guidance gives **1 May 2025** for its cutoff. **App passwords have not been universally abolished**: they remain documented for eligible accounts with two-step verification, with restrictions for some account/security configurations. They are a fallback, not a good default consumer onboarding flow. [Workspace policy](https://support.google.com/a/answer/9003945?hl=en), [Google app passwords](https://support.google.com/accounts/answer/185833).
- **Personal Outlook.com/Hotmail:** modern authentication has been required for the affected third-party mail connections since **16 September 2024**. Do not promise an app-password fallback for legacy IMAP/SMTP authentication. [Microsoft consumer notice](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d).
- **Exchange Online:** IMAP/POP basic authentication has been retired. SMTP AUTH is a separate, revised timetable: the January 2026 update keeps behavior unchanged through December 2026; at the end of December it becomes disabled by default for existing tenants, with administrators still able to re-enable it. Microsoft says it will **announce the final removal date in the second half of 2027**. That is not a promise of removal in 2027, nor the superseded March/April 2026 cutoff. Do not base a new product on this temporary exception. [Exchange deprecation documentation](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online), [updated Microsoft announcement](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835), [published Message Center notice](https://mc.merill.net/message/MC786329).

#### iCloud, Yahoo and Spain-specific coverage

- **iCloud:** IMAP/SMTP with an app-specific password is the practical baseline for an independently developed app. Apple also now documents Apple Account authorization for **supported third-party apps**; do not interpret that as proof of a generally available Gmail-like OAuth onboarding program for any Electron developer. [Apple mail settings](https://support.apple.com/en-us/102525), [third-party authorization](https://support.apple.com/en-us/121539).
- **Yahoo:** app passwords remain documented. Yahoo supports mail OAuth, but mail-scope access requires approval rather than simply enabling a self-service developer setting. Its developer guidance describes IMAP/SMTP access, not a broadly interchangeable proprietary mail REST API. [Yahoo app passwords](https://help.yahoo.com/kb/generate-app-password-yahoo-mail-sln15241.html), [developer access](https://senders.yahooinc.com/developer/developer-access/), [OAuth documentation](https://senders.yahooinc.com/developer/documentation/).
- **Spanish providers:** support configurable, strictly validated IMAP/SMTP endpoints rather than promising every historical brand. Movistar still documents `movistar.es`/`telefonica.net` access. Conversely, Orange’s Spanish consumer email service closed on **5 September 2025**—a useful example of why old provider lists are misleading. [Movistar](https://comunidad.movistar.es/kb/correo_movistar/c%C3%B3mo-puedo-acceder-a-mi-cuenta-de-correo-movistar-es-o-telefonica-net/3904425), [Orange closure](https://ayuda.orange.es/particulares/servicios-y-productos-orange/correo-orange/118-cuenta-de-correo-orange).

#### Unified APIs: cost and the custody trade-off

These are published price examples, not all-in quotes:

| Product | Published pricing | Fit for this application |
|---|---|---|
| Nylas | Essentials $15/month including 10 connected email/calendar accounts; $2.25 per additional account | Hosted custody conflicts with local-only credentials |
| Unipile | €49/month for up to 10 accounts; €5/account/month for 11–50 accounts, excluding VAT | Same custody conflict; broad integration convenience |
| Aurinko | $1/account/month below 1 GB transfers; $1.50 below 5 GB; $2 unlimited transfers | Same custody conflict; usage-based account economics |
| EmailEngine | $1,450 or €1,200/year, excluding VAT; unlimited mailboxes and instances under its terms | Self-hostable, but local consumer redistribution needs licensing clarification |

Sources: [Nylas pricing](https://www.nylas.com/pricing/), [Unipile pricing](https://www.unipile.com/pricing-api/), [Aurinko pricing](https://www.aurinko.io/pricing/), [EmailEngine pricing and product terms](https://emailengine.app/).

**Important exception to “aggregators never remove OAuth review”:** Nylas now offers a **Google Shared App** under which Nylas owns the verified OAuth application, assessment and token lifecycle. It is an additional offering on **annual Pro with the Accelerator add-on**, or Enterprise—not included in the $15 entry plan. This can remove the customer’s separate Google app-verification burden for that integration, according to Nylas. It still puts credentials under Nylas’s custody, and it is not blanket permission for arbitrary downstream AI processing. [Nylas Shared App documentation, updated September 2026](https://developer.nylas.com/docs/provider-guides/google/shared-gcp-app/).

For other vendor/auth configurations, establish who owns the OAuth client and exactly which assessment obligations are covered; a vendor certification is not automatically yours. Aurinko, for example, documents configuring your own Google OAuth app. [Aurinko Google setup](https://docs.aurinko.io/authentication/google-oauth-setup).

EmailEngine is **commercial source-available software, not an ordinary permissively licensed open-source library**. It runs a service with Redis; running it on your backend is not “local to the user.” Its standard product terms discuss instances you directly manage, so obtain explicit consumer/OEM redistribution terms before bundling it on customers’ computers. [Repository/license](https://github.com/postalsys/emailengine), [licensing](https://learn.emailengine.app/docs/licensing).

Direct provider access avoids an aggregator’s per-connected-account fee, but not implementation, support and verification costs. Gmail says standard API use has no additional charge, while its current documentation anticipates above-threshold billing later in 2026 with advance notice. Do not promise indefinitely free, unlimited API use. [Gmail quotas and billing threshold](https://developers.google.com/workspace/gmail/api/reference/quota).

### 2. Node/TypeScript library choices

| Library | Assessment as of the research date | Recommended use |
|---|---|---|
| `imapflow` | Active; version 2.2.10, npm updated 7 October 2026; MIT; Node 20+ with bundled types | Preferred new IMAP implementation |
| `nodemailer` | Active; version 10.0.16, npm updated 7 October 2026; MIT-0; Node 20+ | SMTP and MIME composition |
| `mailparser` | Version 3.9.36, npm updated 5 October 2026; MIT; explicitly in maintenance mode | Existing/streaming MIME parsing needs |
| `PostalMime` | Recommended by MailParser’s maintainer for new projects | Evaluate for bounded-message parsing |
| `googleapis` | Officially supported, but explicitly “complete” and in maintenance mode for critical/security fixes; Apache-2.0 | Gmail API client; acceptable despite the maintenance label |
| `@microsoft/microsoft-graph-client` | Official SDK; version 3.0.7, npm updated July 2026; MIT | Optional convenience layer over Graph HTTP |
| `@azure/msal-node` | Official Node authentication library with ongoing releases | Microsoft public-client OAuth and token acquisition |

Sources: [ImapFlow](https://www.npmjs.com/package/imapflow), [Nodemailer](https://www.npmjs.com/package/nodemailer), [MailParser](https://www.npmjs.com/package/mailparser), [Google client maintenance policy](https://github.com/googleapis/google-api-nodejs-client), [Graph SDK](https://github.com/microsoftgraph/msgraph-sdk-javascript), [Graph package activity](https://www.npmjs.com/package/@microsoft/microsoft-graph-client), [MSAL Node](https://www.npmjs.com/package/@azure/msal-node).

Implementation details worth getting right:

- **Node 24 is compatible with the stated ImapFlow/Nodemailer engine requirements.** Pin versions and test packaged Electron builds on both operating systems. Nodemailer 10 includes TypeScript declarations; do not automatically carry over old `@types/nodemailer` advice. [Nodemailer](https://www.npmjs.com/package/nodemailer).
- Prefer ImapFlow to starting a new implementation on `node-imap`; the latter has a materially weaker maintenance history. [node-imap maintenance discussion](https://github.com/mscdex/node-imap/issues/816).
- `simpleParser` buffers a message; the `MailParser` class provides streaming attachment handling. Impose size limits and backpressure. **Neither parsing mail nor converting it to text makes its contents trustworthy; MailParser does not sanitize HTML.** [MailParser documentation](https://nodemailer.com/extras/mailparser).
- Use MSAL’s token acquisition/cache facilities rather than inventing a refresh-token lifecycle. For a small Graph surface, MSAL plus Node’s `fetch` is also a reasonable implementation choice; the Graph SDK is not mandatory.
- Configure mandatory TLS/certificate validation. For Nodemailer, disable arbitrary file/URL content loading and supply only attachment bytes resolved by your trusted service. Never expose a generic “SMTP options” tool to the model. [Nodemailer documentation](https://nodemailer.com/).

### 3. Existing pi packages and adaptable MCP servers

#### pi integration support has changed

The **current official pi documentation includes built-in MCP support**, including stdio servers and tool-call permission hooks. Therefore older claims that “pi has no MCP” are no longer universally correct. Check your pinned pi version: SDK sessions require the relevant built-in extensions to be included explicitly rather than assuming CLI configuration is loaded. A direct extension using registered tools remains the simplest way to expose your deliberately small API. [Current pi MCP documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).

The package search covered npm, GitHub and the pi gallery, including the older gallery domains. The current [pi package gallery](https://pi.dev/packages) surfaces the following concrete options. Activity dates below indicate publication or repository activity—not a security audit or maintenance guarantee.

#### Email-capable pi packages

**`@patimweb/pi-email` — MIT; npm 2.1.0, 22 September 2026.** General IMAP/SMTP email tools, with Microsoft Graph support as well. **Not a safe drop-in for your requirements:** its documented `email_setup` tool accepts IMAP/SMTP passwords, local configuration contains credentials, and the README requires **Node 26+**, not your Node 24 target. It also uses `node-imap`. Borrow protocol/tool ideas, not its credential boundary. [npm package](https://www.npmjs.com/package/@patimweb/pi-email), [gallery documentation](https://pi.dev/packages/@patimweb/pi-email).

**`@e9n/pi-gmail` — MIT; npm 0.3.1, 10 August 2026.** A substantial Gmail API extension: search/read/thread operations, drafts/send/reply, labels, attachments and polling. Uses OAuth through its pi-webserver integration. The current package references the **`@earendil-works` namespace**, so it is not simply an abandoned pre-rename package. Useful functional reference; replace/review authentication storage and enforce your own sending gate. [npm package](https://www.npmjs.com/package/@e9n/pi-gmail).

**`@guquan-2002/pi-gmail` — MIT; repository activity 27 July 2026.** TypeScript Gmail integration with desktop OAuth. Its documented confirmation of writes and refusal to perform them non-interactively are good patterns. However, it requests `gmail.modify` plus send access and stores local token files using filesystem permissions rather than an OS vault. Narrow the scopes and replace storage. [Repository](https://github.com/guquan-2002/pi-gmail).

**`pi-google-services` — MIT; npm 0.1.22, 21 September 2026.** A Go binary/MCP service packaged with pi integration, covering Gmail and other Google services. Uses PKCE and local token files. Its shared OAuth client is explicitly **unverified and capped at 100 users**, with broadly requested Google-service access. That is not a production consumer OAuth identity to inherit. [npm package](https://www.npmjs.com/package/pi-google-services), [gallery/auth documentation](https://pi.dev/packages/pi-google-services?page=).

Also relevant:

- **Mario Zechner’s `@mariozechner/gmcli` and the pi `gmcli` skill:** MIT Gmail CLI plus shell-oriented skill, using a developer-created OAuth project and local token storage. Repository activity January 2026. Useful author-associated reference, but not a narrow credential-isolated mail service. [gmcli](https://github.com/badlogic/gmcli), [pi skill](https://github.com/badlogic/pi-skills/blob/main/gmcli/SKILL.md).
- **`openclaw/gogcli` and `gogcli-mcp-gmail`:** MIT Google-service CLI and MCP adaptation; the CLI has local keyring/encrypted-file credential options. The wrapper’s npm 4.5.2 was published 28 September 2026. These are broad interfaces: expose an allowlist, not generic command execution. [gogcli](https://github.com/openclaw/gogcli), [MCP wrapper](https://github.com/chrischall/gogcli-mcp).

Names such as inter-agent “mail” packages or hosted AgentMail inbox tools should not be mistaken for support for the user’s existing personal mailbox.

#### Notable open-source MCP implementations

These are adaptation candidates, not equally strong recommendations. Repository activity dates are last-push observations.

- **[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)** — **MIT; TypeScript; Gmail API OAuth**, with local credential/token files. Popular reference, but **archived**, with last activity **6 August 2025**. Do not select it as an actively maintained production dependency.
- **[shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp)** — **MIT; TypeScript; Gmail API OAuth**. Local credential files; remote deployments can use environment-supplied OAuth credentials. Last activity **25 November 2025**. Broad tool surface and **telemetry enabled by default** warrant special review.
- **[david-strejc/gmail-mcp-server](https://github.com/david-strejc/gmail-mcp-server)** — **BSD-3-Clause; Python; IMAP/SMTP with password/app-password environment configuration**. Adaptable beyond Gmail. Last activity **10 April 2025**; its obsolete “less secure apps” guidance must not be followed.
- **[chinmay4382/gmail-mcp-server](https://github.com/chinmay4382/gmail-mcp-server)** — **MIT stated in README; Python; IMAP/SMTP with Gmail app password in environment configuration**. Last activity **22 March 2026**. A smaller app-password example, not an OAuth onboarding solution.
- **[mpalermiti/outlook-mcp](https://github.com/mpalermiti/outlook-mcp)** — **MIT; Python; Graph with delegated device-code authentication**, separate login command and OS-keyring storage on macOS/Windows. Explicitly targets **personal Microsoft accounts**. Last activity **19 July 2026**. A particularly relevant Outlook.com reference; still reduce its broad tool set and use your own send approval.
- **[Norcim133/OutlookMCPServer](https://github.com/Norcim133/OutlookMCPServer)** — **MIT; Python; Graph with device-code authentication and local authentication cache**. Last activity **21 July 2025**. More tenant/Microsoft-365-oriented; personal-account compatibility was not established sufficiently to recommend it as your default.
- **[Ixtria/outlook-mcp-hardened](https://github.com/Ixtria/outlook-mcp-hardened)** — **Apache-2.0 with MIT attribution; TypeScript; Graph/OAuth**. Last activity **29 September 2026**. Documents read-only defaults, explicit write/send enablement, egress restrictions, redacted auditing and keychain storage **with a file fallback**. Good design reference, but “hardened” is its own description, not an independent audit; personal-account coverage also needs testing.
- **[stefanskiasan/outlook-mcp](https://github.com/stefanskiasan/outlook-mcp)** — **MIT stated in README; Node/TypeScript; Graph with Microsoft app/environment configuration**, including client-secret settings. Last activity **15 July 2025**. Broad Microsoft-365-oriented surface; do not transplant confidential-client configuration into a distributed public desktop app.

For contrast, **[AgentMail MCP](https://github.com/agentmail-to/agentmail-mcp)** is MIT and showed August 2026 activity, but controls hosted agent inboxes through AgentMail authentication. It does **not** solve access to the user’s existing Gmail/Hotmail account.

**My reuse shortlist:** the pi Gmail packages for tool ergonomics; `mpalermiti/outlook-mcp` for personal-account behavior; `outlook-mcp-hardened` for policy ideas. For the shipped product, own the small adapter/security layer and use the mainstream protocol/auth libraries above.

### 4. Tool and security design

#### The boundary to enforce

```text
User-only authentication and approval UI
                 │
      Local credential / mail service
      ├─ OS-protected token/password storage
      ├─ Gmail / Graph / IMAP+SMTP adapters
      ├─ local drafts and attachment handles
      └─ send-policy enforcement
                 │ narrow, validated IPC
           pi email tools → model
```

Credentials must be absent from tool arguments, results, prompts, exception strings, telemetry and conversation persistence. The service necessarily presents authentication material to the intended provider over TLS; it must not send it to your backend, an aggregator or the model.

**Do not overlook pi’s other capabilities.** If the same agent retains unrestricted shell, file-reading or arbitrary code execution, a “safe email tool” does not prevent it from accessing local token files or bypassing your send gate. Remove or genuinely sandbox those capabilities. A separate process is not, by itself, a security boundary. Third-party extensions execute trusted code and need review as such.

Use macOS Keychain/Windows OS-backed protection, for example through an appropriate encrypted-cache integration or Electron `safeStorage`. On Windows, Electron explicitly states that DPAPI protects against other users—not other applications running as the same user. This is why OS encryption does not replace capability isolation. [Electron safeStorage](https://electronjs.org/docs/latest/api/safe-storage).

#### Minimal tool contract

| Tool | Model-visible input | Model-visible output |
|---|---|---|
| `email_accounts` | None | Opaque account IDs and connection status |
| `email_search` | Account ID, bounded filters, pagination | Message handles, minimal headers and limited snippets |
| `email_read` | Message handle and requested sections | Bounded sanitized content and attachment metadata |
| `email_draft_create` / `email_draft_update` | Recipients, subject, body, approved attachment handles | Local draft ID and preview |
| `email_send` | Draft ID | Approval required, cancelled, accepted or uncertain status |

The model must **not** be able to approve a send by supplying `confirmed: true`.

Recommended enforcement:

1. **Preview every send, reply and forward in trusted UI.** Show the actual sending account, full To/Cc/Bcc addresses, final Spanish text and all attachments.
2. Bind a short-lived, one-use approval to the exact draft contents and attachment bytes. Any edit invalidates approval. Do not permit model-generated blanket approval.
3. Keep a local send-attempt ledger. If the connection fails after possible acceptance, report an **uncertain** result rather than blindly retrying and duplicating an email. Distinguish provider acceptance from delivery or completion of a government procedure.
4. Exclude delete, mailbox rules, forwarding configuration, bulk sends and arbitrary HTTP/SMTP operations initially. Read-only defaults are especially valuable here.
5. Resolve attachments through approved opaque handles, not model-selected filesystem paths or URLs. Limit size, type and recipients. Keep disconnected/revoked accounts unusable immediately.

These recommendations follow the least-privilege and human-approval approach described in [OWASP’s excessive-agency guidance](https://owasp.org/www-project-top-10-for-large-language-model-applications/2_0_vulns/LLM06_ExcessiveAgency).

#### Email content is hostile input—including verification links

Treat headers, bodies, quoted threads and attachments as **untrusted data**, never as authority to change tools, recipients or policies. An email saying “send your passport to this address to continue” is not an instruction from the user.

- Strip active HTML; block remote images, scripts and automatic link opening. Sanitization reduces attack surface but does not eliminate natural-language prompt injection.
- Retrieve only the messages and sections needed for the current procedure. Avoid dumping the inbox into context.
- Independently check destination domains/addresses for public offices; do not trust a sender display name or a link solely because it appeared in an email.
- **Treat OTPs and tokenized verification/reset URLs as secrets too.** Prefer a deterministic local extractor returning an opaque handle, then an approved local browser action restricted to the intended site. The model can learn “verification available” without seeing the code or bearer-token URL. Show the raw value only in user-controlled UI when necessary.
- Minimize exposure of NIE/passport numbers, financial, immigration and health information. Use short retention, protected local caches, redacted logs and explicit disclosure before sending mailbox content to a cloud model. “Local-first” is not itself GDPR compliance; assess processors, transfers and lawful processing. [GDPR principles, privacy by design and security](https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=CELEX%3A02016R0679-20160504).

#### What consumer agents do

**ChatGPT agent** documents confirmations/user takeovers for consequential actions and specifically warns that malicious email can try to exfiltrate a password-reset code. This is a concrete reason to protect both sending and apparently read-only retrieval. [ChatGPT agent documentation](https://help.openai.com/en/articles/11752874-chatgpt-agent).

**Claude’s current Google Workspace connector** supports drafting/sending/replying/forwarding—not just read-only Gmail—and uses approval by default, with organizational controls that can permit different behavior. The pattern to copy is a trusted review boundary, not automatic sending merely because an OAuth grant exists. [Claude Google Workspace connectors](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors).

### Shipping decision

**Ship direct Gmail and Graph adapters, plus a carefully supported IMAP/SMTP fallback, behind your own narrow pi extension.** Start with read/search and local drafts; enable sending only through an immutable human-approved preview. Accept that a local-only app synchronizes while it is running rather than promising an always-on hosted agent.

Before public launch, settle Google’s classification of your **actual LLM data flow**, complete the required OAuth reviews, test refresh/revocation and ambiguous-send recovery on real consumer accounts, and verify that no other agent capability can bypass the credential or approval boundary. Hosted unified APIs become attractive only if you deliberately relax the local-custody requirement—not as an invisible implementation detail.
