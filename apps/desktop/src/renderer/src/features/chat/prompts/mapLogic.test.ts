import { FormPrompt, type PersonalDataItem } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { displayValue, initialValues } from './formLogic';
import { distanceKm, homeAddress, sortedPlaces } from './mapLogic';

const home = { latitude: 37.375, longitude: -5.986 };
const options = [
  { value: 'far', label: 'Far', address: 'North' },
  { value: 'near', label: 'Near', address: 'South' },
];
const points = [
  { latitude: 37.404, longitude: -5.991 },
  { latitude: 37.371, longitude: -5.988 },
];
const field = {
  key: 'centre',
  label: 'Centre',
  type: 'map-options' as const,
  required: true,
  options,
};
const personal = (key: string, value: string): PersonalDataItem => ({
  key,
  value,
  label: key,
  source: 'manual',
  updatedAt: '2026-10-04',
});

describe('map options', () => {
  it('needs a name and a street address for every option, with unique values', () => {
    expect(FormPrompt.safeParse({ kind: 'form', title: 'Choose', fields: [field] }).success).toBe(
      true,
    );
    for (const invalid of [
      [],
      [{ value: 'name', label: 'Demo centre, Sevilla' }],
      [{ value: 'address', label: ' ', address: 'Demo 10, Sevilla' }],
      [{ value: ' ', label: 'Demo centre', address: 'Demo 10, Sevilla' }],
      [options[0], options[0]],
    ]) {
      expect(
        FormPrompt.safeParse({
          kind: 'form',
          title: 'Choose',
          fields: [{ ...field, options: invalid }],
        }).success,
      ).toBe(false);
    }
  });
  it('sorts by local distance and preserves original order without a home', () => {
    expect(sortedPlaces(options, points).map((o) => o.value)).toEqual(['far', 'near']);
    expect(sortedPlaces(options, points, home).map((o) => o.value)).toEqual(['near', 'far']);
    expect(sortedPlaces(options, points, home)[0].index).toBe(1);
    // Unplaced options (not found, or pins still loading) keep their order at the end.
    expect(sortedPlaces(options, [points[0]!, null], home).map((o) => o.value)).toEqual([
      'far',
      'near',
    ]);
    expect(distanceKm(home, home)).toBe(0);
    expect(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(
      111.195,
      2,
    );
  });
  it('builds the home address only from a street and a town', () => {
    const data = [personal('addressStreet', 'Demo 10'), personal('addressMunicipality', 'Sevilla')];
    expect(homeAddress(data)).toBe('Demo 10, Sevilla');
    expect(homeAddress(data.filter((p) => p.key !== 'addressStreet'))).toBe('');
  });
  it('prefills only valid option values and shows the chosen place label', () => {
    expect(initialValues([{ ...field, defaultValue: 'near' }])).toEqual({ centre: 'near' });
    expect(initialValues([{ ...field, defaultValue: 'unknown' }])).toEqual({ centre: '' });
    expect(
      displayValue(
        field,
        'near',
        { yes: 'Yes', no: 'No', hidden: 'Hidden', moreAppointments: 'More' },
        () => undefined,
      ),
    ).toBe('Near');
  });
});
