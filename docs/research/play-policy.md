# Google Play policy and distribution outside Play

Checked 2026-10-30, for the phone app (`apps/mobile`, `es.spainassist.firma`). Release mechanics are
in `store-submissions.md` and `apps/mobile/README.md`, "Releasing".

## Government-related apps

Play's [Misleading Claims](https://support.google.com/googleplay/android-developer/answer/9888077)
policy rejects apps that "falsely claim affiliation with a government entity or to provide or
facilitate government services for which they are not properly authorized", apps that use
"Official" in the title without the rights, and impersonation of government bodies. The
authorization clause targets apps presenting themselves as the channel for a government process
(Google's examples: voting, ID validation), which Google may only approve with written proof from
that body. Signing with the user's own DNIe certificate claims no such role.

[Requirements for apps that communicate government information](https://support.google.com/googleplay/android-developer/answer/9514050)
apply to unaffiliated apps like ours:

- Say clearly that the app doesn't represent a government or political entity.
- Show easy-to-see information sources in the description and store listing, ones users can
  verify on official domains (e.g. dnielectronico.es, firmaelectronica.gob.es).
- Link the privacy policy from the store listing and from inside the app.
- Complete the Government apps declaration (Policy and programs > App content), answering that
  the app isn't developed by or for a government. "Yes" is the path to Play's "Government" badge.

Developers who received this rejection report the same remedy: a clear source and a visible
disclaimer, or an [Advance Notice Form](https://community.kodular.io/t/your-app-contains-content-that-doesnt-comply-with-the-misleading-claims-policy/80739)
with authorization documents. The usual triggers are official-looking names, icons and colours
(coats of arms, police branding, "DNI Oficial"), calling the app "the DNI app", and screenshots
showing government logos, which sede pages carry: choose listing screenshots without them.

### Precedent

Third-party DNIe signing apps are live on Play:
[DNI Digital (DNIe)](https://play.google.com/store/apps/details?id=com.dnie_sign.midni) (PDF
signing and remote signing for a PC or Mac, with a listing that disclaims any link to the Policía
Nacional, the FNMT or other government bodies),
[Firm@](https://play.google.com/store/apps/details?id=com.cqesolutions.firma),
[Firmar DNI 2026](https://play.google.com/store/apps/details?id=com.edatalia.firmar.dni),
[Firmacontudnie](https://play.google.com/store/apps/details?id=validatedid.vidsignerdnie) and
[Certificado Digital con DNI](https://play.google.com/store/apps/details?id=com.dnie_sign.certificado_digital).
"Firma DNI electrónico" (`firmar.dni.electronico`, no disclaimer, last updated 2023) now returns
404, for unknown reasons.

### What the app needs

- In the store description and in the app (next to the licences), a disclaimer such as:
  "Spain Assist es una app privada; no está afiliada a la Policía Nacional, la FNMT ni a ninguna
  administración pública. Fuentes: dnielectronico.es, firmaelectronica.gob.es."
- A privacy policy link in the app: https://spainassist.es/legal/politica-de-privacidad.
- Government apps declaration: not a government app.

## Distribution outside Play

[Android developer verification](https://developer.android.com/developer-verification) checks who
the developer is, not what the app does. Enforcement on certified devices began 2026-09-30 in
Brazil, Indonesia, Singapore and Thailand; the global rollout, Spain included, is announced for
2027 without a date. EU lawmakers have
[questioned it under the DMA](https://globalcompetitionreview.com/article/google-android-verification-change-attracts-growing-scrutiny-eu-politicians);
nothing is decided.

- A verified Play Console account covers apps distributed outside Play too, and Play App Signing
  registers the package automatically ([FAQ](https://developer.android.com/developer-verification/guides/faq)).
  For verified developers, users "won't see a change" when installing an APK.
- Google holds our app-signing key. An APK published elsewhere should be the universal APK Play
  generates and signs (App bundle explorer, or the Publishing API's generated APKs), so it and the
  Play install update each other. An APK signed only with the upload key can't replace a Play
  install.
- It is no hedge against losing the Play account: verification is tied to the same Google
  identity, and Google frames it as accountability "after we take the first one down". We found
  no documentation on what a terminated Play account does to verification.
- Unverified apps need the [advanced flow](https://9to5google.com/2026/08/18/google-gradually-rolling-out-androids-advanced-sideloading-ahead-of-developer-verification/):
  a developer-options setting, a restart, a one-time 24-hour wait and re-authentication. ADB
  installs stay exempt.
- An APK also lacks automatic updates, requires allowing "install unknown apps", and asking users
  to sideload an app that handles their DNIe is what scams do.

Decision: distribute through Play. A cheap complement is attaching Play's signed universal APK to
each `android/vX.Y.Z` GitHub release, next to the source the EUPL requires.

## Closed testing for new personal accounts

Personal developer accounts created after 2023-11-13 must run a closed test with at least 12
opted-in testers for 14 consecutive days before applying for production
([requirements](https://support.google.com/googleplay/android-developer/answer/14151465)).
Organization accounts are exempt. Closed testing itself has no such minimum.
