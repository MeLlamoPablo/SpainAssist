import type { FormField, HomeAddress, MapPoint, PersonalDataItem } from '@sa/shared';

export type { MapPoint };
export type PlaceOption = NonNullable<FormField['options']>[number];
export const ADDRESS_KEYS = [
  'addressStreet',
  'addressPostalCode',
  'addressMunicipality',
  'addressProvince',
  'addressCountry',
] as const;
export type AddressValues = Record<(typeof ADDRESS_KEYS)[number], string>;

export function addressValues(personal: PersonalDataItem[]): AddressValues {
  return Object.fromEntries(
    ADDRESS_KEYS.map((key) => [
      key,
      personal.find((p) => p.key === key)?.value ?? (key === 'addressCountry' ? 'España' : ''),
    ]),
  ) as AddressValues;
}

/** The fields main needs to find the home on the map (it searches Spain only). */
export function homeQuery(values: AddressValues): HomeAddress {
  const postalCode = values.addressPostalCode.trim();
  return {
    street: values.addressStreet.trim(),
    municipality: values.addressMunicipality.trim(),
    ...(postalCode ? { postalCode } : {}),
  };
}

export function homeAddress(personal: PersonalDataItem[]) {
  const street = personal.find((p) => p.key === 'addressStreet')?.value?.trim();
  const municipality = personal.find((p) => p.key === 'addressMunicipality')?.value?.trim();
  if (!street || !municipality) return '';
  return ADDRESS_KEYS.map((key) => personal.find((p) => p.key === key)?.value?.trim())
    .filter(Boolean)
    .join(', ');
}

/** Great-circle kilometres, not driving distance or travel time. */
export function distanceKm(a: MapPoint, b: MapPoint) {
  const rad = (n: number) => (n * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function sortedPlaces(options: PlaceOption[], points: (MapPoint | null)[], home?: MapPoint) {
  return options
    .map((option, index) => {
      const point = points[index];
      return {
        ...option,
        index,
        distance: home && point ? distanceKm(home, point) : undefined,
      };
    })
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.index - b.index);
}
