/**
 * Address lookups for the app's map forms (`map-options`: the agent asks the user to pick an
 * office on a map), offline. The app has no lookups by default and then refuses every map form,
 * which the shipped app (with its maps server) never does. A run has no maps server either, so
 * every address gets a pin derived from its text: the same address always lands on the same point
 * inside mainland Spain. Nothing is looked up on the network, and the pins only feed the map the
 * user would see; the user simulator answers by option, never by position.
 */
import { createHash } from 'node:crypto';
import type { createHeadlessApp } from '@sa/desktop/headless';
import type { MapPoint } from '@sa/shared';

type Places = NonNullable<Parameters<typeof createHeadlessApp>[0]['places']>;

/** Mainland Spain, roughly: where the pins land. */
const BOUNDS = { south: 37, north: 43, west: -8, east: 2 } as const;

function pointOf(text: string): MapPoint {
  const digest = createHash('sha256').update(text.trim().toLowerCase()).digest();
  const fraction = (offset: number) => digest.readUInt32BE(offset) / 0xffff_ffff;
  return {
    latitude: BOUNDS.south + fraction(0) * (BOUNDS.north - BOUNDS.south),
    longitude: BOUNDS.west + fraction(4) * (BOUNDS.east - BOUNDS.west),
  };
}

export function offlinePlaces(): Places {
  return {
    place: async (address, signal) => {
      signal?.throwIfAborted();
      return address.trim() ? pointOf(address) : undefined;
    },
    home: async (home, signal) => {
      signal?.throwIfAborted();
      const query = [home.street, home.postalCode, home.municipality].filter(Boolean).join(', ');
      return query ? pointOf(query) : null;
    },
  };
}
