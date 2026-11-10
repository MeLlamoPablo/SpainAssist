import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

// Server rendering reads a zustand store's initial state: give components a plain one instead.
vi.mock('../store/app', () => ({
  useAppStore: Object.assign((selector: (state: object) => unknown) => selector({}), {
    getState: () => ({}),
  }),
}));
const reports = vi.hoisted(() => ({ reportRenderError: vi.fn() }));
vi.mock('../lib/error-reports', () => reports);

// No DOM here, so React never catches anything: drive the boundary's lifecycle by hand.
function boundary(props: ConstructorParameters<typeof ErrorBoundary>[0]) {
  const b = new ErrorBoundary(props);
  b.setState = ((patch: object) => Object.assign(b.state, patch)) as typeof b.setState;
  return b;
}

describe('ErrorBoundary', () => {
  it('shows its part until it fails, then the fallback with the error and a retry', () => {
    const fallback = vi.fn((_retry: () => void, error: unknown) => `failed: ${String(error)}`);
    const b = boundary({ fallback, children: 'part' });
    expect(b.render()).toBe('part');

    const error = new RangeError('Invalid time value');
    Object.assign(b.state, ErrorBoundary.getDerivedStateFromError(error));
    b.componentDidCatch(error, { componentStack: '\n    at AppointmentPicker' });
    expect(b.render()).toBe('failed: RangeError: Invalid time value');
    expect(reports.reportRenderError).toHaveBeenCalledWith(error, '\n    at AppointmentPicker');

    fallback.mock.calls[0]?.[0]();
    expect(b.render()).toBe('part');
  });

  it('renders again when the data it shows changes, not before', () => {
    const tree = { rev: 1 };
    const b = boundary({ fallback: null, resetKeys: [tree], children: 'part' });
    Object.assign(b.state, ErrorBoundary.getDerivedStateFromError(new Error('x')));

    b.componentDidUpdate({ fallback: null, resetKeys: [tree], children: 'part' });
    expect(b.render()).toBeNull();

    Object.assign(b, { props: { ...b.props, resetKeys: [{ rev: 2 }] } });
    b.componentDidUpdate({ fallback: null, resetKeys: [tree], children: 'part' });
    expect(b.render()).toBe('part');
  });

  it('renders its children as they are while nothing fails', () => {
    expect(
      renderToStaticMarkup(
        <ErrorBoundary fallback="failed">
          <p>Hola</p>
        </ErrorBoundary>,
      ),
    ).toBe('<p>Hola</p>');
  });
});
