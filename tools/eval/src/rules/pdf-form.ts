/**
 * What a filled-in PDF form shows, as a person reading the printed page would see it: for each
 * field of the blank form (its name and box), the text written in the field or drawn on the page
 * inside its box, and whether it is ticked (the checkbox itself, or an X drawn in its box). A flat
 * copy of a form has no fields: its boxes come from the fillable original.
 */
import { createHash } from 'node:crypto';
import { getDocumentProxy } from 'unpdf';
import { stripDiacritics } from '../answers/text';

/** A field of the blank form: its page (from 1) and its box in PDF points. */
export interface FormField {
  name: string;
  page: number;
  rect: [number, number, number, number];
  checkbox: boolean;
}

export interface FilledForm {
  /** What is written in the field's box ('' when nothing). */
  text(field: string): string;
  ticked(field: string): boolean;
}

interface PageText {
  str: string;
  /** Centre of the glyphs, PDF points. */
  x: number;
  y: number;
}

interface Parsed {
  values: Map<string, { value: string; checked: boolean }>;
  texts: Map<number, PageText[]>;
}

type Proxy = Awaited<ReturnType<typeof getDocumentProxy>>;

async function widgets(pdf: Proxy, page: number) {
  return (await (await pdf.getPage(page)).getAnnotations()).filter(
    (a) => a.subtype === 'Widget' && typeof a.fieldName === 'string',
  ) as {
    fieldName: string;
    rect: [number, number, number, number];
    checkBox?: boolean;
    radioButton?: boolean;
    fieldValue?: unknown;
    exportValue?: unknown;
    buttonValue?: unknown;
  }[];
}

/** The fields of a blank fillable form. */
export async function formFields(bytes: Uint8Array): Promise<FormField[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  try {
    const out: FormField[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= pdf.numPages; page++) {
      for (const w of await widgets(pdf, page)) {
        if (seen.has(w.fieldName)) continue;
        seen.add(w.fieldName);
        out.push({
          name: w.fieldName,
          page,
          rect: w.rect,
          checkbox: w.checkBox === true || w.radioButton === true,
        });
      }
    }
    return out;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function parse(bytes: Uint8Array): Promise<Parsed> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  try {
    const values = new Map<string, { value: string; checked: boolean }>();
    const texts = new Map<number, PageText[]>();
    for (let page = 1; page <= pdf.numPages; page++) {
      for (const w of await widgets(pdf, page)) {
        const value = typeof w.fieldValue === 'string' ? w.fieldValue : '';
        const on = String(w.exportValue ?? w.buttonValue ?? 'Yes');
        const checked = (w.checkBox === true || w.radioButton === true) && value === on;
        const known = values.get(w.fieldName);
        values.set(w.fieldName, {
          value: w.checkBox || w.radioButton ? '' : value,
          checked: checked || (known?.checked ?? false),
        });
      }
      const { items } = await (await pdf.getPage(page)).getTextContent();
      texts.set(
        page,
        items.flatMap((item) => {
          if (!('str' in item) || !item.str.trim()) return [];
          const [, , , d, e, f] = item.transform as number[];
          const size = Math.abs(d as number) || item.height || 10;
          return [
            { str: item.str, x: (e as number) + item.width / 2, y: (f as number) + size * 0.35 },
          ];
        }),
      );
    }
    return { values, texts };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const parsed = new Map<string, Promise<Parsed>>();

function parseOnce(bytes: Uint8Array): Promise<Parsed> {
  const key = createHash('sha256').update(bytes).digest('hex');
  let pending = parsed.get(key);
  if (!pending) {
    pending = parse(bytes);
    parsed.set(key, pending);
  }
  return pending;
}

/**
 * Reads a filled-in copy against the fields of the fillable blank. `printed` is the blank the copy
 * was filled from: what it already shows (dot leaders, □) is not something written.
 */
export async function readFilledForm(
  bytes: Uint8Array,
  fields: readonly FormField[],
  printed: Uint8Array,
): Promise<FilledForm> {
  const { values, texts: all } = await parseOnce(bytes);
  const blank = await parseOnce(printed);
  const texts = new Map(
    [...all].map(([page, items]) => [
      page,
      items.filter(
        (t) =>
          !(blank.texts.get(page) ?? []).some(
            (b) => b.str === t.str && Math.abs(b.x - t.x) < 0.5 && Math.abs(b.y - t.y) < 0.5,
          ),
      ),
    ]),
  );
  const byName = new Map(fields.map((f) => [f.name, f]));
  const drawn = (name: string, slackX: number, slackY: number): PageText[] => {
    const field = byName.get(name);
    if (!field) throw new Error(`No field ${name} in the blank form`);
    const [x1, y1, x2, y2] = field.rect;
    return (texts.get(field.page) ?? [])
      .filter(
        (t) =>
          t.x >= Math.min(x1, x2) - slackX &&
          t.x <= Math.max(x1, x2) + slackX &&
          t.y >= Math.min(y1, y2) - slackY &&
          t.y <= Math.max(y1, y2) + slackY,
      )
      .sort((a, b) => b.y - a.y || a.x - b.x);
  };
  return {
    text(name) {
      const own = values.get(name)?.value.trim() ?? '';
      if (own) return own;
      return drawn(name, 2, 4)
        .map((t) => t.str.trim())
        .join(' ')
        .trim();
    },
    ticked(name) {
      if (values.get(name)?.checked) return true;
      return drawn(name, 4, 4).some((t) => /^[x✓✔]$/i.test(t.str.trim()));
    },
  };
}

/** For comparing what was written: accents and case ignored, spaces collapsed. */
export function foldText(text: string): string {
  return stripDiacritics(text).toLowerCase().replace(/\s+/g, ' ').trim();
}
