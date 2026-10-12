# Identity document fields in agent forms

Implemented 2026-10-04. The desktop catalogue in `apps/desktop/src/identity-documents.ts`
controls scan eligibility and persistence. Use a canonical `vaultKey` on agent form fields;
without it, an exact canonical field `key` also works. Labels are not matched heuristically.

The scan button appears when any visible, requested, supported field is empty (including
optional fields). The centered button names the applicable document, preferring DNI/TIE,
then driving licence, then passport when several can supply missing fields. A separator
below reads “o rellena manualmente” (English: “or fill in manually”).
Whitespace counts as empty. Existing defaults/saved values count as answers.
Secrets, file uploads, boolean inputs, map choices and unrelated personal data do not trigger it.
The existing camera/photo dialog saves results, then fills missing visible answers in the form.
Typed answers survive. Selection values must match an offered value/label; provinces use the
existing province matcher. Scanning does not submit the form. Cancel/failure preserves answers.
After a successful save, the scan button is replaced by a green check and the number of
details saved to "Mis datos" from the scan (all of them, not only the fields this form uses;
fields the vault refused aren't counted). Missing fields stay editable.

## Printable field catalogue

This lists text suitable for form entry. Portraits, handwritten signatures, chip data,
fingerprints and machine-readable check digits are outside this text-input feature.
A listed field is possible, not guaranteed on every version: extract only visible text.

| Document | Identity fields | Document-specific fields | Other printed fields |
| --- | --- | --- | --- |
| DNI | Given names, first/second surname, birth date, sex, nationality, birthplace | DNI number, support number, issue date, expiry (including permanent), issuing team (EQUIPO), CAN (DNI 3.0 and later) | Parent names; address street/house/floor/door, municipality, province, country if printed. **No postal code.** |
| TIE | Given names, surname(s), birth date, sex, nationality, birthplace where printed | NIE, support number, issue date/expiry | Printed address components, permit type, remarks. Do not infer postal code/country or work rights. |
| Passport | Given names, surname(s), birth date, sex, nationality, birthplace where printed | Passport number, issue date, expiry, issuing authority, separate personal identifier where printed | Country/version variations exist. Do not infer a second surname, address or parent names. |
| Spanish driving licence | Given names, surname(s), birth date and birthplace | Card issue/expiry (4a/4b), issuing authority (4c) | Category rows: code (9), first issue date (10), expiry (11), restriction codes (12); remarks (13/14). The licence number (5) is read but not kept: it is the holder's DNI (Spanish citizens) or NIE (foreign residents). Do not infer nationality, sex or current address. |

Contact details, marital status, IBAN and Social Security number are not scan candidates.
A document address is its printed address, which may be outdated; it is not proof of current
residence. Fields genuinely absent or unreadable remain empty for manual entry.

## Keys

Common fields use existing shared keys: `givenName`, `surname1`, `surname2`, `birthDate`,
`sex`, `nationality`, `birthPlace`, `fatherName`, `motherName`, and existing `address*` keys.
Document fields are standard keys in `@sa/shared`, one group per document (`dni*`, `tie*`,
`passport*`, `drivingLicence*`), so several documents coexist and "Mis datos" shows each in its
own section. `documentPersonalInputs` maps the scanner's generic fields (`documentNumber`,
`documentRemarks`…) to the scanned document's keys and drops what that document doesn't keep:

- DNI: `dniNumber`, `dniSupportNumber`, `dniIssueDate`, `dniExpiry`, `dniIssuingTeam` (the code
  printed after EQUIPO), `dniAccessNumber` (the CAN).
- TIE: `tieNumber` (the printed NIE), `tieSupportNumber`, `tieIssueDate`, `tieExpiry`,
  `tiePermitType`, `tieRemarks`.
- Passport: `passportNumber`, `passportIssueDate`, `passportExpiry`,
  `passportIssuingAuthority`, `passportPersonalNumber`.
- Driving licence: `drivingLicenceIssueDate`, `drivingLicenceExpiry`,
  `drivingLicenceIssuingAuthority`, `drivingLicenceCategories`, `drivingLicenceRemarks`.
  `drivingLicenceCategories` is a JSON list of `{category, issueDate?, expiry?, restrictions?}`
  rows (`LicenceCategories` in `@sa/shared`); the scanner
  returns the rows as an array and "Mis datos" shows them as a table. There is no licence
  number key: the DGT uses the holder's DNI/NIE as the licence number (a NIE→DNI change needs a
  duplicate licence), so forms use `dniNumber` or `tieNumber`. A licence scan saves box 5 as
  `dniNumber` (8 digits + letter) or `tieNumber` (X/Y/Z + 7 digits + letter) only while neither
  is saved: an older licence can still show a NIE that a DNI has replaced.

Only passports and driving licences keep an issuing authority: DNI/TIE are always issued by the
Spanish police. The DNI keeps its issuing team code instead (`dniIssuingTeam`).

The CAN (card access number, `dniAccessNumber`) is the six digits at the bottom right of the
front of a DNI 3.0 or 4.0, labelled CAN; older DNIs don't print one and the scanner marks it
unavailable. Forms never ask for it: it only unlocks the chip over NFC, so the desktop sends it to
the phone app (SpainAssist Firma) with each request and the phone skips its CAN step. It is
kept from agents (`AGENT_HIDDEN_PERSONAL_KEYS` in `@sa/shared`: not in `vault_read`, `vault_save`,
`ask_user` keys, `browser_fill_from_vault` or forms) and scrubbed from learnings like other vault
values. Mis datos shows and edits it in the DNI group ("Número CAN"); the vault accepts six
digits. A TIE also prints a CAN, but the phone app only reads DNIe cards, so it isn't kept.
The card type is `TIE`; its `documentNumber` is the printed NIE.
NIE certificates and EU registration certificates are not TIE cards. Official forms requesting
identifier type DNI/NIE use NIE for `tieNumber`, rather than the physical card type TIE.

Scans save with `vault.setPersonalPartial`: a field the vault refuses is dropped and reported
(toast, and `vaultErrors` in the form response the agent receives) instead of losing the whole
scan.

Each licence category is one row with its own first issue date, expiry and printed restriction
codes (columns 9–12). Do not conflate card dates and category dates.

## Sources and limits

- [DNI content, RD 255/2025, article 12](https://www.boe.es/eli/es/rd/2025/04/01/255):
  visible identity, validity, support number, address, birthplace, parent names and unit number.
- [Spanish licence layout, RD 818/2009, annex I](https://www.boe.es/buscar/act.php?id=BOE-A-2009-9481#ani):
  numbered fields on each side; category dates and coded restrictions are distinct.
- [PRADO TIE specimen ESP-HO-03001](https://www.consilium.europa.eu/prado/es/ESP-HO-03001/index.html).
- [PRADO Spanish passport ESP-AO-05001](https://www.consilium.europa.eu/prado/en/ESP-AO-05001/index.html).
- The current vision flow reads printed text. The obsolete desktop OCR proposal and the
  local MRZ library were removed.

Offline tests validate eligibility, visibility, prefilling and document storage isolation,
and driving-licence side requirements. New document fields/licence extraction accuracy still
needs real-world evaluation; automated checks use only synthetic data and mocked providers.


## Scanner validation

The scanner now distinguishes personal fields and document fields in `apps/desktop/src/scanner.ts`.
Its per-type extraction profiles must map completely into the persistence catalogue above.
Offline tests check every allowed field against that catalogue. Prompt/tool schemas and host
validation use the extraction profiles, so unsupported combinations are corrected during the
scan rather than silently discarded at save time. DNI postal-code removal remains an explicit
exception for misread street numbers; postal lookup runs after extraction.
