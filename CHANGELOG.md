# Changelog

What changed in each release of Spain Assist, newest first. Built from the commit history
(`git log vA..vB`); each line names its commits.

## 0.3.0-beta (2026-10-18)

A prerelease: GitHub Releases only, installed apps don't update to it.

### App

- **Windows: Microsoft Store package.** The Windows build also makes an MSIX for the Store, and
  every installer now bundles its Chromium instead of downloading it on first use. On its first
  start, the Store version offers to copy the data of an existing installation. (1be994d,
  6de26e0, 9bd17eb, 8b0d532)
- **Error reports.** Errors (only errors, scrubbed of personal data and home folder paths) go to
  our own GlitchTip server. On by default; you can turn them off in Settings. (4633262)
- **Safer DNIe pairing.** The pairing QR works only once: after the first connection the phone
  uses a secret of its own, so a leaked link can't receive your CAN and PIN. (607029a)
- **DNIe with the phone, more reliable:**
  - The DNIe card asks you to open Spain Assist on the phone, and waits up to 10 minutes for it.
    (a532c98)
  - It says when the phone app or this app is outdated, when the link server can't be reached,
    and why a pairing ended. (e5ca005, 90701f3, b669b78)
  - A server restart no longer ends a pairing or leaves a request stuck. (e499d99, 2903012)
  - DNIe signatures and logins carry the card's full certificate chain. (b9ca7bf)
- **Signatures use SHA-256** when a site asks for SHA-1 and the data is available. (0a26d14)
- **Signing out of ChatGPT** also ends the session at OpenAI. (44769de)
- **The certificate error page** follows the app's language. (fb06c53)
- **The document scanner** screens frames again: its model had been retired, so every scan
  skipped screening. (8e16c21)
- **Settings:** the anonymous data switch is always shown, with clearer copy; the voucher card
  drops the server sentence. (9b9f024, 2c8f4fe, 31d50e9)
- **The assistant's browser** waits for a tab a click opens before looking at the page.
  (6b79547, a271a9f)

### Services and maintenance

- The backend moved to spainassist.es; released apps keep working on the old addresses.
  (feb790e, 3931714, 5b2b5e0, dfe4f8a)
- Relay: caps on total connections and total buffered data, so one burst can't take every
  pairing down. (fa67bf5, dcf0422)
- Feedback server: votes are deleted once they stop counting, as the privacy policy says.
  (26c0943)
- Feature flags can target an OS, CPU and install channel. (0f96927, 471c261, 51a21d8)
- Google Workspace mail for spainassist.es. (8bdd11f, 41ac3bd)
- CI on every push and pull request, and a weekly Chromium security update. (a99e8ee, cfc415d,
  1e76af6, 558545a, 7771abb)
- Agent: scripts' web requests go through the same host checks as page fetches. (a087a65,
  0a7a36e)
- SpainBench eval suite and browser capture mode for building mock sites (development only).
  (aab8d02, c1b2dc0)
- knip, and unused code removed. (40b9fd7)
- Version 0.3.0-beta everywhere except the phone app, which is released on its own
  (`mobile-v*` tags). (d8d29de)

## 0.2.1 (2026-10-13)

### App

- **Web research needs no key.** With your own API key or a custom endpoint, research now uses
  Exa's free tier through its hosted MCP server. An Exa key is optional and only raises the
  limits; Settings no longer warns that it is missing.

### Maintenance

- Version 0.2.1 everywhere, Android version code 4.

## 0.2.0 (2026-10-13)

### App

- **Certificates on more official websites.** The list of sites where your certificate or DNIe
  can log in now covers big municipalities, diputaciones and the shared platforms most town
  halls use for their sede (`dival.es`, `sedelectronica.es`…): 213 entries. (5a77369)
- **Certificates on websites outside that list, with your OK.** The assistant checks the site in
  at least 3 official sources, then asks you; your answer lasts for that procedure. IP addresses,
  local hosts and non-https sites are always refused. (7056cc2)
- **Web research with your own API key or a custom endpoint**, using your own Exa key (added in
  Settings). No Exa key ships in the app. (904699f, e5d841a)
- **Custom endpoints detect what the model can do**: images, reasoning and context size, read
  from the server and editable in Settings. (228c62e)
- **First run follows your system language**: Spanish for es/ca/eu/gl, English otherwise. (dfebf97)
- **Marital status is a dropdown** of the civil statuses Spain recognises. (aa0358e)
- **Dates are filled the Spanish way** (dd/mm/yyyy) from your saved data. (2d37e6b)
- **Document scan:** pick the camera when there are several; the camera step no longer repeats
  the "Upload photo" button. (e29a251, 1a79210)
- **The must-update screen** downloads the new version from spainassist.es instead of GitHub.
  (bef5b4d)

### Services and maintenance

- Feedback admin: maintainers can write new learnings. (75aea4f)
- Voucher admin: codes draw a slashed zero and say they have no O, I, L or U. (9d6c4b2)
- The repository is now `MeLlamoPablo/SpainAssist`; deploys, the deploy key and the webhook were
  moved to it. (f3d9a95, 153fe5d)
- Tests: the providers test waits for the sign-in before cancelling. (564b890)
- Version 0.2.0 everywhere, Android version code 3. (bf11f18)

## 0.1.1 (2026-10-12)

### App

- **DNIe logins:** one phone approval per organisation, and no Touch ID (the phone and the card
  are the second factor); a dropped connection no longer cancels the phone approval.
  (e772649, 3b40668, e96f717, 644b09a)
- **DNIe PIN can be saved** in Mis datos, with shorter PIN form copy. (a8056b7, 731f1e8)
- **Saved documents appear as cards** in the assistant's messages. (6620da1)
- **Linux x64 `.deb`** that updates itself; Windows and Linux lose the File/Edit/View/Window menu
  bar. (0add450, 2097e77, 3dfcbfb)
- **Phone app:** the v2 design on every screen, clearer card copy, debug logging for DNIe flows.
  (fe7926f, 335eef0, 3bd2369, 6b77778)

### Maintenance

- spainassist.es and www point at the Framer website. (3597ade, 3cfbaf5)
- Launch video and research on FNMT's certificate Configurador. (6f7fd52, 666bf25, 58caefd)
- Version 0.1.1. (61592ba)

## 0.1.0 (2026-10-12)

First release. The history before it is squashed into `89c22c9`, so this section summarises the app as it shipped.

- **The assistant** does procedures for you in its own browser: research, forms, appointments,
  signatures and downloads, asking before anything binding.
- **Logins:** Cl@ve Permanente, digital certificates (`.p12`), the DNIe through the phone app
  (CAN and PIN typed only on the desktop, 72-hour pairings), and AutoFirma logins and
  signatures without AutoFirma installed. (c7eaf38, bba8cda)
- **Web research on ChatGPT plans** with OpenAI's hosted web search, at high effort. (ad87b39,
  561fcac, 69bd5f1)
- **Maps:** every eligible place on the map, sorted by distance. (b06736e)
- **Chat links** to parts of the app, and documents in Mis datos link to their procedure.
  (bc93bed, 42778eb, af2ff48)
- **Updates:** auto-update on Windows and a must-update screen driven by the app version.
  (8421cf9, 28eff83, 27e8cfd)
- Releases build installers for macOS and Windows. (2388af5, 76529ec)
