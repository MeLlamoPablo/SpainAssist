import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Frame, Page } from 'playwright-core';

export const noop = (): void => {};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves with `fallback` if `promise` does not settle in time (rejections also give fallback). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Waits until every promise settles or `ms` elapse. Returns true if all settled. */
export async function settleAll(
  promises: Iterable<Promise<unknown>>,
  ms: number,
): Promise<boolean> {
  const list = [...promises];
  if (!list.length) return true;
  return withTimeout(
    Promise.allSettled(list).then(() => true),
    ms,
    false,
  );
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isHttpUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** URL of the frame, or of the closest ancestor with a real URL (about:blank/srcdoc inherit). */
export function effectiveFrameUrl(frame: Frame): string {
  let f: Frame | null = frame;
  while (f) {
    const u = f.url();
    if (u && !u.startsWith('about:')) return u;
    f = f.parentFrame();
  }
  return frame.url();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
const UNSAFE_FILE_NAME_CHARS = /[\x00-\x1f\x7f<>:"/\\|?*]+/g;

/** Safe file name (no directories, no control characters), keeping the extension. */
export function sanitizeFileName(name: string, fallback = 'documento'): string {
  const base = path.basename(name || '').normalize('NFC');
  const cleaned = base.replace(UNSAFE_FILE_NAME_CHARS, '_').replace(/^\.+/, '').trim();
  return (cleaned || fallback).slice(0, 150);
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  xml: 'application/xml',
  xsig: 'application/xml',
  csig: 'application/octet-stream',
  p7s: 'application/pkcs7-signature',
  zip: 'application/zip',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

/** MIME type from the file name, falling back to magic bytes. */
export function guessMimeType(name: string, head?: Buffer): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (head && head.length >= 4) {
    const latin = head.subarray(0, 8).toString('latin1');
    if (latin.startsWith('%PDF-')) return 'application/pdf';
    if (latin.startsWith('PK\x03\x04')) return 'application/zip';
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
    if (latin.startsWith('\x89PNG')) return 'image/png';
    if (latin.startsWith('<?xml')) return 'application/xml';
  }
  return 'application/octet-stream';
}

/** File name from a Content-Disposition header (filename* first), if any. */
export function fileNameFromContentDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:[\w-]+)''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const value = plain?.[2] ?? plain?.[1];
  return value?.trim() || undefined;
}

export function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return last || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Values of password inputs in every frame of the page (including open shadow roots), so they
 * can be masked in the snapshot. `count` is the number of password inputs found.
 */
export async function collectPasswordValues(
  page: Page,
): Promise<{ count: number; values: string[] }> {
  const frames = page.frames().slice(0, 30);
  const results = await Promise.all(
    frames.map((frame) =>
      withTimeout(
        frame.evaluate(() => {
          const values: string[] = [];
          let count = 0;
          const visit = (root: Document | ShadowRoot): void => {
            for (const input of Array.from(root.querySelectorAll('input'))) {
              if ((input.getAttribute('type') ?? '').toLowerCase() !== 'password') continue;
              count++;
              if (input.value) values.push(input.value);
            }
            for (const el of Array.from(root.querySelectorAll('*'))) {
              if (el.shadowRoot) visit(el.shadowRoot);
            }
          };
          visit(document);
          return { count, values };
        }),
        1500,
        { count: 0, values: [] as string[] },
      ),
    ),
  );
  return {
    count: results.reduce((n, r) => n + r.count, 0),
    values: results.flatMap((r) => r.values),
  };
}
