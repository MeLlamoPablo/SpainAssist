import type { FormPrompt, MapPoint } from '@sa/shared';
import { MapQuotaError, type Maps } from './maps';

export type PlaceLookup = Maps['place'];
/**
 * Pins of a form's map fields, by field key, in option order (null: not found). A field maps to
 * null when it has no map because the user's lookups are used up: the form shows only the list.
 */
export type MapPins = Map<string, (MapPoint | null)[] | null>;

/** Pins of one map field of a pending form, for its map: looked up once and kept with it. */
export async function pendingFormPins(
  prompt: FormPrompt,
  pins: MapPins,
  fieldKey: string,
  lookup: PlaceLookup,
): Promise<(MapPoint | null)[] | null> {
  const known = pins.get(fieldKey);
  if (known !== undefined) return known;
  const field = prompt.fields.find((f) => f.key === fieldKey && f.type === 'map-options');
  if (!field) throw new Error('Not a map field.');
  let points: (MapPoint | null)[] | null;
  try {
    points = await Promise.all(
      (field.options ?? []).map(async (option) => (await lookup(option.address ?? '')) ?? null),
    );
  } catch (err) {
    if (!(err instanceof MapQuotaError)) throw err;
    points = null;
  }
  pins.set(fieldKey, points);
  return points;
}
