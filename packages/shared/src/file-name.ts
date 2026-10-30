/**
 * File names the app gives files on the user's disk, from a website's name for a download, a
 * document's name in the vault or an agent's title for it. Windows' rules apply on every OS,
 * since files move between machines.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

/**
 * Windows' device names, which a file can't have in any case, with any extension ("con.pdf",
 * "Com1.tar.gz"): ¹²³ count as digits in COM and LPT ones.
 */
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/i;

/**
 * The longest file name, extension included, in UTF-16 code units. Windows paths stop at 260
 * (MAX_PATH) for most programs, Explorer and the PDF viewers that open a document included; the
 * deepest folder the app names a file in is the temporary one of documents opened with the OS
 * (`C:\Users\<user>\AppData\Local\Temp\SpainAssistant-<24>\open-<16>\`, 91 characters plus the
 * user's). 100 keeps that, and Downloads with a " (12)" suffix, well under 260 for any user name.
 */
export const MAX_FILE_NAME_LENGTH = 100;

/** Up to this long (dot included), the end after the last dot is an extension kept by shortening. */
const MAX_EXTENSION_LENGTH = 16;

/**
 * A safe file name for `name`, `fallback` when nothing of it is left:
 * - only its last part when it is a path (after the last `/` or `\`);
 * - `<>:"/\|?*` and control characters replaced, each run by one "_";
 * - no leading or trailing dots and spaces (Windows drops trailing ones; leading ones hide a file
 *   on macOS and Linux);
 * - a device name gets a "_" in front, as Chromium does with downloads ("_CON.pdf");
 * - at most MAX_FILE_NAME_LENGTH long, shortened before its extension.
 * Ordinary names stay as they are ("Informe de vida laboral - 2026-10-12.pdf").
 */
export function safeFileName(name: string, fallback = 'documento'): string {
  let safe = trimDotsAndSpaces(
    (name.split(/[\\/]/).pop() ?? '').normalize('NFC').replace(UNSAFE_CHARACTERS, '_'),
  );
  if (!safe) return fallback;
  if (DEVICE_NAME.test(safe.split('.')[0]?.trimEnd() ?? '')) safe = `_${safe}`;
  if (safe.length <= MAX_FILE_NAME_LENGTH) return safe;
  const dot = safe.lastIndexOf('.');
  const extension = dot > 0 && safe.length - dot <= MAX_EXTENSION_LENGTH ? safe.slice(dot) : '';
  let base = safe.slice(0, MAX_FILE_NAME_LENGTH - extension.length);
  // Never half a surrogate pair (an emoji, say).
  if (/[\ud800-\udbff]$/.test(base)) base = base.slice(0, -1);
  return trimDotsAndSpaces(base) + extension;
}

function trimDotsAndSpaces(name: string): string {
  return name.replace(/^[\s.]+|[\s.]+$/g, '');
}
