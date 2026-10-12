/**
 * Colloquial → official wording, so a few everyday keywords also match the administrative
 * vocabulary of other agents' notes ("carnet de conducir" → "permiso de
 * conducción", "paro" → "prestación por desempleo"). The expansion is searched in addition to the
 * original query, never instead of it.
 */
const word = (pattern: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'gu');

const SYNONYMS: [RegExp, string][] = [
  [word('carn[eé]t?\\s+de\\s+conducir'), 'permiso de conducción'],
  [word('carn[eé]t?'), 'permiso'],
  [word('conducir'), 'conducción'],
  [word('paro'), 'prestación por desempleo'],
  [word('padr[oó]n|empadronar(?:se|me)?'), 'empadronamiento padrón'],
  [word('baja\\s+m[eé]dica'), 'incapacidad temporal'],
  [word('itv'), 'inspección técnica de vehículos'],
  [word('coches?'), 'vehículo'],
  [word('matricular'), 'matriculación'],
  [word('multas?'), 'sanción'],
  [word('aut[oó]nom[oa]s?'), 'trabajador por cuenta propia'],
  [word('certificado\\s+digital'), 'certificado electrónico'],
  [word('firma\\s+digital'), 'firma electrónica'],
  [word('ayudas?'), 'subvención ayuda'],
  [word('nie'), 'número de identidad de extranjero'],
  [word('tie'), 'tarjeta de identidad de extranjero'],
  [word('imv'), 'ingreso mínimo vital'],
  [word('clave'), 'cl@ve'],
];

/** Returns the query rewritten with official wording, or undefined when nothing applies. */
export function expandQuery(query: string): string | undefined {
  const lower = query.toLowerCase();
  let out = lower;
  for (const [re, replacement] of SYNONYMS) out = out.replace(re, replacement);
  return out === lower ? undefined : out;
}
