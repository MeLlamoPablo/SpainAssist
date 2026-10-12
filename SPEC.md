# SpainAssist

SpainAssist is a local-first, privacy-fist specialized AI agent with the main purpose of interacting with Spanish public administrations (statal, regional or municipal).

Users should be able to **research** and and **execute** their procedures ("trámites") easily and effectively.

- **Research**: the agent should thoroughly research a procedure and explain it in plain words, extremely concise responses, everyday language, free of jargon.

  Accuracy is essential: a mistake in planning may have actual harmful consequences to the user.

- **Execution**: each procedure is an native UI element. Its state can be known at a glance, and context switching is possible. The agent can ask the user for the necessary information and can use credentials provided by the user to autonomously acomplish their tasks with minimal user intervention, ideally none at all.

## Value Proposition

Why would anyone use Spain Assist instead of any existing general purpose agents, like Grok Bot or Instinct?

* **Privacy**: Data stays on the device, except when sent to the user's selected inference provider. SpainAssist stores data and credentials locally.
* **User friendliness**: SpainAssist is designed to have a clean, minimal UX and be usable by non technical users. While assistants like Grok Bot may struggle handling sensitive credentials like Cl@ve or struggle integrating software like AutoFirma, SpainAssist has all the necessary tools built in out of the box.
* **Self improving**: SpainAssist shares anonymous information about learnings and frictions encountered during a procedure. Then assistants of other users can query this database of learnings to ensure a smoother process.

## Core Features

### Flexible Inference Providers

- Sign in with ChatGPT (for Plus/Pro subscribers)
- Credit Vouchers
  - OpenRouter / LiteLLM API keys with capped to x$ of usage issued by voucher server. Conversations are not proxied.
- BYOK
  - Any provider supported by pi
  - Hidden under advanced settings

### Data and Credential management

All data and credentials provided by the user are stored in the app and encrypted, whenever possible, using the secure enclaves provided by the OS. But ideally the user does not need to memorize passwords, we should use TouchID on macOS and whatever the equivalent on Windows. On Linux maybe there's no way around, not sure.

Personal Data and Credentials are native elements in the UI. The user should be able to browse them and delete them (with a warning). We should be transparent on what data does Spain Assist possess over the user.

Personal data stays on the device, except when needed by the user's selected inference provider, including document images for model vision. Document scanning also sends sampled frames directly to OpenRouter's Perplexity Decider V1 27B for document presence and legibility checks, using a global service key separate from vouchers; accepted frames reach the selected extraction provider. If screening errors persist for three seconds, that scan bypasses screening and sends frames directly to extraction. Temporary scan images and debug conversations persist only in development builds. Inference requests go directly to that provider; SpainAssist's backend does not proxy conversations or receive personal data.

Passwords and private signing keys must never be included in model input. Credentials are used only with the services they authenticate against; private signing keys stay on the device. Completing a procedure may send the necessary information to the administration at the user's request. Shared learnings must remain anonymous and scrubbed of personal data.

The agent can access the Data via (mcp?) tools automatically, without user permissions.

As for credentials, the user should be able to configure the secureity level "Ask before use" / "Use automatically". By default Cl@ve should be usable automatically and Certificado Digital should be asked.

### Batteries Included

Spain Assist bundles all dependencies needed to authenticate in govenrment platforms and and produce legal signatures to execute actions within them.

Dependencies should be bundled within the binary, if possible, to avoid conflicting with existing dependencies the user may already have installed.

Here are the most widely used credentials in Spain:

#### Legal document

DNI for Spanish citizens, TIE for non-citizen residents, Passport for non-residents.

Whenever we need basic information from the user, the app should prompt for then to scan their document via webcam or drop a photo.

This basic information will already unlock access to some procedures.

#### Cl@ve

Comes in two flavours:

- **Cl@ve permanente**: an username and password (easiest)
- **Cl@ve móvil**: an app installed on the user's phone scans a QR

Cl@ve can authenticate in most government platforms. However, it cannot produce a legally binding digital signature, and therefore it's insufficient for some procedures.

#### Certificado Digital

This is usually either:

- A X.509 digital certificate stored on a `.p12` file. For most people, it's the Certificado de PPersona Física de la FNMT
- A digital certificate stored in the DNI, which is a smart card

The `.p12` file is easier to manage and for the user to understand. The DNI certificate requires a dedicated smart card reader to operate, so the barrier of entry is higher, but also will work for most people since they already have the DNI. But many people don't remember their password, to change it they would need to phisically go to a Comisaría de Policía Nacional and use the machines to reset it. Therefore, supporting DNI electrónico is a stretch goal only, let's de-scope it from the MVP. Update (2026-10-11): the DNIe no longer needs a reader. The phone app Spain Assist reads it over NFC (CAN + PIN, card held near the phone) and signs the documents the desktop asks for (D14), and it also logs in to sites that ask for a certificate: the DNIe's authentication certificate is used for logins and its signing certificate for documents (D15). The private keys never leave the phone. The CAN and the PIN are typed only in the desktop app, when a signature or login needs them; the desktop keeps the PIN in memory for an hour and sends both only to the paired phone, inside the encrypted channel (D20). The phone only reviews the request and reads the card. Both flows are tested offline with simulated cards; real-card timings and compatibility with the government hosts still need validation.

To bridge digital signatures to the browser, many sites rely on Autofirma (f.k.a. @firma). We replace it instead of bundling it: the agent's browser injects a reimplementation of AutoFirma's JavaScript API and signs in the app, with no Java and no AutoFirma install (see `docs/DECISIONS.md` D4; source of the original: https://github.com/ctt-gob-es/clienteafirma). Ideally, the user doesn't need to interact with Autofirma at all, just with confirmation prompts within Spain Assist.

### Feedback Server

The agent can post feedback for a specific procedure via (mcp?) tools. It should document any frictions encountered and lessons learned. What isn't obvious and will be helpful to know for future agents?

This feedback will be stored in a server side database. It must be fully scrubbed of PII!

Future agents will be able to query it via (mcp?) tools. The database should be well indexed so that the agent doesn't need to filter them all, instead it can query a few keywords and get a list of feedback that may be applicable ("when requesting an apointment for renovating DNI...")

## Stack

_To agents reading this: please critique this stack. Challenge the decisions made, and take it with a grain of salt. Only use what's recommended here if it makes sense._

Monorepo

### Front-end

- Agent Harness: pi (RPC)
  - Why: extremely composable, has what we need
- Desktop app framework: Electron + React (originally Compose Multiplatform; see `docs/DECISIONS.md` D1)
  - Why:
    - Need Windows + macOS + Linux targets
    - One language (TypeScript) with pi and Playwright
    - AutoFirma is reimplemented in TypeScript, so its Java code is no reason to pick the JVM
  - Must have an e2e test suite with mocked backend services: Playwright drives the Electron app with every backend mocked

### Back-end

Two isolated servers:

- Key Management Server
  - Exchanges vouchers for capped inference API tokens
  - In the future it may handle payments sell API tokens / subsriptions
- Feedback Server
  - Ingests and exposes feedback
  - Remote MCP? HTTP API?

I don't care that much about the stack here. Probably Node/TypeScript for easy compatibility. Postgres for database and Docker for orchestration.

### AI

- Rouiting
   - LiteLLM for flexible key management?
   - OpenRouter for simplicity?
   - https://openanonymity.ai/ for privacy + pay with crypto?
- Research
  - I'm thinking Exa for deep research. But we'd need to provide a solution for Log in With ChatGPT
  - Compile a list of official sources e.g. BOE, download them all, have sub agents explore them?Idk seems heavy... Maybe do some AI preindexing ourselves?
  - Any other suggestions?

### Infra

- Everything that can be done as IaC: Terraform
- Maybe Coolify if we need it

## Ideas

Not part of MVP, but can consider for the futrue:

- **Data Scrubbing**: ensure the agent can never see PII. Agent calls tools to fill in data, never sees what it is. It's scrubbed from browser screnshots, documents, etc. Local only models may help.
- **Assistant initiated actions**: to follow up on in-processing procedures or proactively suggest needed procedures ("DNI is about to expire, you should renew it"...)
- **SelfImproving++**: SpainAssist autonomously builds APIs to fetch/scrape data from different Spanish administrations.
  1. When agents encounter friction, they can call a `wish_for_api` tool
  2. Server side agents compile these requests, which must be fully anonymous and free of any PII
  3. Workflows autonomously implement data scrapers (e.g. via Playwright) for the most demanded APIs
  4. Future SpainAssist agents can call them and save time on any data extraction tasks
  5. These APIs are temporary by nature because it's impossible to have humans maintain them. As soon as they stop working, they are disabled and, if wished for again, reimplemented. 
- **Better Cl@ve input**: Cl@ve steps feel native instead of like generic form fields.
  - **Cl@ve permanente**: the password field looks clearly different from ordinary inputs, so the user sees at a glance it's a secure one: it goes straight to the official site, isn't stored, and the agent never sees it.
  - **Cl@ve móvil**: show the login QR code (and its verification code) right in the procedure card, so the user scans it with the Cl@ve app without opening the browser view.

Scanner turn-over follow-up (2026-10-04): after a successful read requests another camera
side/page, forwarding pauses for four seconds. Sampling and screening continue, but buffered
and in-flight frames from before or during this pause are discarded before waiting for a
fresh accepted frame. This gives the user time to turn the document; the extraction agent
still verifies the requested side. `capture_images` requires success but permits an omitted
reason: the previous instruction is restored/retained without blue or legibility updates
until new explicit feedback arrives. The prompt tells the agent to request another capture
with success false and no reason when the user has not yet turned, rotated or brought the document
closer as asked.
Cancellation interrupts the pause immediately. Shared contracts remain unchanged.

Failed-read recapture follow-up (2026-10-04): `capture_images` with success false now clears
buffered frames and invalidates an in-flight old frame before waiting for a fresh accepted
frame (or an unscreened frame after bypass). It adds no fixed delay. Success true still
clears frames and pauses forwarding for four seconds. Background sampling/screening continue.
This prevents immediate reuse of the previous side but does not verify the requested side.
