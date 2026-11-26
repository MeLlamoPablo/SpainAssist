import { readFileSync } from 'node:fs';
import { DesktopToPhone, PhoneToDesktop } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { buildVectors } from './vectors';

describe('vectors/v1.json', () => {
  it('matches the channel (regenerate: corepack pnpm --filter @sa/companion vectors)', async () => {
    const file = JSON.parse(readFileSync(new URL('../vectors/v1.json', import.meta.url), 'utf8'));
    expect(file).toEqual(await buildVectors());
  });

  it('holds messages the desktop accepts, as the Kotlin tests decode and encode them', async () => {
    const { login, session } = await buildVectors();
    expect(DesktopToPhone.parse(session.request)).toEqual(session.request);
    expect(DesktopToPhone.parse(session.end)).toEqual(session.end);
    expect(DesktopToPhone.parse(login.request)).toEqual(login.request);
    expect(DesktopToPhone.parse(login.toBeSigned)).toEqual(login.toBeSigned);
    expect(DesktopToPhone.parse(login.unlock)).toEqual(login.unlock);
    expect(PhoneToDesktop.parse(login.need)).toEqual(login.need);
  });
});
