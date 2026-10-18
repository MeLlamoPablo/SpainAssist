# Identity document fields in agent forms

Implemented 2026-10-04. The desktop catalogue in `apps/desktop/src/identity-documents.ts`
controls scan eligibility and persistence. The vault keys are in `@sa/shared` (`vault.ts`:
`documentPersonalInputs`, `AGENT_HIDDEN_PERSONAL_KEYS`, `LicenceCategories`). The scanner's
document profiles are in `apps/desktop/src/scanner.ts` and its field and document rules in
`apps/desktop/src/main/scanner/rules.ts`. This memo keeps the
form behaviour, the printable-field catalogue and the reasons behind the keys.

## The scan button in agent forms

Use a canonical `vaultKey` on agent form fields; without it, an exact canonical field `key` also
works. Labels are not matched heuristically.

- The button appears when any visible, requested, supported field is empty (including optional
  fields). Whitespace counts as empty; defaults and saved values count as answers.
- Secrets, file uploads, boolean inputs, map choices and unrelated personal data don't trigger it.
- It names the applicable document, preferring DNI/TIE, then driving licence, then passport when
  several can supply missing fields. Below it: "o rellena manualmente" ("or fill in manually").
- The camera/photo dialog saves results, then fills missing visible answers. Typed answers survive.
  Selection values must match an offered value or label; provinces use the province matcher.
  Scanning never submits the form, and cancel or failure keeps the answers.
- After a successful save, the button becomes a green check with the number of details saved to
  "Mis datos" (all of them, not only this form's; fields the vault refused aren't counted).

## Printable field catalogue

Text suitable for form entry. Portraits, handwritten signatures, chip data, fingerprints and
machine-readable check digits are outside this feature. A listed field is possible, not
guaranteed on every version: extract only visible text.

| Document | Identity fields | Document-specific fields | Other printed fields |
| --- | --- | --- | --- |
| DNI | Given names, first/second surname, birth date, sex, nationality, birthplace | DNI number, support number, issue date, expiry (including permanent), issuing team (EQUIPO), CAN (DNI 3.0 and later) | Parent names; address street/house/floor/door, municipality, province, country if printed. **No postal code.** |
| TIE | Given names, surname(s), birth date, sex, nationality, birthplace where printed | NIE, support number, issue date/expiry | Printed address components, permit type, remarks. Do not infer postal code/country or work rights. |
| Passport | Given names, surname(s), birth date, sex, nationality, birthplace where printed | Passport number, issue date, expiry, issuing authority, separate personal identifier where printed | Country/version variations exist. Do not infer a second surname, address or parent names. |
| Spanish driving licence | Given names, surname(s), birth date and birthplace | Card issue/expiry (4a/4b), issuing authority (4c) | Category rows: code (9), first issue date (10), expiry (11), restriction codes (12); remarks (13/14). The licence number (5) is read but not kept (below). Do not infer nationality, sex or current address. |

Contact details, marital status, IBAN and Social Security number are not scan candidates. A
document address is its printed address, which may be outdated: it is not proof of current
residence. Each licence category is its own row with its own dates and restrictions: don't
conflate card dates and category dates.

## Why the keys look like this

- **No licence-number key.** The DGT uses the holder's DNI/NIE as the licence number (a NIE→DNI
  change needs a duplicate licence), so forms use `dniNumber` or `tieNumber`. A licence scan saves
  box 5 as `dniNumber` (8 digits + letter) or `tieNumber` (X/Y/Z + 7 digits + letter) only while
  neither is saved: an older licence can still show a NIE that a DNI has replaced.
- **Only passports and driving licences keep an issuing authority:** DNI and TIE are always issued
  by the Spanish police. The DNI keeps its issuing team code instead (`dniIssuingTeam`).
- **TIE vs NIE.** The card type is `TIE`; its `documentNumber` is the printed NIE. NIE certificates
  and EU registration certificates are not TIE cards. Official forms asking for identifier type
  DNI/NIE use NIE for `tieNumber`, not the physical card type.
- **TIE CAN not kept:** a TIE prints a CAN too, but the phone app only reads DNIe cards.

## Sources and limits

- [DNI content, RD 255/2025, article 12](https://www.boe.es/eli/es/rd/2025/04/01/255):
  visible identity, validity, support number, address, birthplace, parent names and unit number.
- [Spanish licence layout, RD 818/2009, annex I](https://www.boe.es/buscar/act.php?id=BOE-A-2009-9481#ani):
  numbered fields on each side; category dates and coded restrictions are distinct.
- [PRADO TIE specimen ESP-HO-03001](https://www.consilium.europa.eu/prado/es/ESP-HO-03001/index.html).
- [PRADO Spanish passport ESP-AO-05001](https://www.consilium.europa.eu/prado/en/ESP-AO-05001/index.html).
- Extraction accuracy for the document fields, especially licences, is unmeasured on real
  documents; automated checks use only synthetic data and mocked providers.
