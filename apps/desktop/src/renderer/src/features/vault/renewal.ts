import {
  DOCUMENT_FIELD_GROUPS,
  DOCUMENT_RENEWAL_WINDOW,
  type DocumentFieldGroup,
} from '@sa/shared';
import { differenceInCalendarDays, isBefore, parseISO, startOfDay, sub } from 'date-fns';

export interface RenewableDocument {
  group: DocumentFieldGroup;
  /** Days until it expires: negative once expired. */
  days: number;
}

/**
 * A document's expiry date the user can act on: it's inside the document's renewal window, or
 * already past. Permanent DNIs (9999-…) never are.
 */
export function renewableDocument(
  key: string,
  value: string,
  now = new Date(),
): RenewableDocument | null {
  const group = DOCUMENT_FIELD_GROUPS.find((g) => key === `${g}Expiry`);
  if (!group || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const expiry = parseISO(value);
  if (isBefore(now, startOfDay(sub(expiry, DOCUMENT_RENEWAL_WINDOW[group])))) return null;
  return { group, days: differenceInCalendarDays(expiry, now) };
}
