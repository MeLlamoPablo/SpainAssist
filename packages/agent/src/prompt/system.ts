/** What every agent's system prompt shares (prompt/codemode.ts, prompt/coordinator.ts). */

/**
 * How the agent researches the web: `web_research` (vouchers and ChatGPT plans) or the Exa tools
 * with the user's own key (BYOK and custom endpoints). See ResearchBackend.
 */
export type PromptResearch = 'web_research' | 'exa';

export const LANGUAGE_NAMES: Record<'es' | 'en', string> = {
  es: 'Spanish (español de España, "tú")',
  en: 'English',
};

/** The user's time zone if Intl knows it, otherwise Europe/Madrid. */
function resolveTimeZone(timeZone = 'Europe/Madrid'): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'Europe/Madrid';
  }
}

export function formatToday(now: Date, timeZone?: string): string {
  const zone = resolveTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long' }).format(now);
  return `${weekday} ${get('year')}-${get('month')}-${get('day')} (${zone})`;
}
