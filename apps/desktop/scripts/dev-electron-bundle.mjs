import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const NAME = 'Spain Assist';

/**
 * macOS dev runs show the bundle's CFBundleName in the dock and menu bar, and Electron's own
 * bundle says "Electron". Returns the executable of a copy named "Spain Assist", made once
 * per Electron version under node_modules/.cache: an APFS clone (no extra disk), renamed and
 * ad-hoc signed again, as the stock bundle is.
 */
export function devElectronBinary(electronBinary) {
  const source = resolve(dirname(electronBinary), '../..');
  const plist = join(source, 'Contents/Info.plist');
  const version = execFileSync('plutil', ['-extract', 'CFBundleVersion', 'raw', plist], {
    encoding: 'utf8',
  }).trim();
  const cache = resolve(import.meta.dirname, '../node_modules/.cache/sa-dev-electron');
  const bundle = join(cache, `${NAME}.app`);
  const stamp = join(cache, 'stamp');
  const binary = join(bundle, 'Contents/MacOS', electronBinary.split('/').pop());
  const key = `${source}\n${version}\n`;
  if (existsSync(binary) && readStamp(stamp) === key) return binary;

  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  try {
    execFileSync('cp', ['-cR', source, bundle]);
  } catch {
    execFileSync('cp', ['-R', source, bundle]);
  }
  const info = join(bundle, 'Contents/Info.plist');
  for (const field of ['CFBundleName', 'CFBundleDisplayName'])
    execFileSync('plutil', ['-replace', field, '-string', NAME, info]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
  writeFileSync(stamp, key);
  return binary;
}

function readStamp(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
