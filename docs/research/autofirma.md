# AutoFirma inside SpainAssist — research memo

*Date: 2026-10-03 · Scope: how Spanish sedes talk to AutoFirma, and how SpainAssist can sign with the user's `.p12` without the user ever seeing AutoFirma.*

**What was built:** `@sa/signer` (`packages/signer/README.md`): the in-page `AutoScript` /
`MiniApplet` shim, the Node handler behind the `AFIRMA_BINDING` (`__saAfirma`) binding, the
triphase and batch clients, and CAdES, XAdES and PAdES engines in TypeScript (no Java). The README
lists supported formats and known gaps. This memo keeps the external API, the sites' behaviour,
the wire formats, the library findings, the legal reading and the open items.

## TL;DR

- **Trapping the JS API works.** An init script (Playwright `addInitScript`) traps the global
  `AutoScript` and `MiniApplet` objects, and each operation goes to Node through `exposeBinding`.
  The prototype (Playwright 1.63, Chrome) worked against:
  - the official `autoscript.js` 1.10.1, loaded twice and inside an iframe;
  - the minified 1.8.2.1 copy that the AGE *Registro Electrónico General* bundles into its
    Angular app;
  - the VALIDe-style `MiniApplet` alias;
  - the Junta de Andalucía `batchscript.js` pattern, which adds properties to `AutoScript`;
  - a strict CSP (`script-src 'self'`).

  With the trap in place, the page never opens `afirma://`, never connects to `wss://127.0.0.1`,
  and never calls the StorageService or RetrieveService (§2).
- The JS API is small and stable. One `sign(dataB64, algorithm, format, params, ok, ko)` call
  carries everything AutoFirma needs. The `afirma://` URLs, WebSocket messages and
  intermediate-server encryption are transport detail the shim never touches (§1, Appendix A).
- **Firma trifásica is cheap and covers a lot.** If a site asks for `*tri` formats and passes
  `serverUrl=`, the site's server builds the signature; the client only signs each `PRE` blob
  (raw PKCS#1). FIRe always works this way. A full round trip ran against the public demo service
  at `valide.redsara.es/firmaMovil` (§4).
- **Local formats:** CAdES on `@peculiar/asn1-*`; `node-forge` only for reading PKCS#12 (it can't
  add `signing-certificate-v2`). XAdES and PAdES libraries have real gotchas (§5). Running
  AutoFirma's Java engine locally (option D, §8) was not needed: the TypeScript engines shipped.
- **Real sites seen in this research:**
  - REG (`reg.redsara.es`) signs XML with `("SHA512withRSA", "XAdES Detached", null)`. Because of an AutoFirma quirk this actually produces **XAdES Enveloping** (§3.5).
  - FIRe forces the intermediate-server mode and triphase formats, and offers Cl@ve Firma as a cloud alternative.
  - VALIDe signs a file the user picks (`data=null`, `format="AUTO"`).
  - Junta de Andalucía runs recursive "sticky" signing loops.
- **Legal:** a signature our code creates with the user's qualified certificate is the same legal kind of object as one created by AutoFirma with the same `.p12`: an advanced electronic signature based on a qualified certificate, accepted under art. 10.2.a of Ley 39/2015. What matters is the format and policy, plus the user's consent to each signature. No sede can verify which client produced a signature. `checkTime` and the WebSocket "echo" are not client-version checks (§7).

---

## Sources (primary)

| Source | What |
|---|---|
| `ctt-gob-es/clienteafirma` @ `0d7f3cf` (master, 2026-08-22) — <https://github.com/ctt-gob-es/clienteafirma> | `autoscript.js` 1.10.1, AutoFirma protocol (`afirma-simple/.../protocol`), triphase server and clients, signers |
| Release tag `v1.9.2` (2026-05-12) | ships `autoscript.js` **1.9.0** (what most users actually have) |
| *Manual del integrador de Autofirma v1.9* (SGAD) — <https://desarrollo.juntadeandalucia.es/sites/default/files/2026-01/MCF-manual-integrador-ES.pdf> | official API documentation (172 pp.) |
| `ctt-gob-es/fire` — <https://github.com/ctt-gob-es/fire> (`fire-signature/src/main/webapp/public/MiniApplet.jsp`) | how FIRe drives AutoScript |
| REG bundle — `https://reg.redsara.es/es/scripts-IIDJLUBL.js`, `chunk-64DWZJJG.js` (fetched 2026-10-03) | real AGE registry usage |
| VALIDe — <https://valide.redsara.es/valide/firmar/ejecutar.html> (+ `/valide/applet/autoscript.js` v1.9.0) | real usage |
| Junta de Andalucía — `https://ws024.juntadeandalucia.es/afirma-server-html/js/{autoscript,batchscript}.js`, batch manual <https://desarrollo.juntadeandalucia.es/sites/default/files/2026-01/20250811-Autofirma-Manual%20del%20Integraci%C3%B3n%20de%20firma%20por%20lotes.pdf> | regional usage |
| *Política de firma de la AGE v1.9* — <https://sede.administracion.gob.es/politica_de_firma_anexo_1.pdf> (SHA-1 = `G7roucf600+f03r/o0bAOQ6WAs0=`, verified) | mandatory attributes per format |
| Independent reimplementations: `alfem/pyfirma` (Python), `sgomez/rfirma` (Rust/Tauri, very well documented), `aavidad/Autofirma-go` | real-world protocol pitfalls |
| Ley 39/2015 art. 10 — <https://www.boe.es/buscar/act.php?id=BOE-A-2015-10565#a10>; eIDAS 910/2014 — <https://eur-lex.europa.eu/eli/reg/2014/910/oj> | legal basis |

Permalink base for code citations below:
`https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/` (abbreviated as `CA/`).

---

## 1. Public API of `autoscript.js`

### 1.1 Versions

| Version | Where |
|---|---|
| 1.10.1 (`VERSION_CODE = 4`, WebSocket `PROTOCOL_VERSION = 4`) | clienteafirma master (`CA/afirma-ui-miniapplet-deploy/src/main/webapp/js/autoscript.js#L26`) — not yet in a tagged release |
| 1.9.0 | AutoFirma release v1.9.2, FIRe master, VALIDe |
| 1.8.2.1 | Junta de Andalucía, AGE REG (minified inside Angular bundle) |

Differences in the public surface:
- 1.10.1 adds `enableProgressDialog`, `setServiceTimeout`, `getErrorCode` and `getErrorCodeNumber`.
- In 1.10.1 the error callback gets a third argument (`errorCode`). In 1.9.0 it gets only `(type, message)`.
- 1.9.0 adds `setAppName` compared with 1.8.2.1.

### 1.2 Declaration

```js
// CA/afirma-ui-miniapplet-deploy/src/main/webapp/js/autoscript.js#L20-L26, #L5627-L5717
var originalXMLHttpRequest = window.XMLHttpRequest;
var SupportDialog;
var AutoScript = ( function ( window, undefined ) {
    var VERSION = "1.10.1";
    ...
    return { VERSION : VERSION, ..., cargarAppAfirma : cargarAppAfirma, sign : sign, ... };
})(window, undefined);
var MiniApplet = AutoScript;           // legacy alias kept "por compatibilidad"
var Base64 = { encode(input, URL_SAFE), decode(input, URL_SAFE), encodeArrayBuffer, encodeByteArray, ... };
var Cipher = { des(key, message, encrypt, mode, iv, padding), ... };   // legacy DES for intermediate server
```

All of these are top-level `var`s of a classic script, so they become properties of `window`. Pages do use the extra globals: FIRe calls `SupportDialog.enableSupportDialog(false)` and `Base64.encode(...)`. **So let the real script run and trap only `AutoScript`/`MiniApplet`; don't replace the file.**

### 1.3 Exact public members (1.10.1, `#L5627-L5709`)

**Constants**

| Member | Value |
|---|---|
| `VERSION` | `"1.10.1"` |
| `CHECKTIME_NO` / `CHECKTIME_RECOMMENDED` / `CHECKTIME_OBLIGATORY` | `"CT_NO"` / `"CT_RECOMMENDED"` / `"CT_OBLIGATORY"` |
| `KEYSTORE_WINDOWS` `KEYSTORE_APPLE` `KEYSTORE_PKCS12` `KEYSTORE_PKCS11` `KEYSTORE_MOZILLA` `KEYSTORE_SHARED_NSS` `KEYSTORE_JAVA` `KEYSTORE_JCEKS` `KEYSTORE_JAVACE` `KEYSTORE_DNIE` | `"WINDOWS"` `"APPLE"` `"PKCS12"` `"PKCS11"` `"MOZ_UNI"` `"SHARED_NSS"` `"JAVA"` `"JCEKS"` `"JAVACE"` `"DNIEJAVA"` (may be suffixed `":<path>"`, e.g. `"PKCS12:/home/u/a.p12"`) |
| `AUTOFIRMA_LAUNCHING_TIME`, `AUTOFIRMA_CONNECTION_RETRIES` | `2000`, `15` |
| `JAVA_ARGUMENTS`, `SYSTEM_PROPERTIES` | `null` (deprecated) |

**Crypto operations.** All are asynchronous and all invoke AutoFirma.

| Signature | Notes |
|---|---|
| `sign(dataB64, algorithm, format, params, successCallback, errorCallback)` | `dataB64 == null` or `""` → **AutoFirma shows a file chooser** (`CA/afirma-simple/.../ProtocolInvocationLauncherSign.java#L304`). `dataB64` may also be an `http(s)://` URL that AutoFirma downloads (`CA/afirma-core/.../UrlParameters.java#L354`). This only works on the intermediate-server path: in WebSocket mode, autoscript's URL-safe conversion (`/`→`_`) mangles the URL. |
| `coSign(signB64, dataB64, algorithm, format, params, successCallback, errorCallback)` | `dataB64` is **ignored** (comment at `#L700`). FIRe calls it with 7 args. |
| `cosign(signB64, algorithm, format, params, successCallback, errorCallback)` | 6-arg variant |
| `counterSign(signB64, algorithm, format, params, successCallback, errorCallback)` | The manual documents `countersign` (lower case), which **does not exist** in the object. Expose both. `params` may include `target=leafs` (default) or `target=tree`. |
| `signAndSaveToFile(operationId, dataB64, algorithm, format, params, outputFileName, successCallback, errorCallback)` | `operationId` = `"sign"`, `"cosign"` or `"countersign"` |
| `selectCertificate(params, successCallback, errorCallback)` | success `(certificateB64)` |
| `createBatch(algorithm, format, suboperation, extraparams)` | synchronous. Builds `{algorithm, format, suboperation, extraparams: b64(extraparams), singlesigns: []}` |
| `addDocumentToBatch(id, datareference, format, suboperation, extraparams)` | synchronous. Throws on a missing or duplicate `id` or when no batch exists. |
| `setLocalBatchProcess(isLocalBatchProcess)` | `true` = one-step batch signed locally. Results then include `signature`. |
| `signBatchProcess(stopOnError, batchPreSignerUrl, batchPostSignerUrl, certFilters, successCallback, errorCallback)` | Internal name `signBatchJSON`. Success `(resultJSON, certificateB64)`, where `resultJSON = {signs:[{id,result,description?,signature?}]}`. |
| `signBatch(batchB64, batchPreSignerUrl, batchPostSignerUrl, params, successCallback, errorCallback)` | legacy XML batch (`signBatchXML`) |

**File helpers.** These invoke AutoFirma's native dialogs.

| Signature | Notes |
|---|---|
| `saveDataToFile(dataB64, title, fileName, extension, description, successCallback, errorCallback)` | Success gets no args in intermediate mode and `"OK"`/`"SAVE_OK"` over WebSocket. |
| `getFileNameContentBase64(title, extensions, description, filePath, successCallback, errorCallback)` | success `(fileName, dataB64)` |
| `getMultiFileNameContentBase64(title, extensions, description, filePath, successCallback, errorCallback)` | success `(fileNames[], datasB64[])` |
| `getCurrentLog(successCallback, errorCallback)` | 1.10.1: always calls `errorCallback("java.lang.UnsupportedOperationException", …, "AS500010")` |

**Configuration and loading.** All synchronous.

| Signature | Notes |
|---|---|
| `cargarAppAfirma(clientAddress?, keystore?)` and alias `cargarMiniApplet` | Only builds the JS client object. **Does not** launch AutoFirma (manual §6). Picks the transport (§6.1). |
| `checkTime(checkType, maxMillis, checkURL)` | Synchronous XHR to `checkURL` or `document.URL + '/' + Math.random()`, compares the `Date` header. `CT_OBLIGATORY` + skew → `alert()` and `cargarAppAfirma` aborts (`#L596-L654`, `#L1080`). |
| `setKeyStore(ksType)` | |
| `setForceWSMode(force)` | `true` → **intermediate server** (StorageService/RetrieveService). The name is misleading. |
| `setServlets(storageServletUrl, retrieverServletUrl)` | In forced/mobile mode it probes both with `GET ?op=check` |
| `setPortRange(min, max)` | default 49152–65535 |
| `setStickySignatory(sticky)` | keep the selected certificate for later operations |
| `setLocale(locale)` | `es_ES`, `gl_ES`, `va_ES`, `ca_ES`, `eu_ES`, `en_US` |
| `setLocaleMessages(obj)` | internal, not exported in 1.10.1 |
| `setMinimumClientVersion(version)` | sent as `mcv=`. AutoFirma itself rejects older versions. |
| `setAppName(name)`, `setServiceTimeout(ms)`, `enableProgressDialog(bool)` | |

**Errors and utilities**

| Signature | Notes |
|---|---|
| `getErrorMessage()`, `getErrorType()`, `getErrorCode()` (e.g. `"AS500001"`), `getErrorCodeNumber()` | last error, for sites that `catch` synchronous throws |
| `getBase64FromText(plainText)`, `getTextFromBase64(dataB64)` | UTF-8; `\r\n` → `\n` |
| `downloadRemoteData(url, successFunction(dataB64), errorFunction(e))` | XHR GET with `arraybuffer` |
| `isAndroid()`, `isIOS()` | |
| Deprecated: `echo()` → `"Cliente JavaScript"`, `needNativeAppInstalled()` → `true`, `isJNLP()` → `false`, `setForceAFirma()`, `setJnlpService()` | |

**Callback signatures** (`processSignResponse`, `#L2874-L2911`; intermediate server `processSuccessResult`, `#L5195-L5282`)

```js
successCallback(signatureB64, certificateB64, extraData)  // sign / coSign / cosign / counterSign / signAndSaveToFile
//   signatureB64, certificateB64: standard Base64 (URL-safe chars converted back), padding kept
//   extraData: a *string* with JSON, e.g. '{"filename": "x.pdf"}', only when the user picked the file.
//   (The manual says "objeto JSON" and reads extraData.filename; the actual code passes the decoded string.)
errorCallback(errorType, errorMessage, errorCode)          // errorCode only from 1.10
//   cancellation → ("es.gob.afirma.core.AOCancelledOperationException", "Operacion cancelada por el usuario", "AS500001")
```

Error codes are defined in `ErrorCode` (`#L337-L433`). Examples:
- `AS500001` cancelled
- `AS620017` cannot invoke AutoFirma over WebSocket
- `AS620024` timeout waiting for the intermediate server
- `AS600101` / `AS600102` missing servlet URLs

AutoFirma's own error strings arrive as `err-XX:= <8-char code> - <message>`, `SAF_NN…` or `CANCEL`, and autoscript maps them (`#L2626-L2712`).

### 1.4 Legacy `MiniApplet` 1.5 (`miniapplet_JA.js`, Junta de Andalucía)

Same method names: `cargarMiniApplet(base, keystore)`, `sign`, `coSign`, `counterSign`, `signBatch`, `selectCertificate`, `saveDataToFile`, `signAndSaveToFile`, `getFileNameContentBase64`, `getMultiFileNameContentBase64`, `getBase64FromText`, `getTextFromBase64`, `downloadRemoteData`, `setKeyStore`, `setServlets`, `setStickySignatory`, `setLocale`, `getErrorMessage`, `getErrorType`, `getCurrentLog`, `isAndroid`, `isIOS`, `checkTime`, `echo`, `setForceWSMode`.

It also has `isAppletLoaded`, `multiModeSign`, `setTryMiniapplet` and `waitMiniappletLoading`. The shim should provide no-op versions of these four.

---

## 2. Loading, trapping, and pitfalls

### 2.1 How sites load it (observed)

- **Plain `<script src=".../autoscript.js">`**, then inline `AutoScript.cargarAppAfirma()` (manual §5.2, §6.1; demo pages; FIRe; VALIDe).
- **Bundled as an Angular "global script"** (classic `<script defer>`): REG at `reg.redsara.es` ships a minified 1.8.2.1 as `var originalXMLHttpRequest=window.XMLHttpRequest,AutoScript=function(d,M){var N="1.8.2.1",…}(window)`. The app reaches it through `window.AutoScript`:

```js
// https://reg.redsara.es/es/chunk-64DWZJJG.js (fetched 2026-10-03)
configAutosign(){window.AutoScript?window.AutoScript.cargarAppAfirma():console.log("No se pudo cargar Autosign");}
sign(){return new Promise((t,e)=>{window.AutoScript.sign(this.xml,"SHA512withRSA","XAdES Detached",null,
        i=>{this._signed$.next(i),t(!0);}, i=>{this._signed$.next(i),t(!1);});});}
```

- **Through the `MiniApplet` alias** (VALIDe):

```js
// https://valide.redsara.es/valide/firmar/ejecutar.html
MiniApplet.cargarMiniApplet("https://valide.redsara.es/valide/applet");
MiniApplet.setServlets(".../firmaMovil/afirma-signature-storage/StorageService", ".../afirma-signature-retriever/RetrieveService");
MiniApplet.sign(dataB64 /* null → file chooser */, "SHA256withRSA", "AUTO", "mode=implicit", successCallback, errorCallback);
```

- **Wrapped by regional helpers** that *add properties* to the object. Junta de Andalucía's `batchscript.js` does `AutoScript.multiModeSign = function(...){...}`. On desktop it signs N documents recursively with `setStickySignatory(true)` and joins the signatures with `:`.

### 2.2 Trapping technique (validated)

A top-level `var X = …` in a classic script does **not** redefine an existing own property of `window`. GlobalDeclarationInstantiation skips it, and the assignment then calls our setter. So we can pre-define accessor properties from `addInitScript`:

```js
// prototype: scratchpad .../proto/shim.js (abridged)
function trap(name) {
  Object.defineProperty(window, name, {
    configurable: true, enumerable: true,
    get() { return realSeen ? shim : undefined; },   // look absent until the page's own script runs
    set(v) { if (v && v !== shim) { realSeen = true; realObject = v; if (v.VERSION) shim.VERSION = v.VERSION; } },
  });
}
trap('AutoScript'); trap('MiniApplet');
// shim.sign = (dataB64, algorithm, format, params, ok, ko) =>
//   window.__saAfirma({op:'sign', args:{cop:'sign', dataB64, algorithm, format, params}})
//     .then(r => r.ok ? ok(r.signatureB64, r.certificateB64, r.extraData) : ko(r.errorType, r.message, r.code));
```

```ts
// Node side
await context.exposeBinding('__saAfirma', async ({ frame, page }, req) => broker.handle(frame.url(), page.url(), req));
await context.addInitScript({ path: 'shim.js' });
```

Results of the prototype (Playwright 1.63, `channel:'chrome'`, headless; harness in the session scratchpad):

| Test page | Result |
|---|---|
| Official 1.10.1 + `setForceWSMode(true)` + `setServlets` + `checkTime(CT_OBLIGATORY,1)` + `sign(…,"CAdEStri","mode=implicit\nserverUrl=…\nexpPolicy=FirmaAGE")` | Callback received the shim result. `MiniApplet === AutoScript`. `Base64` global intact. **0 network requests** (no `?op=check` probes, no `afirma://`). |
| REG minified bundle (defer) + module script calling `window.AutoScript.sign(…,"XAdES Detached",null,…)` | OK |
| `MiniApplet.sign(null,"SHA256withRSA","AUTO",…)` + `AutoScript.multiModeSign = …` + JSON batch | OK; the extension property persisted |
| Script included twice, inside an iframe; `typeof AutoScript` before load | OK; `'undefined'` before load; binding call reports `isMain:false` |
| `Content-Security-Policy: default-src 'none'; script-src 'self'` | OK. Init scripts are injected via CDP, so CSP doesn't block them. |

### 2.3 Pitfalls and how the shim handles them

1. **Replace, don't wrap.** The real methods depend on internal closure state, for example `createBatch` → `jsonRequest` → `signBatchJSON`. Reimplement *every* method (about 45); a pure-JS reimplementation is easy. Keep only the real globals `Base64`, `Cipher` and `SupportDialog`.
2. **`cargarAppAfirma` is required by the real script** (otherwise `clienteFirma` is `null` and `sign` throws `TypeError`). The shim makes it a no-op and doesn't require it.
3. **`setKeyStore` before `cargarAppAfirma`** throws in the real script. The shim tolerates it.
4. **There is no presence check in the API.** `needNativeAppInstalled()` always returns `true`, and sites can only find out whether AutoFirma exists by running an operation. Nothing pings AutoFirma before an operation. The WebSocket `echo=-idsession=<id>@EOF` → `OK` exchange happens *inside* the real transport and is never visible to the site (`#L2594-L2620`; server side `CA/afirma-simple/.../AfirmaWebSocketServerV4Sup.java#L36`).
5. **`checkTime`** fires a synchronous XHR (which causes a 404 in the site's logs) and may `alert()`. The shim makes it a no-op. Node can compare the `Date` header itself and warn the user or agent.
6. **One operation at a time.** The real client overwrites its callbacks if a site launches two operations (manual §6 forbids it). The shim queues operations per page.
7. **`isAndroid()` / `isIOS()` must return `false`.** Otherwise sites switch to mobile flows.
8. **Third success argument:** pass the JSON *string*, as the code does. If we want to also satisfy code written against the manual (`extraData.filename`), an option is `Object.assign(new String(json), JSON.parse(json))`. That is UNVERIFIED as necessary.
9. **Treat the binding as hostile input.** Every page in the context can call `window.__saAfirma(...)` directly. Take the origin from Playwright's `source.frame` (trusted), never from the page payload. Always ask the human.
10. **When the trap fails:** if a site imports autoscript as an ES module, or declares `let/const AutoScript` (which creates a lexical binding that shadows `window.AutoScript`), the trap is bypassed. None of the sites in this research do that. **Fallback (layer 2):**
    - Override `window.WebSocket` in the init script so that `wss://127.0.0.1:<port>` connections go to an in-page fake that speaks protocol v4 (Appendix A).
    - The launch URL `afirma://websocket?ports=…&v=4&jvc=4&idsession=…` (and `afirma://<op>?…` in intermediate mode) is **observable** through Playwright's `page.on('request')` and CDP `Page.frameRequestedNavigation`, but **not interceptable** with `route()`. Both verified.
    - The page itself does not navigate away.
    - In headed mode, a real AutoFirma installed on the machine could be launched by the OS handler (UNVERIFIED in Playwright Chromium). With layer 1 this can't happen, because the shim never calls `openUrl`.
11. **Some regions use different clients.** Catalonia's AOC "Signador" uses a JNLP or native background app. The Basque Country uses Izenpe's "Idazki" (UNVERIFIED). Neither uses autoscript, so they need separate shims later.

---

## 3. Formats, algorithms, extraParams, policy — and what sites use

### 3.1 `format` values (`CA/afirma-core/.../AOSignConstants.java`, `AOSignerFactory.java`)

| Group | Values |
|---|---|
| Binary | `CAdES` (default), `CAdEStri`, `CAdES-ASiC-S`, `CAdES-ASiC-S-tri`, `CMS/PKCS#7` (legacy) |
| XML | `XAdES`, `XAdEStri`, `XAdES-ASiC-S`, `XAdES-ASiC-S-tri`, `XAdES Detached`, `XAdES Enveloped`, `XAdES Enveloping`, `XAdES Externally Detached`, `XMLDSig*` (legacy) |
| PDF | `PAdES`, `PAdEStri`, `Adobe PDF`, `Adobe PDF TriPhase` |
| Invoices | `FacturaE`, `FacturaEtri`, `Factura-e` |
| Raw | `NONE` (= `PKCS1`, `PKCS#1`) — raw signature of the data; `NONEtri` |
| Office | `OOXML`, `ODF` (legacy) |
| Auto | `AUTO` (case-insensitive) |

`AUTO` behaviour:
- **sign:** the format comes from the data — PDF → PAdES, FacturaE → FacturaE, XML → XAdES, otherwise CAdES (`ProtocolInvocationLauncherUtil.java#L189`).
- **cosign/countersign:** the format comes from the existing signature.

### 3.2 `algorithm` values

Accepted set (`CA/afirma-core/.../UrlParametersToSign.java#L64`): `SHA1`, `SHA256`, `SHA384`, `SHA512`, plus each of those `withRSA` and `withECDSA`. Anything else fails with "Algoritmo de firma no soportado".

AutoFirma builds the final algorithm from the key type, so `SHA512` with an RSA key becomes `SHA512withRSA`. FNMT and DNIe keys are RSA-2048 (`@sa/signer` supports ECDSA too). Observed values: `SHA512withRSA` (REG), `SHA256withRSA` (VALIDe), `SHA512` (manual examples).

**SHA-1 requests (checked 2026-10-18, `master` at `0d7f3cf`).** AutoFirma neither upgrades nor refuses SHA-1: it signs with exactly what the page asked for.

- The protocol accepts `SHA1`, `SHA1withRSA` and `SHA1withECDSA` ([`UrlParametersToSign.java#L66-L77`](https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/afirma-core/src/main/java/es/gob/afirma/core/misc/protocol/UrlParametersToSign.java#L66-L77)), and `ProtocolInvocationLauncherSign` passes the value unchanged to `AOSignConstants.composeSignatureAlgorithmName(algorithm, keyType)` ([#L675-L678](https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/afirma-simple/src/main/java/es/gob/afirma/standalone/protocol/ProtocolInvocationLauncherSign.java#L675-L678)).
- The only reaction is a log warning, and only for the `profile=baseline` extra parameter: `AOSignConstants.isSHA1SignatureAlgorithm` ([#L413-L417](https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/afirma-core/src/main/java/es/gob/afirma/core/signers/AOSignConstants.java#L413-L417)) is checked in CAdES ([`AOCAdESSigner.java#L513-L517`](https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/afirma-crypto-cades/src/main/java/es/gob/afirma/signers/cades/AOCAdESSigner.java#L513-L517)), XAdES ([`XAdESSigner.java#L1346-L1355`](https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/afirma-crypto-xades/src/main/java/es/gob/afirma/signers/xades/XAdESSigner.java#L1346-L1355), which also warns about `referencesDigestMethod` SHA-1) and PAdES ([`AOPDFSigner.java#L725-L728`](https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/afirma-crypto-pdf/src/main/java/es/gob/afirma/signers/pades/AOPDFSigner.java#L725-L728)). Only MD2/MD5 are refused.
- AutoFirma even produces SHA-1 itself for the deprecated "XAdES explicit" mode: it replaces the data by its SHA-1 hash with `mimeType=hash/sha1` ([`ProtocolInvocationLauncherSign.java#L392-L401`](https://github.com/ctt-gob-es/clienteafirma/blob/0d7f3cf01fb65d2be5b245622d2c8f490f36e718/afirma-simple/src/main/java/es/gob/afirma/standalone/protocol/ProtocolInvocationLauncherSign.java#L392-L401)).
- No MiniApplet/AutoScript JavaScript rewrites the algorithm (no SHA-1 handling in the `.js` sources).

**What `@sa/signer` does instead (#17).** When the data is hashed by us or by the site's triphase server, a SHA-1 request is signed with **SHA-256** (the page's spelling is kept: `SHA1withRSA` → `SHA256withRSA`, `SHA1` → `SHA256`). SHA-256 rather than SHA-512 because it is the smallest step away from SHA-1 that every verifier accepts, and it makes CAdES use signing-certificate-v2 without the explicit `hashAlgorithm` (AutoFirma's own SHA-256 encoding). Every algorithm field follows: CMS digest and signature OIDs, ESS signing-certificate v2 instead of v1, XAdES `SignatureMethod`, and PAdES's CMS. An explicit XAdES `referencesDigestMethod` SHA-1 also becomes SHA-256; the AGE policy's published SHA-1 hash (`SigPolicyHash`) stays, since it is a fixed value. SHA-1 is kept, and the requesting host logged at info level (no data or hashes), only when all there is to sign is a SHA-1 hash: `precalculatedHashAlgorithm` (e.g. `clientsigner.js` logins, `apps/mock-sede/public/js/clientsigner.js`), and a CAdES cosign of a detached signature without the data (and any triphase cosign, where we can't tell). A local batch decides per document; a remote JSON batch is upgraded only when no document is a precalculated hash or a cosign. The legacy XML `signBatch` is left as the site wrote it (the algorithm is inside the site's `<signbatch>` document, which its server reads).

### 3.3 `params` / extraParams

`params` is a Java `Properties` text (`key=value` lines separated by `\n`). AutoScript sends it as `properties=<b64url>`, and Java parses it with `Properties.load` (UTF-8). Main keys:

**Common**

| Key | Meaning |
|---|---|
| `mode=explicit\|implicit` | CAdES detached (default) / attached |
| `serverUrl=<…/SignatureService>` | triphase server |
| `expPolicy=FirmaAGE` (or `FirmaAGE18`) | expands to the AGE policy (§3.4) |
| `headless=true`, `mandatoryCertSelection=false` | auto-select if exactly one certificate matches |
| `checkSignatures=true` | validate previous signatures before cosign/countersign |
| `target=leafs\|tree` | countersign target |
| `filenameExts`, `filenameDescription`, … | file chooser hints when `data=null` |

**Certificate filters** (`CA/afirma-keystores-filters/.../CertFilterManager.java#L29-L67`)

- `filters=` — AND across filters separated by `;`.
- `filters.1=`, `filters.2=`, … — OR between the numbered groups.
- `filter=` — alias.
- Filter types: `nonexpired:[true|false]`, `qualified:<serialHex>`, `encodedcert:<b64>`, `thumbprint:<ALG>:<hex>`, `dnie:`, `sscd:`, `signingcert:`, `authcert:`, `ssl:<serial>`, `subject.rfc2254:<expr>`, `subject.contains:<text>`, `issuer.rfc2254:<expr>`, `issuer.rfc2254.recurse:<expr>`, `issuer.contains:<text>`, `keyusage.<digitalsignature|nonrepudiation|keyencipherment|…>:true|false`, `policyid:<oid,…>`, `pseudonym:[only|andothers]`, `disableopeningexternalstores`.
- With no filters, expired certificates are hidden.
- With filters, expired ones are shown unless `nonexpired:` is given.
- (rfirma notes that an unknown filter disables the expiry filter.)

**CAdES** (`CAdESExtraParams.java`): `contentTypeOid`, `contentDescription`, `includeMimeTypeAttribute`, `mimeType`, `policyIdentifier`, `policyIdentifierHash`, `policyIdentifierHashAlgorithm`, `policyQualifier`, `signingCertificateV2`, `includeSigningTimeAttribute` (default `true`), `includeContentHintAttribute` (default `true`), `includeOnlySignningCertificate` (sic), `precalculatedHashAlgorithm` (data *is* the hash → detached), `signerClaimedRoles` (`|`-separated), `signatureProductionCity`, `signatureProductionPostalCode`, `signatureProductionCountry`, `commitmentTypeIndications` plus `commitmentTypeIndication<n>Identifier` / `…CommitmentTypeQualifiers`, `tsaURL`…, `allowSignLTSignature`.

**XAdES** (`XAdESExtraParams.java`)

- `format=XAdES Enveloping|XAdES Enveloped|XAdES Detached|XAdES Externally Detached` — **this decides the variant** (§3.5).
- `referencesDigestMethod` (default SHA-512), `canonicalizationAlgorithm` (default inclusive c14n 1.0).
- `insertEnvelopedSignatureOnNodeByXPath`, `nodeToSign`, `useManifest`, `uri`, `uri<n>`, `md<n>`.
- `mimeType`, `encoding`, `contentTypeOid`, `outputXmlEncoding`.
- `addKeyInfoKeyValue` (default `true` for RSA), `addKeyInfoKeyName`, `addKeyInfoX509IssuerSerial`.
- `xadesNamespace` (default `http://uri.etsi.org/01903/v1.3.2#`), `signedPropertiesTypeUrl`.
- The policy keys, `signerClaimedRoles`, `signatureProduction*`, `commitmentTypeIndication*`, `avoidXpathExtraTransformsOnEnveloped`, `ignoreStyleSheets`, `avoidBase64Transforms`.

**PAdES** (`PdfExtraParams.java`)

- `signatureSubFilter` (default `ETSI.CAdES.detached` = PAdES-BES; `adbe.pkcs7.detached` = PAdES-Basic).
- `signReason`, `signatureProductionCity`, `signerContact`.
- Visible signature: `signaturePage(s)`, `signaturePositionOnPageLowerLeftX/Y`, `…UpperRightX/Y`, `signatureField`, `layer2Text`, `layer2Font*`, `signatureRubricImage`, `visibleSignature=want|optional`.
- `certificationLevel=0..3`, `ownerPassword` / `userPassword`, `allowSigningCertifiedPdfs`, `allowShadowAttack`, `pagesToCheckShadowAttack`, `compressPdf`, `alwaysCreateRevision`, `signReservedSize` (27000), `pdfVersion`, `signingCertificateV2`, `tsaURL`…

### 3.4 Policy "FirmaAGE" (v1.9)

From `CA/afirma-core/src/main/resources/policy.properties` and `ExtraParamsProcessor.java#L137`. Hash verified against the published PDF.

```
FirmaAGE.policyIdentifier=urn:oid:2.16.724.1.3.1.1.2.1.9
FirmaAGE.policyQualifier=https://sede.administracion.gob.es/politica_de_firma_anexo_1.pdf
FirmaAGE.policyIdentifierHashAlgorithm=http://www.w3.org/2000/09/xmldsig#sha1
FirmaAGE.policyIdentifierHash.{XAdES,CAdES,PAdES}=G7roucf600+f03r/o0bAOQ6WAs0=
```

Expansion rules:
- **CAdES:** `mode=implicit` if the data is under 1 MB and no mode was given.
- **XAdES:** `format` forced to `XAdES Detached` unless `XAdES Enveloped`.
- **PAdES:** `signatureSubFilter=ETSI.CAdES.detached` (anything else → error).
- `profile=advanced` is forced.
- `FirmaAGE18` = OID `…2.1.8`, with its own hashes.
- `FirmaAGE19` exists in the properties file, but `isSupportedPolicy` rejects it (rfirma BUG-20).

The policy PDF's mandatory content (§3.3–§3.4 of the policy):
- **XAdES-EPES (1.3.2):** `SigningTime`, `SigningCertificate`, `SignaturePolicyIdentifier` (with `SigPolicyHash`), `DataObjectFormat`. "Internally detached" is preferred; enveloped is allowed.
- **CAdES-EPES:** signed attrs `content-type`, `message-digest`, `signing-certificate(-v2)`, `signing-time`, `signature-policy-identifier`, `content-hints`. Attached is preferred; detached for large data.
- **PAdES:** CAdES detached with `content-type`, `message-digest`, `signing-certificate(-v2)`, `signature-policy-identifier`. **No `signing-time`** (time goes in the PDF `/M`). **No `content-hints`.** Never set `/Cert` in the signature dictionary. Add the `/Extensions <</ESIC <</BaseVersion /1.7 /ExtensionLevel 1>>>>` catalog entry. RSA only.

### 3.5 What major sedes use (evidence level noted)

| Site | Evidence | Call / mode |
|---|---|---|
| **AGE Registro Electrónico General** (`reg.redsara.es`, successor of `rec.redsara.es`) | **verified** in bundle | `sign(xmlB64, "SHA512withRSA", "XAdES Detached", null)`, WebSocket mode. ⚠ AutoFirma reads the XAdES variant **only from extraParams `format`** (`CA/afirma-crypto-xades/.../XAdESSigner.java#L270`, default `XAdES Enveloping`). Top-level `"XAdES Detached"` with `params=null` therefore yields **Enveloping** (rfirma BUG-32, confirmed by reading the code). Be bug-compatible: REG's backend has only ever received Enveloping. |
| **FIRe** (SGAD central component, used by AGE apps for both local and Cl@ve Firma signing) | **verified** in FIRe source | `AutoScript.setForceWSMode(true); setServlets(<fire>/afirma/…Storage, …Retrieve); cargarAppAfirma(<fire>/afirma)`. Formats converted to triphase (`FIReTriHelper.getTriPhaseFormat`) with `serverUrl=<fire>/afirma/<trisign>`. Batch via `createBatch`/`addDocumentToBatch`/`signBatchProcess`. Uses `coSign(ref, null, algo, fmt, params, ok, ko)`. |
| **VALIDe** | **verified** | `MiniApplet.sign(null, "SHA256withRSA", "AUTO", "mode=implicit")`: the user chooses the file, and the result is PAdES/XAdES/CAdES depending on the file. |
| **Junta de Andalucía** (common `autoscript.js` 1.8.2.1 + `batchscript.js`) | **verified** | `doSignBatch(...)`: on desktop, a recursive `AutoScript.sign` loop with `setStickySignatory(true)`. On mobile, `signBatchProcess` against their triphase/batch services. rfirma's first real-site test case was a "login con lote remoto JSON": CAdES, `SHA256withRSA`, `mode=explicit` + `precalculatedHashAlgorithm`, keystore `MOZ_UNI` (site not named). |
| **Seguridad Social** | verified (requisitos page) | Offers *Firma con AutoFirma* (desktop only), *Cl@ve Firma* (cloud), and *Firma sin certificado* (SMS code). Format UNVERIFIED. |
| **PAG / Sede de Administraciones Públicas** | verified (requisitos page) | "Es necesario que tenga instalada la aplicación AutoFirma". Format UNVERIFIED. |
| **Ministerio de Justicia** | search snippet only — UNVERIFIED | AutoFirma required for certificate signing |
| **AEAT** | UNVERIFIED | Most declaration flows use TLS client-certificate selection in the browser plus "Firmar y Enviar", without AutoFirma. Some AEAT help pages only talk about browser certificate selection. Check in the field. |
| **DGT, SEPE** | UNVERIFIED | Cl@ve or certificate login; AutoFirma only in some procedures |

Overall pattern (UNVERIFIED as statistics):
- CAdES, implicit or explicit, sometimes with `expPolicy=FirmaAGE` (it's the manual's main example).
- XAdES over form XML (registries).
- PAdES for user PDFs.
- SHA-256/512 with RSA.
- Triphase wherever FIRe or a mobile-compatible deployment sits in between.

---

## 4. Firma trifásica (triphase) and batch protocols

### 4.1 Single signature

Client: `CA/afirma-crypto-cadestri-client/.../PreSigner.java#L47`, `PostSigner.java#L50`, `AOCAdESTriPhaseSigner.java#L251`, `CA/afirma-core/.../TriphaseDataSigner.java#L53`. Server: `CA/afirma-server-triphase-signer/.../SignatureService.java#L73`, `#L209`, `#L543`, `#L674`.

**Transport**
- `POST <serverUrl>`.
- The body is the raw query string. Java `HttpURLConnection` sends it as `application/x-www-form-urlencoded`, with headers `Accept: */*`, `Origin: <scheme>://<host of serverUrl>` and the default Java User-Agent (`UrlHttpManagerImpl.java#L187`, `#L255`).
- Values are **not** URL-encoded. They are Base64URL tokens, and the server runs `URLDecoder` on them.
- AutoFirma keeps a JVM-wide `CookieManager(ACCEPT_ALL)` (`#L59-L60`). **Keep a cookie jar per operation**, because load balancers with session affinity need it (rfirma ADR-0038).

**Request fields**

| Field | Value |
|---|---|
| `op` | `pre` or `post` |
| `cop` | `sign`, `cosign` or `countersign` |
| `format` | `CAdES`, `XAdES`, `PAdES`, `FacturaE`, `NONE`, `CAdES-ASiC-S`, … (the base name, without `tri`) |
| `algo` | e.g. `SHA256withRSA` (server recomposes it from the key type) |
| `cert` | Base64URL DER certificates, **comma-separated** chain. Only the leaf if `includeOnlySignningCertificate=true` (`TriphaseUtil.java#L43`). |
| `doc` | Base64URL of the *bytes* AutoScript passed as `dataB64`. The server's DocumentManager resolves it. The default `SelfishDocumentManager` treats it as the document itself; custom managers treat it as an ID. |
| `params` | Base64URL of `java.util.Properties.store()` output: the extraParams **minus** `serverUrl`. The server forces `headless=true` and expands `expPolicy`. |
| `session` (post only) | Base64URL of the signed TriphaseData XML |

**Exchange**

```
1. POST  op=pre&cop=sign&format=CAdES&algo=SHA256withRSA&cert=<b64u>,<b64u>&doc=<b64u>&params=<b64u>
   ← 200 text/plain: Base64URL( TriphaseData XML )         or  "ERR-NN: message"
     <xml>
      <firmas>
       <firma Id="9fdd4300-…">
        <param n="PRE">MYIBHzAY…</param>        ← standard Base64 bytes to sign (e.g. DER SET of CAdES signedAttrs)
        <param n="NEED_PRE">true</param>
        <param n="NEED_DATA">true</param>
       </firma>
      </firmas>
     </xml>
2. Client, for EVERY <firma>:  PK1 = Base64( Signature(algo).sign(Base64decode(PRE)) )  ← RSASSA-PKCS1-v1_5
   add <param n="PK1">…</param>; delete PRE unless NEED_PRE=true; keep all other params (HMAC, CACHE_ID…)
3. POST  op=post&cop=sign&format=CAdES&algo=…&cert=…&params=…&session=<b64u(XML)>&doc=<b64u>
   ← "OK NEWID=<b64u>\n"   (SelfishDocumentManager: the signature itself; other managers: a new id/filename)
     or "ERR-NN: …" (e.g. ERR-21 = configuration needed)
4. successCallback(Base64(decode(NEWID)), certB64)
```

- Responses of 8 bytes or fewer count as errors.
- XAdES/PAdES/FacturaE use the same envelope; the server's pre-processor does the format-specific work. In the PAdES client, `doc` is always sent; in the XAdES client it's optional.
- If the server has `verification.key` set, each `<firma>` carries an `HMAC` param over `PRE` + key + cert, which must be passed back untouched.

**Verified 2026-10-03:** round trip against the public demo service `https://valide.redsara.es/firmaMovil/afirma-server-triphase-signer/SignatureService`:
- test certificate, `format=CAdES`, `mode=implicit`;
- the response above came back;
- the returned CAdES verifies with `openssl cms -verify`;
- its signed attrs are `contentType`, `signingTime`, `contentHint` ("Texto plano"), `messageDigest`, `signingCertificateV2` (no `hashAlgorithm` for SHA-256, `IssuerSerial` included), `signatureAlgorithm=rsaEncryption`.

### 4.2 JSON batch (`signBatchProcess`)

`CA/afirma-crypto-batch-client/.../BatchSigner.java#L518`

```
POST <batchPreSignerUrl>   json=<b64u(batch JSON)>&certs=<b64u cert>;<b64u cert>…     (';' separator here!)
  ← {"td": {"format":…, "signs"|"signinfo": [{"id":…,"signid"?:…,"params":{"PRE":…,"NEED_PRE":…}}]},
     "results": [{"id":…,"result":"ERROR_PRE",…}]}
client signs each PRE → PK1 (no extraParams), as above
POST <batchPostSignerUrl>  json=<b64u(batch, updated with presign errors)>&certs=…&tridata=<b64u({"format":…,"signinfo":[{id,signid?,params:{…,PK1}}]})>
  ← {"signs":[{"id":"1","result":"DONE_AND_SAVED"},{"id":"2","result":"DONE_BUT_ERROR_SAVING","description":"…"}]}
```

- Batch JSON: `{algorithm, format, suboperation, stoponerror, extraparams:b64, singlesigns:[{id, datareference, format?, suboperation?, extraparams?:b64}]}`.
- Result states: `DONE_AND_SAVED`, `DONE_BUT_ERROR_SAVING`, `ERROR_PRE`, `ERROR_POST`, `NOT_STARTED`, `DONE_BUT_NOT_SAVED_YET`, `DONE_BUT_SAVED_SKIPPED`, `SKIPPED`, `SAVE_ROLLBACKED`.
- `setLocalBatchProcess(true)`: no servers; the client signs each `datareference` locally and returns `signature` per entry.
- Legacy XML batch (`signBatch`): same idea with `xml=`, `certs=`, `tridata=`. Implemented 2026-10-12 (`xmlBatchSign`) after a real gsede login (municipal sedes) used it to sign a login challenge:
  ```
  POST <presignerUrl>   xml=<b64u(<signbatch>)>&certs=<b64u cert>;<b64u cert>…
    ← TriphaseData XML, plain (<xml><firmas><firma Id="<singlesign Id>"><param n="PRE">…)
  POST <postsignerUrl>  xml=<same>&certs=<same>&tridata=<b64u(TriphaseData with PK1)>
    ← <signs><signresult id="…" result="DONE_AND_SAVED" description=""/>…</signs>
  ```
  The page's success callback gets `(Base64(result log), certificateB64)`. gsede's `clientSigner.js` then downloads each signature from its RetrieveService (`op=get&v=1_0&id=<Id>` → `<b64u cert>|<b64u signature>`, stored by the server's SignSaver) and posts `[{signature, transactionId}, {certificate}]`. Its bundled autoscript 1.8.0 also has `setWaitCertMaxLoops`/`setWaitCertTimeout`, which the official 1.9/1.10 don't.

---

## 5. Node/TypeScript libraries for local signatures

| Need | Library (version · weekly downloads · last activity) | Verdict and gotchas |
|---|---|---|
| Read `.p12` | **node-forge** 1.4.0 · 47M · 2026-09 | **Use it.** Verified: parsed AES-256/PBKDF2, 3DES and legacy RC2-40 PKCS#12 (`openssl pkcs12 -legacy`). Node's `crypto` has no PKCS#12 parser, and OpenSSL 3 needs the legacy provider for RC2. Convert the key to a `KeyObject` and sign with `crypto.sign()`. |
| CAdES-BES/EPES | **@peculiar/asn1-cms + @peculiar/asn1-ess + @peculiar/asn1-schema** 2.10.0 · 16M · 2026-09 | **Use it.** `asn1-ess` has `SigningCertificateV2`, `ESSCertIDv2`, `IssuerSerial`, `ContentHints`. `SignaturePolicyIdentifier` takes about 15 lines with the schema decorators. **Prototype verified with OpenSSL** (implicit and explicit, FirmaAGE). Gotchas: (1) **DER-sort the SET OF signed attributes** before signing, and put them in the same order in `SignerInfo`, because verifiers re-encode them. (2) Follow AutoFirma: drop `ESSCertIDv2.hashAlgorithm` when it's SHA-256; hash the cert with the signature digest; always include `IssuerSerial`; `signatureAlgorithm = rsaEncryption` with NULL; `digestAlgorithm` with NULL params; `content-hints` description from MIME sniffing (`"binary"` / OID `1.2.840.113549.1.7.1` when unknown, per `mimetypes_oids.properties`); `signing-time` as UTCTime. (3) `precalculatedHashAlgorithm`: data = digest, `messageDigest = data`, detached. (4) Cosign: append a `SignerInfo` and reuse the existing `messageDigest` when there's no content. Countersign: an unsigned `counterSignature` attribute over the target's signature value, with **no** `contentType`. |
| CAdES (alt.) | **pkijs** 3.4.1 · 13M · 2026-09 | Also good: `SignedData`, `signedAttrs`, WebCrypto signing. Pick one ASN.1 stack. |
| CAdES (no) | node-forge `pkcs7` | `_attributeToAsn1` only supports `contentType`, `messageDigest` and `signingTime`. You **can't add `signing-certificate-v2`**, which CAdES-BES and the AGE policy require. So it can't produce CAdES-BES. |
| CAdES (maybe) | jsrsasign 11.1.5 · 1.5M · 2026-08 | Has CAdES helpers (`KJUR.asn1.cades`: SigningCertificateV2, SignaturePolicyIdentifier). Older API style. UNVERIFIED. |
| XAdES | **xadesjs** 2.6.8 (moved into the `PeculiarVentures/xmldsigjs` monorepo, active; the old `xadesjs` repo is archived) · 45k | Feasible. Verified: XAdES-EPES "internally detached" (`<AFIRMA><CONTENT>…`) with policy and SigningCertificate, using Node WebCrypto + `@xmldom/xmldom`. **Gotchas seen:** (1) **re-loading a signature that contains `SigPolicyQualifier`/`SPURI` throws** (`XMLJS0018 … SigPolicyQualifier doesn't have required 'parser'`), which breaks verify/cosign of FirmaAGE XAdES (round trip passes without qualifiers); (2) no `DataObjectFormat` by default, but the AGE policy requires it, so add it manually with a Reference `Id`; (3) the `X509IssuerName` came out as `C=ES, O=…, CN=…` (forward order, not RFC 4514), which may trip strict validators (UNVERIFIED); (4) AutoFirma defaults to reproduce: SHA-512 references, inclusive c14n, `KeyValue` included, XPath2 filter transform on enveloped, `Id` naming. |
| XMLDSig | xml-crypto 6.3.2 · 5.7M | XMLDSig only. You would build `QualifyingProperties` by hand. |
| PAdES | **@signpdf/signpdf** 3.3.0 (+ `placeholder-plain` / `placeholder-pdf-lib`) · 280k · 2025-12 | Usable. `SUBFILTER_ETSI_CADES_DETACHED` is supported by the placeholders. **But** the stock `P12Signer` (node-forge) adds `signingTime` and no `signingCertificateV2`, which is wrong for PAdES-BES and the AGE policy. Write a custom `Signer` that returns our CAdES-detached CMS over the ByteRange: no signing-time, no content-hints, with signing-certificate-v2 and optional policy. Add the `ESIC` catalog extension for FirmaAGE. Incremental update matters for already-signed PDFs (cosign): `placeholder-pdf-lib` rewrites the file, and `placeholder-plain` is limited with xref streams (UNVERIFIED in detail). Not prototyped. |
| PDF manipulation | pdf-lib 1.17.1 (no release since 2022) → **@cantoo/pdf-lib** 2.11.1 (active fork) | for visible signature appearances later |

---

## 6. Real-world behaviour

### 6.1 Transports

`cargarAppAfirma`, `#L1072-L1133`:

| Mode | When |
|---|---|
| **WebSocket** (default on desktop) | Modern Chrome/Firefox/Edge/Safari, not iOS/Android, not forced. Launches `afirma://websocket?ports=<3 random 49152-65535>&v=4&jvc=4&idsession=<20 chars>`, then connects to `wss://127.0.0.1:<port>`. AutoFirma's TLS cert is `autofirma.pfx` (pass `654321`), trusted by the installer. |
| **Intermediate server** | `setForceWSMode(true)`, mobile, or very old browsers. Data and results are encrypted (AES-256-CBC via WebCrypto + legacy DES key) and go through the site's own StorageService and RetrieveService. |
| **HTTPS socket** (`AppAfirmaJSSocket`, `https://127.0.0.1:<port>/afirma`) | Old browsers (Firefox ≤ 60) |

FIRe forces the intermediate server. REG, VALIDe and Andalucía use the default.

Two related facts:
- **Chrome 142+ shows a "Local Network Access" permission prompt** for public sites reaching loopback (<https://developer.chrome.com/blog/local-network-access>). That is one more reason not to emulate AutoFirma at the socket level in a real browser. Whether it covers WebSocket is UNVERIFIED.
- **Direct `afirma://` without autoscript:** not seen in this research. `intent://…#Intent;scheme=afirma;package=es.gob.afirma;end` only appears from autoscript on Android Chrome. UNVERIFIED for the long tail.

### 6.2 Other signing paths SpainAssist will meet

- **Cl@ve Firma** (cloud certificates):
  - Certificates are kept centrally by DGP, backed up at GISS.
  - The user needs Cl@ve Permanente at *nivel avanzado* (registered in person or with a certificate).
  - Signing means user + password + an **SMS OTP**, on Cl@ve's own pages. The certificate is created on first use.
  - So many Cl@ve users **can** produce cryptographic signatures without any `.p12` or AutoFirma, on sites that offer Cl@ve Firma (typically through FIRe). Sources: <https://clave.gob.es/dnin/que-es>, <https://clave.gob.es/dnin/realizando-la-firma>.
  - This contradicts the original product spec's statement that "Cl@ve … cannot produce a legally binding digital signature". The agent can drive it like the Cl@ve login, with the OTP relayed by the user.
- **FIRe** (<https://github.com/ctt-gob-es/fire>):
  - The site redirects to FIRe, and the user chooses local certificate or cloud.
  - Local certificate uses AutoScript 1.9.0 (forced intermediate mode, triphase).
  - Cloud uses Cl@ve Firma or other connectors (e.g. FNMT CloudId).
  - Our shim covers the local branch unchanged.
- **Non-cryptographic signature:** art. 10.2.c / 10.4 Ley 39/2015 lets identification act as signature. Examples: Seguridad Social "Firma sin certificado" with SMS; Cl@ve PIN/permanente-based signing in some sedes.
- **VALIDe:** a validation service (signatures and certificates) with a demo signing page. **Use it to check our signatures** with a real FNMT certificate.
- **Autofirma App / "Cliente @firma móvil"** (Android `es.gob.afirma`, iOS id627410001): mobile only, intermediate server, almost always triphase.
- **Regional clients:**
  - AOC **Signador** (Catalonia): redirect + JNLP or native background app.
  - **Idazki** (Izenpe, Basque Country): UNVERIFIED.
  - Both are outside the AutoScript shim.

---

## 7. Legal and validation risks

- **Validity:**
  - eIDAS art. 26 defines an *advanced* electronic signature (uniquely linked, identifies the signatory, created with data under the signatory's sole control, detects later changes).
  - Ley 39/2015 art. 10.2.a admits "firma electrónica cualificada y avanzada basadas en certificados electrónicos cualificados".
  - A CAdES/XAdES/PAdES signature created with the user's own FNMT `.p12` is an advanced signature based on a qualified certificate, **whichever software computes it**. It is not "qualified" (QES), because the key isn't in a QSCD. The same is true when AutoFirma uses that `.p12`.
  - **Acceptance depends on format and policy conformance** (§3.4), not on the client.
- **What sites can check:** they validate the *signature*, often through @firma/VALIDe services: structure, certificate status (OCSP/CRL), policy attributes. **None of the protocols carries a client identity or version to the server.** In detail:
  - `checkTime` only compares the browser clock with the HTTP `Date` header, in JS.
  - The WebSocket `echo` is a liveness handshake between autoscript and AutoFirma.
  - `mcv` (`setMinimumClientVersion`) is enforced by AutoFirma itself.
  - On the triphase and batch HTTP calls, only the default Java User-Agent could hint at the client. Whether any WAF filters on it is UNVERIFIED.
- **The real risks are structural differences** that make a strict back-end reject the signature: a missing `DataObjectFormat`, IssuerSerial DN order, `signing-time` inside PAdES, Enveloping vs Detached expectations (REG). Mitigations: be AutoFirma-compatible and test every format against VALIDe with a real certificate.
- **Consent and liability:**
  - The signature is legally the user's.
  - The agent must **never** auto-approve a certificate signature; a page could inject a prompt.
  - Show a native prompt *outside the browser*, with: origin (frame and top), a rendered preview (PDF/XML/text), format and policy, and the certificate CN; protect it with TouchID.
  - Flag when the content can't be shown (triphase document IDs, precomputed hashes).
  - Log every signature locally (origin, hash of data, time).
- **Licensing:**
  - AutoFirma code is GPL-2.0+ / EUPL-1.1+. Reimplementing protocol compatibility from public behaviour is fine.
  - *Copying* its code, or embedding its Java engine, would bring GPL/EUPL obligations. We do neither.
- **Automation:** `navigator.webdriver` and bot defences on some sedes are a general Playwright risk, not specific to AutoFirma.

---

## 8. Alternatives evaluated

| Option | How | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. JS API shim** (built) | trap `AutoScript`/`MiniApplet`, `exposeBinding` → Node broker | Clean, high-level inputs (data, format, params, callbacks). Independent of transport (WebSocket, intermediate server, mobile). No localhost ports, TLS certs, LNA prompt or encryption. Verified on real bundles. | Bypassed by module-scoped autoscript (none seen). Must reimplement about 45 methods (trivial). | **Primary** |
| **B. Fake AutoFirma at protocol level** | register or catch `afirma://`, run `wss://127.0.0.1:<port>` (v4: echo → `OK`, op URL → `cert\|sig[\|extra]` or `#wait`/`getresult?idsession=`), plus intermediate server (AES/DES, StorageService/RetrieveService `op=put/get`) | Works for any page, including bundled ones | TLS trust for 127.0.0.1, Chrome LNA, port races, fragmentation and binary frames (pyfirma), crypto of the intermediate mode, much more surface | **Fallback only, in-page** (WebSocket constructor override) |
| **C. Bundle real AutoFirma** | install or ship the JRE app; drive it through `afirma://` or its CLI (`sign\|cosign\|countersign\|batchsign\|listaliases\|verify`, `-i -o -format -algorithm -config -store pkcs12:<path> -password -alias -filter`) | 100% parity | Its own UI, process lifecycle, OS protocol registration, key/password handed to Java (argv!), heavy | No |
| **D. Hybrid: AutoFirma's signing core as a local "triphase server"** | Run AutoFirma's pre/post processors (`afirma-server-triphase-signer-core`) locally in a JRE or native-image sidecar; Node only does the PKCS#1 with the key, as rfirma does (ADR-0001) | Byte-level parity including quirks; one code path for remote and local | About 50 MB sidecar or native-image build; GPL/EUPL review | **Not pursued:** the TypeScript engines shipped, so there is no JRE |

---

## 9. Design decisions and open items

The shim, the handler and the format engines are described in `packages/signer/README.md`
(formats, approval and origin rules, known gaps). This section keeps only what it doesn't record.

### 9.1 Components

- **Shim (page world):** replaces every method (§2.3, item 1) and keeps the site's real
  `Base64`, `Cipher` and `SupportDialog` globals. Operations are queued per page (§2.3, item 6).
- **`dataB64` resolution:** `null` → the user picks a file, and the callback gets
  `extraData='{"filename": "…"}'` as a string (§1.3). `http(s)://` → downloaded, but only from
  the calling frame's own origin (AutoFirma downloads any URL).
- **Triphase calls:** one cookie jar per operation and an `Origin` header like AutoFirma's (§4.1).
- **Certificates:** the app's approval picks the certificate (`approveSignature` in
  `apps/desktop/src/main/browser/holder.ts`): every unexpired stored certificate, plus the DNIe
  when a phone is paired. The DNIe signs on the phone through an `ExternalSigningKey`
  (`packages/signer/src/key.ts`). The site's `filters` / `filters.N` extraParams (§3.3) are
  **ignored**. If they are added, `dnie:` should match the DNIe (`dnie.md` §4.1).
- **Not built:** the in-page `WebSocket` override fallback for `wss://127.0.0.1:*` (§2.3, item 10).

### 9.2 Live-smoke targets

- **Conformance:** sign with a real FNMT test certificate and upload the result to **VALIDe**
  (`valide.redsara.es`) for format and policy reports. Not done yet.
- **Live smoke:** the VALIDe demo page and the public triphase service
  `…/firmaMovil/afirma-server-triphase-signer/SignatureService`. By hand only: automated tests
  never contact real government sites.

### 9.3 Open questions

- AEAT, DGT and SEPE flows (§3.5): capture real calls when the agent runs them (log
  `format`/`algorithm`/`params` keys, never data).
- Electron-hosted browser (instead of Playwright Chromium): there, use `session.setPreloads` plus
  a main-world injection, and block `afirma:` in `will-frame-navigate`.

---

## Appendix A — wire formats (for the fallback and for debugging)

**WebSocket v4** (`CA/.../autoscript.js#L2047-L2981`; `CA/afirma-simple/.../AfirmaWebSocketServerV4Sup.java`, `WebSocketServerOperationHandler.java`)

```
launch : afirma://websocket?ports=P1,P2,P3&v=4&jvc=4&idsession=<20 [0-9a-zA-Z]>[&dlgload=false]
connect: wss://127.0.0.1:P{1..3}, after 3 s, every 2 s, 15 retries
JS → AF: echo=-idsession=<id>@EOF                     AF → JS: OK
JS → AF: afirma://sign?[mcv=…&]op=sign&idsession=<id>&algorithm=SHA512&format=CAdES
         &properties=<b64u(params)>&ksb64=<b64u(keystore)>&sticky=false[&resetsticky=true]
         [&appname=…]&dat=<b64u(data)>[&servicetimeout=ms]
         (op=signandsave adds cop=…&filename=…; op=selectcert; op=batch adds batchpresignerurl,
          batchpostsignerurl, needcert=true, jsonbatch=true[, localBatchProcess=true]; op=save/load: title, exts, desc, filename…)
AF → JS: "<b64u cert>|<b64u signature>[|<b64u {"filename": "…"}>]"   | "#wait" → JS polls "getresult?idsession=<id>" every 2 s
         | "CANCEL" | "err-NN:= <CODE> - <msg>" | "SAF_NN…" | "MEMORY_ERROR" | "NULL"
         selectcert → "<b64u cert>";  batch → "<b64u result JSON>|<b64u cert>";  save → "OK"/"SAVE_OK";  load → "name:b64|name:b64"
```

The `properties`, `ksb64` and `dat` values are not URL-encoded.

**Intermediate server** (`#L4189-L5624`; AutoFirma `IntermediateServerUtil.java`)

Launch URL:
```
afirma://<op>?jvc=4[&mcv]&<op params>&ver=4&op=<op>&id=<20-char id>&appname=<host>
  &key=<8-digit DES key>&cipher=<b64({"algo":"AES","key":b64,"iv":b64,"legDes":"…"})>&stservlet=<…>&aw=true
```

If the URL is longer than 2000 chars:
- the page POSTs `op=put&v=1_0&id=<fileId>&dat=<encrypted b64u of XML <op><e k=".." v=".."/>…</op>>` to StorageService;
- it then launches `afirma://<op>?fileid=…&rid=<id>&rtservlet=…&stservlet=…&key=…&cipher=…`.

The page polls RetrieveService with `op=get&v=1_0&id=<id>&it=<n>`, every 3 s, 10 times:
- `err-06` = not yet;
- `#wait` = AutoFirma alive, reset the counter;
- the result is `a|b|c`, each part AES-256-CBC/PKCS7 Base64URL (legacy DES: `<pad>.<b64u>`).

AutoFirma stores the result with `op=put&v=1_0&id=<id>&dat=…`. The StorageService and RetrieveService answer `?op=check` with 200.

## Appendix B — UNVERIFIED items (consolidated)

- How AEAT, DGT and SEPE (and in detail Justicia) actually sign.
- Which AGE sedes sit behind FIRe.
- Idazki details.
- Whether Chrome LNA applies to `wss://127.0.0.1`.
- Whether a headed Playwright Chromium triggers the OS `afirma://` handler.
- Whether `@signpdf` placeholders handle incremental updates on signed or xref-stream PDFs.
- jsrsasign CAdES quality.
- Whether strict validators reject xadesjs's forward-order `X509IssuerName`.
- WAF filtering on User-Agent for triphase calls.
- Whether REG's backend would also accept a true Detached signature (we recommend the Enveloping output AutoFirma produces).
