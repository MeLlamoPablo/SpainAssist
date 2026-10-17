/** Tiny HTML templating: `html` escapes every interpolation unless it is already SafeHtml. */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1]!;
  });
  return new SafeHtml(out);
}

/** Marks trusted markup (never pass user input). */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Escapes a value for an inline <script type="application/json"> block. */
export function jsonForScript(value: unknown): SafeHtml {
  return raw(JSON.stringify(value).replace(/</g, '\\u003c'));
}
