/**
 * Spain's 50 provinces plus the autonomous cities of Ceuta and Melilla, for the native
 * "province" form field and the "addressProvince" personal data field.
 * `value` is the name stored and sent to the agent; `label` adds the co-official name.
 */

export interface SpanishProvince {
  /** INE province code ("01".."52"). */
  code: string;
  value: string;
  label: string;
  /** Other common spellings, used to match free-text answers. */
  aliases?: string[];
}

export const SPANISH_PROVINCES: readonly SpanishProvince[] = [
  { code: '15', value: 'A Coruña', label: 'A Coruña', aliases: ['La Coruña', 'Coruña'] },
  { code: '01', value: 'Álava', label: 'Álava / Araba', aliases: ['Araba'] },
  { code: '02', value: 'Albacete', label: 'Albacete' },
  { code: '03', value: 'Alicante', label: 'Alicante / Alacant', aliases: ['Alacant'] },
  { code: '04', value: 'Almería', label: 'Almería' },
  { code: '33', value: 'Asturias', label: 'Asturias', aliases: ['Oviedo'] },
  { code: '05', value: 'Ávila', label: 'Ávila' },
  { code: '06', value: 'Badajoz', label: 'Badajoz' },
  { code: '08', value: 'Barcelona', label: 'Barcelona' },
  { code: '48', value: 'Bizkaia', label: 'Bizkaia / Vizcaya', aliases: ['Vizcaya'] },
  { code: '09', value: 'Burgos', label: 'Burgos' },
  { code: '10', value: 'Cáceres', label: 'Cáceres' },
  { code: '11', value: 'Cádiz', label: 'Cádiz' },
  { code: '39', value: 'Cantabria', label: 'Cantabria', aliases: ['Santander'] },
  { code: '12', value: 'Castellón', label: 'Castellón / Castelló', aliases: ['Castelló'] },
  { code: '51', value: 'Ceuta', label: 'Ceuta' },
  { code: '13', value: 'Ciudad Real', label: 'Ciudad Real' },
  { code: '14', value: 'Córdoba', label: 'Córdoba' },
  { code: '16', value: 'Cuenca', label: 'Cuenca' },
  { code: '20', value: 'Gipuzkoa', label: 'Gipuzkoa / Guipúzcoa', aliases: ['Guipúzcoa'] },
  { code: '17', value: 'Girona', label: 'Girona', aliases: ['Gerona'] },
  { code: '18', value: 'Granada', label: 'Granada' },
  { code: '19', value: 'Guadalajara', label: 'Guadalajara' },
  { code: '21', value: 'Huelva', label: 'Huelva' },
  { code: '22', value: 'Huesca', label: 'Huesca' },
  {
    code: '07',
    value: 'Illes Balears',
    label: 'Illes Balears',
    aliases: ['Baleares', 'Islas Baleares', 'Balears'],
  },
  { code: '23', value: 'Jaén', label: 'Jaén' },
  { code: '26', value: 'La Rioja', label: 'La Rioja', aliases: ['Rioja', 'Logroño'] },
  { code: '35', value: 'Las Palmas', label: 'Las Palmas', aliases: ['Gran Canaria'] },
  { code: '24', value: 'León', label: 'León' },
  { code: '25', value: 'Lleida', label: 'Lleida', aliases: ['Lérida'] },
  { code: '27', value: 'Lugo', label: 'Lugo' },
  { code: '28', value: 'Madrid', label: 'Madrid', aliases: ['Comunidad de Madrid'] },
  { code: '29', value: 'Málaga', label: 'Málaga' },
  { code: '52', value: 'Melilla', label: 'Melilla' },
  { code: '30', value: 'Murcia', label: 'Murcia', aliases: ['Región de Murcia'] },
  { code: '31', value: 'Navarra', label: 'Navarra / Nafarroa', aliases: ['Nafarroa'] },
  { code: '32', value: 'Ourense', label: 'Ourense', aliases: ['Orense'] },
  { code: '34', value: 'Palencia', label: 'Palencia' },
  { code: '36', value: 'Pontevedra', label: 'Pontevedra' },
  { code: '37', value: 'Salamanca', label: 'Salamanca' },
  {
    code: '38',
    value: 'Santa Cruz de Tenerife',
    label: 'Santa Cruz de Tenerife',
    aliases: ['Tenerife'],
  },
  { code: '40', value: 'Segovia', label: 'Segovia' },
  { code: '41', value: 'Sevilla', label: 'Sevilla' },
  { code: '42', value: 'Soria', label: 'Soria' },
  { code: '43', value: 'Tarragona', label: 'Tarragona' },
  { code: '44', value: 'Teruel', label: 'Teruel' },
  { code: '45', value: 'Toledo', label: 'Toledo' },
  { code: '46', value: 'Valencia', label: 'Valencia / València', aliases: ['València'] },
  { code: '47', value: 'Valladolid', label: 'Valladolid' },
  { code: '49', value: 'Zamora', label: 'Zamora' },
  { code: '50', value: 'Zaragoza', label: 'Zaragoza' },
];

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/^(provincia de|province of)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOOKUP = new Map<string, SpanishProvince>();
for (const p of SPANISH_PROVINCES) {
  for (const name of [p.value, p.label, p.code, ...(p.aliases ?? [])]) {
    LOOKUP.set(normalize(name), p);
  }
}

/** The province a free-text answer names ("la coruña", "Vizcaya", "28"), if any. */
export function matchProvince(raw: string): SpanishProvince | undefined {
  return LOOKUP.get(normalize(raw));
}

/** The province of a Spanish postal code: five digits whose first two are its INE code (01–52). */
export function postalCodeProvince(code: string): SpanishProvince | undefined {
  if (!/^\d{5}$/.test(code)) return undefined;
  return SPANISH_PROVINCES.find((p) => p.code === code.slice(0, 2));
}
