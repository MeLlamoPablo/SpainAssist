import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const NAME = 'Spain Assist Dev';

/**
 * macOS dev runs show the bundle's CFBundleName in the dock and menu bar, and Electron's own
 * bundle says "Electron". Returns the executable of a copy named "Spain Assist Dev", cached
 * per Electron version, name and icon under node_modules/.cache: an APFS clone (no extra disk),
 * renamed, given the Blueprint icon and ad-hoc signed again, as the stock bundle is.
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
  const icon = resolve(import.meta.dirname, '../packaging/icon-dev.icns');
  const iconHash = createHash('sha256').update(readFileSync(icon)).digest('hex');
  const key = `${source}\n${version}\n${NAME}\n${iconHash}\n`;
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
  copyFileSync(icon, join(bundle, 'Contents/Resources/icon-dev.icns'));
  execFileSync('plutil', ['-replace', 'CFBundleIconFile', '-string', 'icon-dev.icns', info]);
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
