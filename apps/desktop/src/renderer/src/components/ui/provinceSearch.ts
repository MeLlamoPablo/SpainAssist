import { SPANISH_PROVINCES } from '@sa/shared';

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

export function filterProvinces(query: string) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  return SPANISH_PROVINCES.filter((province) => {
    const names = [province.label, province.value, province.code, ...(province.aliases ?? [])];
    return names.some((name) => words.every((word) => normalize(name).includes(word)));
  });
}
