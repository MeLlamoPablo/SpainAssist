import type { Language } from '@sa/shared';
import { useAppStore } from '../store/app';

/**
 * Tiny typed i18n. Each feature defines its own dictionary next to its components:
 *
 *   const dict = defineDict({ es: { title: 'Mis datos' }, en: { title: 'My data' } });
 *   const t = useT(dict); t.title
 *
 * The English dictionary must have exactly the shape of the Spanish one (compile-time check).
 * Copy rules: plain everyday Spanish, "tú", short sentences, no bureaucratic jargon.
 */

export type Lang = Language;

export interface Dict<T> {
  es: T;
  en: T;
}

export function defineDict<T>(dict: { es: T; en: NoInfer<T> }): Dict<T> {
  return dict;
}

function getLang(): Lang {
  return useAppStore.getState().settings?.language ?? 'es';
}

export function useLang(): Lang {
  return useAppStore((s) => s.settings?.language ?? 'es');
}

export function useT<T>(dict: Dict<T>): T {
  return dict[useLang()];
}

/** Non-hook access (event handlers, toasts). */
export function tr<T>(dict: Dict<T>): T {
  return dict[getLang()];
}

export const LOCALE: Record<Lang, string> = { es: 'es-ES', en: 'en-GB' };
