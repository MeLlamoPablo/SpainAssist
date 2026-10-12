# Production checklist

Things to do, or not to undo, before going to production. `master` was squashed on
2026-10-12 into a root commit plus one commit that drops the YubiKey's git-crypt key file. The
public repository will be a copy without the encrypted files or this history.

- [ ] **Keep the git-crypt recovery commit when squashing.** The root commit `89c22c9` (tag
      `yubikey-recovery`) is the only place where git-crypt's key is encrypted to the
      YubiKey GPG key (`93C1AE6AA35C5B388955984612BF2F12483FD814`); the next commit deletes that
      file so everyday unlocks only use the on-device key (`652182…24E6AA2E`). Squash around it
      (keep it as its own commit, or keep a branch or tag pointing at it), or re-add the YubiKey
      user and repeat the add-then-remove pair after the squash. Losing it means the secrets in
      `infra/terraform/terraform.tfvars` and `terraform.tfstate` (voucher pepper, LiteLLM salt
      key, …) depend on one laptop. Recovery steps: `infra/README.md`, "Secrets and git-crypt".
- [x] **Deploy from `master`, not `mvp`.** Done on 2026-10-12: the four Coolify apps build
      `master` (`git_branch` default in `infra/terraform/variables.tf`), and `mvp` is
      deleted.
- [ ] **Deploy the relay and publish the phone app.** `./tf.sh apply` adds the `relay-server`
      Coolify app on `relay.<domain>` (`PRODUCTION_SERVICES.relayServerUrl` and the app's
      `linkHost` already point there; change both with the real domain). Set
      `android_cert_sha256` to the Play App Signing and upload key fingerprints for App Links.
      Publish Spain Assist (`es.spainassist.firma`) on Google Play, signed with the
      release key.
- [ ] **Turn on `dnie-phone` in Unleash production when the phone app is published.** The
      desktop hides every DNIe-with-the-phone feature until then (D14, D15). Enable the
      production environment of the flag at `https://flags.<domain>`; apps pick it up at
      their next launch.
- [ ] **Licence of the phone app.** Decided (D16): our code is MIT, and the Android app as a
      whole is EUPL-1.2 because it bundles jmulticard (`apps/mobile/NOTICE`). Before any APK
      goes out:
      - Publish the app's complete source wherever the APK is distributed, for as long as it
        is: make `Licenses.SOURCE_URL` (`github.com/MeLlamoPablo/SpainAssistant`) public, or
        point it at a source archive of `apps/mobile` per release. Keep encrypted files and
        history out of a public copy.
      - Check the "Licencias de código abierto" screen in the release build, and update
        `AndroidLicenses.kt` when the dependencies change.
      - Decide on ML Kit: proprietary inside an EUPL app is a risk under a strict reading;
        ZXing (Apache-2.0) would remove it.
      - Legal review of the EUPL route (including EUPL-1.1 → 1.2 for jmulticard's headerless
        files) and of the ML Kit question.

- [ ] **Sign the Windows and Linux installers and test every installer.** Packaging already
      builds `sa-sidecar` for the target and ships it in `<resources>/vendor/`, outside the ASAR
      (`apps/desktop/electron-builder.ts`, D17). Sign Windows builds with Azure Artifact
      Signing (`SA_AZURE_SIGNING_ENDPOINT`, `_PUBLISHER`, `_ACCOUNT`, `_PROFILE` plus
      `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) or a `.pfx`
      (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`). electron-builder then signs `sa-sidecar.exe`
      too; check it with `signtool verify /pa`. Linux has no code signing: publish SHA-256
      checksums of the AppImage. `.github/workflows/release.yml` builds macOS arm64, macOS x64
      and Windows x64 on their own runners for every `v*` tag and publishes them, with
      SHA256SUMS.txt, as a GitHub Release. It has no signing secrets yet, and no Linux x64 job.
      Then install the real artifact and test a certificate login
      and the graceful missing-helper behavior there. So far only the unsigned macOS arm64 app
      has been run (2026-10-11); a dev build passing proves nothing about installers.
- [ ] **Buy the Apple Developer account and turn on macOS signing + notarization.** Until then,
      macOS builds are ad-hoc signed, not notarized. Users see "Apple could not verify…". On
      macOS 13–14 they right-click the app and choose Open. On macOS 15 and later they open
      System Settings → Privacy & Security → Open Anyway.
      1. Join the Apple Developer Program ($99/year; an organization needs a D-U-N-S number).
         Create a **Developer ID Application** certificate and export it with its key as a
         `.p12`.
      2. Packaging environment: `CSC_LINK` (the `.p12`, path or base64) and `CSC_KEY_PASSWORD`,
         or `CSC_NAME` for an identity in the keychain. `electron-builder.ts` then drops the
         ad-hoc signature, signs with Developer ID and turns on the hardened runtime with
         `packaging/entitlements.mac.plist` (app) and `entitlements.mac.inherit.plist` (all
         nested code).
      3. notarytool credentials: an App Store Connect API key, with `APPLE_API_KEY` (the
         **path** of the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Or use `APPLE_ID`,
         `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. electron-builder notarizes and
         staples the app.
      4. `sa-sidecar` is nested code in `Contents/Resources/vendor/`. osx-sign signs it with the
         same identity, the hardened runtime and the inherit entitlements. Check that
         `codesign -dv --verbose=4 "Spain Assist.app/Contents/Resources/vendor/sa-sidecar"`
         shows `Authority=Developer ID Application`, `flags=0x10000(runtime)` and a timestamp.
      5. Verify the result: `codesign --verify --deep --strict -vv "Spain Assist.app"`,
         `spctl -a -vvv -t exec "Spain Assist.app"` (`source=Notarized Developer ID`),
         `xcrun stapler validate "Spain Assist.app"`. Repeat them on the app copied from a
         downloaded dmg (only the app is notarized, not the dmg). Then, on that Mac, test the
         camera, the microphone, the Keychain (vault) and a certificate login under the
         hardened runtime.
      6. Then turn on macOS auto-update (D19): allow `darwin` in `updatesSupported`, and merge
         the arm64 and x64 `latest-mac.yml` into one in the release job (each runner writes its
         own), uploading it with the zips and their blockmaps.
- [ ] **Verify DNIe login on real hardware.** Test AUTENTICACIÓN on DNIe 3.0/4.0 and supported
      Android phones, card-moved recovery, repeated handshakes, PIN cache expiry, and approval
      after 30 idle seconds. Verify real-host TLS 1.2 resumption/renegotiation and timings.
      Deploy matching desktop/phone protocol 4 releases together. Check that a CAN scanned
      in Mis datos skips the phone's CAN step on a real DNIe.
- [ ] **Verify the DNIe PIN saved in Mis datos on real hardware (D18).** A right PIN skips the
      phone's PIN step for signatures and logins. A wrong one burns exactly one try: the card
      reports two left, the phone asks with "Era el PIN guardado en tu ordenador…", and Mis datos
      shows "Tu DNIe no aceptó el PIN guardado" and stops sending it. With one try left (two
      wrong PINs typed before, no right one since), the phone asks instead of using it. Use a
      test card or one you can unblock at a police station.
