import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { safeExternalUrl } from '../../lib/format';

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
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
      className="font-medium text-accent-text underline decoration-accent-line decoration-1 underline-offset-[3px] hover:decoration-current"
    >
      {children}
    </a>
  );
}

const components: Components = {
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  // Never load remote images from model output: show the alt text as a link instead.
  img: ({ src, alt }) =>
    typeof src === 'string' && safeExternalUrl(src) ? (
      <MdLink href={src}>{alt || src}</MdLink>
    ) : (
      <span>{alt}</span>
    ),
};

/** Assistant markdown. Raw HTML is dropped; links open in the system browser. */
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
