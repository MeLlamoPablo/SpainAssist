import { type AppLink, parseAppLink } from '@sa/shared';
import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { safeExternalUrl } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { useProcedureStore } from '../../store/procedures';
import { openDocument } from '../vault/document-actions';
import { DocumentCard, useSavedDocument } from './DocumentCard';
import { standaloneDocumentIds } from './document-links';

const linkClass =
  'font-medium text-accent-text underline decoration-accent-line decoration-1 underline-offset-[3px] hover:decoration-current';

function openAppLink(link: Exclude<AppLink, { kind: 'document' }>) {
  const { navigate, focusProcedure } = useAppStore.getState();
  switch (link.kind) {
    case 'procedure':
      if (useProcedureStore.getState().byId[link.id]) focusProcedure(link.id);
      else navigate({ kind: 'procedures' });
      return;
    case 'vault':
      navigate({ kind: 'vault', tab: link.tab });
      return;
    case 'procedures':
    case 'settings':
      navigate({ kind: link.kind });
      return;
  }
}

/** A document named inside a sentence: a link that opens it, or plain text if it is gone. */
function DocumentLink({ id, children }: { id: string; children?: ReactNode }) {
  const doc = useSavedDocument(id);
  if (!doc) return <span>{children}</span>;
  return (
    <a
      href={`sa:document/${id}`}
      onClick={(e) => {
        e.preventDefault();
        openDocument(id);
      }}
      className={linkClass}
    >
      {children}
    </a>
  );
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const appLink = parseAppLink(href);
  if (appLink?.kind === 'document') return <DocumentLink id={appLink.id}>{children}</DocumentLink>;
  if (appLink) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          openAppLink(appLink);
        }}
        className={linkClass}
      >
        {children}
      </a>
    );
  }
  const url = safeExternalUrl(href);
  if (!url) return <span>{children}</span>;
  return (
    <a
      href={url}
      title={url}
      onClick={(e) => {
        e.preventDefault();
        void api.invoke('app.openExternal', url);
      }}
      className={linkClass}
    >
      {children}
    </a>
  );
}

const components: Components = {
  // A paragraph of only document links shows them as cards (see `standaloneDocumentIds`).
  p: ({ node, children }) => {
    const ids = standaloneDocumentIds(node);
    if (!ids) return <p>{children}</p>;
    return (
      <div className="flex flex-col gap-2">
        {ids.map((id, i) => (
          // The same document may be linked twice: keys by position.
          // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
          <DocumentCard key={`${id}-${i}`} id={id} />
        ))}
      </div>
    );
  },
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  // Never load remote images from model output: show the alt text as a link instead.
  img: ({ src, alt }) =>
    typeof src === 'string' && safeExternalUrl(src) ? (
      <MdLink href={src}>{alt || src}</MdLink>
    ) : (
      <span>{alt}</span>
    ),
};

/** Keeps app links (`sa:…`), which the default transform drops as an unknown scheme. */
const urlTransform = (url: string) => (parseAppLink(url) ? url : defaultUrlTransform(url));

/**
 * Assistant markdown. Raw HTML is dropped; web links open in the system browser and app links
 * (`sa:…`, see `parseAppLink`) open that part of the app. A document link alone in its paragraph
 * shows as a document card.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('prose-sa', streaming && 'is-streaming', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
