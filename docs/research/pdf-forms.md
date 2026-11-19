# Filling in PDF forms

How the agent fills in a PDF form the user has (an EX-15, a modelo 145, a town hall's
instancia) with no website: `api.documents.fill`. Researched and built 2026-11-19.

## What real forms look like

Four current official forms, inspected with pdf-lib (EX-15 and EX-17 from inclusion.gob.es,
AEAT's modelo 145, a consulate's NIE form):

- All four are fillable (AcroForm, 70–120 fields), none XFA, none encrypted.
- Their field names are meaningless (`Texto1…Texto58`, `Casilla de verificación27`,
  `Textfield-1`, `x`, `H`), and the tooltips (`/TU`) can be wrong (`Provincia` with the tooltip
  "Nº Piso_Row_1", `2 Apellido` with "1er Apellido").
- Guessing a field's label from the nearest printed text works most of the time and fails in
  the places that matter: EX-15's day, month and year of birth are three fields whose nearest
  text is the footnote mark "(2)"; checkbox labels sit left of the box in one group and right of
  it in the next.

So neither names nor heuristic labels reach the agent. It reasons from the page it sees.

## The contract: look, then point

The agent works like a person with a pen:

1. `api.documents.read(id, { page })`: the page's text and its image (1600 px on the longer side;
   `image.width`/`height` give the size), which the agent looks at with `api.output.image`.
2. `api.documents.fill(id, values)`: each value is `{ page, x, y, text }` or
   `{ page, x, y, check: true }`, with x, y in pixels of that page's image: the middle of the box,
   line or checkbox where it goes.
3. fill returns the filled pages' images. The agent checks them; to correct anything it fills the
   copy again with all the values.

Pointing at an image it is looking at is what models are trained for (computer use). What they
are bad at is computing coordinates in a space they cannot see (PDF points from a text layer),
which this contract never asks for.

## Where a value lands

`fillPdf` (`@sa/signer`, `src/fill.ts`) converts the point to the page's coordinates and puts
the value in what the PDF's geometry has under it, never by name or label:

1. **A form field** (an AcroForm widget containing the point, ±3 pt): text fields get the
   text; checkboxes and radio buttons are ticked, and a tick that misses by up to 10 pt snaps
   to the nearest one; dropdowns pick the option that matches. The field stays editable.
2. **An empty box**: the nearest borders above, below, left and right of the point (rectangles
   of the page's content, or table cells drawn as four hairlines, as Word does), when they close a
   box at most 48 pt high with no printed text inside. Text is written left-aligned, sized to fit;
   a tick is an X centred in it (also in a printed □).
3. **A line to write on**: a horizontal rule, a run of underscores or dot leaders, just under
   the point: the text sits on it, centred on the point.
4. **Otherwise** the text is centred on the point.

The borders come from pdf.js's operator list (`constructPath` with the CTM tracked through
`save`/`restore`/`transform` and form XObjects; widgets' own appearances skipped). "No printed
text inside" is what keeps a whole row ("PASAPORTE ……… N.I.E.") inside a section's frame from
passing for an empty box.

Details that matter:

- Each fill starts from the blank, which stays in Mis documentos; the copy (`filledFrom`) is
  replaced in place on the next fill. Corrections are declarative, with no undo to design.
- Ticks in the form's own checkboxes are redrawn with pdf-lib's vector tick. The forms draw a
  ZapfDingbats glyph, which pdf.js without its standard font data (our page images) leaves out,
  so the agent would see an empty box after ticking it.
- Text Helvetica can't encode (Ł, ș, Cyrillic: foreigners' names on immigration forms) uses
  Noto Sans, subset into the PDF.
- Hybrid XFA forms lose the XFA (else Acrobat shows the XFA's empty values); XFA-only forms
  (their pages are a "please wait" placeholder) are refused with "This PDF can only be filled
  in with Adobe Acrobat Reader". The agent never needs to know what XFA is.
- Signed PDFs are refused: filling them would break the signature. The order is fill, then
  `api.documents.sign`.

## The eval

Three on-demand fixtures (`tools/eval/src/fixtures/pdf-forms.ts`): the real EX-15 in Mis
documentos, fillable (`pdf-ex15`) and flat (`pdf-ex15-plano`: the Ministerio's own version without
a form, so values must land on dotted lines, □ glyphs and table cells; until 2026-11-19 a copy of
the fillable one with its AcroForm removed), and not in the documents at all (`pdf-ex15-web`: the
agent downloads it from SpainBench's `inclusion-es`, the Ministerio de Inclusión's "Modelos
generales", or follows the Policía's page on the NIE, `policia-es`, which links it). The blank PDFs are
SpainBench's (`forms/`), pinned by SHA-256. The persona is a Polish citizen on a stay in Madrid
(Wiśniewska: the Unicode path), with no second surname, no NIE and no representative.

Scored, each worth one point and read as a person reads the printed page (the field's value, or
text drawn inside the field's box on the flat copy): 19 text values, 6 tick groups (the right box
and no other), 4 parts that must stay empty (the NIE, the second surname, the representatives,
the signature box), the final message linking the copy. Required: a filled copy exists.

### gpt-6.2-sol (Codex), 2026-11-19

Runs `pdf62-*` in the eval runs folder; answerer gpt-6.2-sol too.

| Run | Fixture | Score | Requests | Time | Fills |
| --- | --- | --- | --- | --- | --- |
| `pdf62-ex15-1` | fillable | failed (no copy) | 16 | 3 min 25 s | 0 |
| `pdf62-ex15-2` | fillable | 93.3% (96.7% with the phone fix) | 8 | 2 min 23 s | 1 |
| `pdf62-ex15-3` | fillable | 100% | 7 | 1 min 34 s | 2 |
| `pdf62-ex15-4` | fillable | 100% | 8 | 2 min 21 s | 2 |
| `pdf62-plano-1` | flat | 100% | 9 | 1 min 27 s | 2 |
| `pdf62-plano-2` | flat | 100% | 8 | 1 min 38 s | 2 |
| `pdf62-plano-3` | flat | 96.7% | 8 | 2 min 27 s | 1 |

- **Pointing was never the problem.** In the six runs that filled, every value (about 26 a run,
  about 150 in all: text, ticks in 7–8 pt boxes, three-box dates) landed where it was meant to, on the
  fillable form and on the flat one. No agent ever moved a point after looking at the result.
  The 1600 px page images, sent with `detail: "auto"`, gave no sign of a scale mismatch; nothing
  needed resizing for this model.
- **Looking at the result works.** The second fills corrected content, not places: the vault's
  nationality code `POL` rewritten as `POLACA`, `CRACOVIA (POLONIA)` split into place and
  country, an e-mail address no longer upper-cased.
- **The points lost are data, not geometry**: twice the nationality stayed `POL` (the vault's
  country code; `vault.read` returns codes for select fields), and once the phone pattern of the
  scorer refused `+34 612 345 678` (fixed after the run).
- **The first run failed on behaviour**: the agent researched comisarías and DIR3 codes and held
  the whole form behind a question about optional details (which comisaría, place and date of
  signing, notifications); the simulated user had no answer and dismissed it. The prompt now says
  to fill at once and leave optional and hand-written details blank; the next six runs did.
- Unscored but worth knowing: two runs wrote the purchase ("COMPRA DE UN PISO") in the
  "(Especificar)" line, which belongs to "Por otros motivos".

Then, with the forms on the web (2026-11-19, later the same day; `pdf-ex15-plano` now on the
Ministerio's flat PDF):

| Run | Fixture | Score | Requests | Time | Fills |
| --- | --- | --- | --- | --- | --- |
| `pdf62-web-1` | web | 96.7% | 9 | 2 min 14 s | 1 |
| `pdf62-web-2` | web | 100% | 10 | 1 min 57 s | 1 |
| `pdf62-web-3` | web | 95.0% (100% of the rules; a wrong turn) | 12 | 3 min 9 s | 2 |
| `pdf62-planoof-1` | flat (official) | 96.7% | 9 | 1 min 34 s | 2 |

- Every run got the official form: once through "Modelos generales" (then its flat PDF), twice
  straight to the PDF's address (once the editable one, once the flat one), saved it and filled it.
- The wrong turn: `www.policia.es`'s page on the NIE, which SpainBench doesn't serve.
- The points lost are again the nationality written `POL`.

A replay by mistake (`pdf62-plano-replayed-from-ex15`, kept apart): the flat fixture replaying
the fillable run's model answers, i.e. the same points on the flat copy, scored 96.7%: the same
pixels land as well on drawn boxes and lines as on form fields.

Not run yet: Haiku 5.5 (voucher), e.g.
`SPAINBENCH_DIR=… corepack pnpm eval run pdf-ex15 --provider voucher --model anthropic/claude-haiku-5.5 --cache-variant h1`
(a distinct `--cache-variant` per sample: runs of the two fixtures share a prompt, so the cache
replays one into the other otherwise). Claude models see at most 1568 px and about 1.15
megapixels; a 1600 × 1131 page is larger, so Anthropic scales it down before the model sees it.
If Haiku's points land systematically off (by a constant factor), render the pages smaller
(`PAGE_IMAGE_SIDE` in `packages/agent/src/research/fetch.ts`).

## Open

- `vault.read` gives select fields' codes (`POL`, `F`, `married`): agents usually translate, not
  always. Giving the label next to the code would remove a class of form errors.
- Encrypted PDFs (owner password, permissions only) are refused: pdf-lib can't save them. None of
  the forms checked had one; AEAT's older PDFs might.
- The agent's page images render without pdf.js's standard font data: forms whose own text uses
  ZapfDingbats or Symbol glyphs show those glyphs blank to the agent.
