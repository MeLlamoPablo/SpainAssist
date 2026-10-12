import { z } from 'zod';

/**
 * Links from the assistant's chat messages to parts of the app, written as markdown links:
 * `[tus documentos](sa:vault/documents)`. The model writes them, so they are untrusted: only
 * these targets exist, and anything else is not a link.
 */
export const APP_LINK_SCHEME = 'sa:';

export const appLinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('procedures') }),
  z.object({ kind: z.literal('procedure'), id: z.string().regex(/^[\w-]{1,64}$/) }),
  z.object({ kind: z.literal('vault'), tab: z.enum(['personal', 'documents', 'credentials']) }),
  z.object({ kind: z.literal('settings') }),
]);
export type AppLink = z.infer<typeof appLinkSchema>;

/** The app link an href points to, or null if it is not one (or not a valid one). */
export function parseAppLink(href: string | undefined | null): AppLink | null {
  if (!href?.startsWith(APP_LINK_SCHEME)) return null;
  const [kind, arg, ...rest] = href.slice(APP_LINK_SCHEME.length).split('/');
  if (rest.length > 0) return null;
  const candidate =
    kind === 'procedure'
      ? { kind, id: arg }
      : kind === 'vault'
        ? { kind, tab: arg }
        : arg === undefined
          ? { kind }
          : null;
  const parsed = appLinkSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
