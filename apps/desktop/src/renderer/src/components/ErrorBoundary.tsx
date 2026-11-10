import { CircleAlert, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { defineDict, useT } from '../i18n';
import { common } from '../i18n/common';
import { reportRenderError } from '../lib/error-reports';
import { Button } from './ui/button';
import { Callout, EmptyState } from './ui/misc';

type Fallback = ReactNode | ((retry: () => void, error: unknown) => ReactNode);

interface Props {
  children: ReactNode;
  fallback: Fallback;
  /** The data the part shows: when one of these changes, the part renders again. */
  resetKeys?: readonly unknown[];
  /** Also told what failed (once per failure). */
  onError?: (error: unknown) => void;
}

/**
 * Keeps an error while rendering one part of the window (an agent's question, a message, a card)
 * in that part: it shows `fallback` and the rest of the app stays usable. Without a boundary,
 * React removes the whole window. Agents write most of what the app shows, so every part made of
 * their data sits in one. The part renders again when one of `resetKeys` changes or the fallback
 * calls `retry`.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean; error: unknown }> {
  override state = { failed: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    reportRenderError(error, info.componentStack);
    this.props.onError?.(error);
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.failed && changed(prev.resetKeys, this.props.resetKeys)) this.retry();
  }

  retry = () => this.setState({ failed: false, error: undefined });

  override render() {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === 'function' ? fallback(this.retry, this.state.error) : fallback;
  }
}

function changed(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  return a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
}

const dict = defineDict({
  es: {
    message: 'No puedo mostrar este mensaje.',
    question: 'No puedo mostrar esta pregunta.',
    procedure: 'No puedo mostrar este trámite.',
    part: 'No puedo mostrar esta parte',
    partBody: 'Algo ha fallado al mostrarla. Tus datos están a salvo.',
  },
  en: {
    message: 'I can’t show this message.',
    question: 'I can’t show this question.',
    procedure: 'I can’t show this procedure.',
    part: 'I can’t show this part',
    partBody: 'Something went wrong while showing it. Your data is safe.',
  },
});

/** In place of one item that cannot be shown. */
export function Unshowable({
  what,
  children,
  action,
}: {
  what: 'message' | 'question' | 'procedure';
  children?: ReactNode;
  action?: ReactNode;
}) {
  const t = useT(dict);
  return (
    <Callout tone="blocked" icon={CircleAlert} title={t[what]} action={action}>
      {children}
    </Callout>
  );
}

/** In place of a whole area of the window (the chat, the pane). */
export function UnshowablePart({ retry }: { retry: () => void }) {
  const t = useT(dict);
  const tc = useT(common);
  return (
    <EmptyState
      icon={CircleAlert}
      title={t.part}
      action={
        <Button icon={RotateCcw} onClick={retry}>
          {tc.retry}
        </Button>
      }
    >
      {t.partBody}
    </EmptyState>
  );
}
