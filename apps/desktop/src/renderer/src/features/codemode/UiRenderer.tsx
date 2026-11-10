import {
  APPOINTMENT_MORE,
  type FormField,
  type UiElement,
  type UiEvent,
  type UiHandler,
  type UiNode,
  uiTreeProblem,
} from '@sa/shared';
import { ArrowUpRight, Check } from 'lucide-react';
import { ToggleGroup } from 'radix-ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ErrorBoundary, Unshowable } from '../../components/ErrorBoundary';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/controls';
import { Field, Input, Select, Textarea } from '../../components/ui/field';
import { Callout, Spinner, type Tone } from '../../components/ui/misc';
import { ProvinceSelect } from '../../components/ui/province-select';
import { useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../store/toast';
import { AppointmentPicker } from '../chat/prompts/AppointmentPicker';
import { chipClass, DocumentPicker } from '../chat/prompts/FormPromptCard';
import { MapOptionsPicker } from '../chat/prompts/MapOptionsPicker';
import { describeFailure, reportUiFailure } from './failures';
import { codemodeDict } from './i18n';

/**
 * Renders a workflow's interface (a tree of `@spainassist/ui` components, validated by main)
 * with the app's own controls. The workflow keeps the components' code in its sandbox; here every
 * handler is an id, and acting sends `codemode.uiEvent`. Inputs keep what the user types locally
 * so typing never waits for a round trip; the next tree from the workflow catches up. A node the
 * app can't draw fails the whole interface: main tells its workflow, whose `present` throws.
 */

interface UiContext {
  workflowId: string;
  uiKey: string;
  rev: number;
  send(handler: UiHandler | undefined, value?: UiEvent['value']): Promise<void>;
  fail(node: UiElement, error: unknown): void;
}

const Ctx = createContext<UiContext | null>(null);

function useUi(): UiContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('UiRenderer context missing');
  return ctx;
}

export function UiRenderer({
  workflowId,
  uiKey,
  tree,
  rev,
}: {
  workflowId: string;
  uiKey: string;
  tree: UiNode;
  rev: number;
}) {
  const t = useT(codemodeDict);
  const revRef = useRef(rev);
  revRef.current = rev;
  const send = useCallback(
    async (handler: UiHandler | undefined, value?: UiEvent['value']) => {
      if (!handler) return;
      try {
        const delivered = await api.invoke('codemode.uiEvent', workflowId, uiKey, {
          handler: handler.$handler,
          rev: revRef.current,
          ...(value !== undefined ? { value } : {}),
        });
        if (!delivered) toast.info(t.closed);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [workflowId, uiKey, t.closed],
  );
  const [failedRev, setFailedRev] = useState<number | null>(null);
  const fail = useCallback(
    (node: UiElement, error: unknown) => {
      setFailedRev(revRef.current);
      reportUiFailure(workflowId, uiKey, revRef.current, describeFailure(node, error));
    },
    [workflowId, uiKey],
  );
  // Trees saved before main checked them all (one showing nothing, say) are reported the same way.
  const problem = useMemo(() => uiTreeProblem(tree), [tree]);
  useEffect(() => {
    if (problem) reportUiFailure(workflowId, uiKey, rev, describeFailure(undefined, problem));
  }, [problem, workflowId, uiKey, rev]);
  // Main takes it off the screen; a newer tree from the workflow may draw.
  if (problem || failedRev === rev) return <Unshowable what="question">{t.unshowable}</Unshowable>;
  return (
    <Ctx.Provider value={{ workflowId, uiKey, rev, send, fail }}>
      <div className="flex flex-col gap-4" data-testid="workflow-ui" data-key={uiKey}>
        <Nodes nodes={typeof tree === 'string' ? [tree] : tree.children} path="r" />
      </div>
    </Ctx.Provider>
  );
}

function Nodes({ nodes, path }: { nodes: UiNode[]; path: string }) {
  const ui = useUi();
  return (
    <>
      {nodes
        // Siblings are identified by their place in the tree, as the workflow's renderer does.
        .map((node, index) => ({ node, at: `${path}.${index}` }))
        .map(({ node, at }) =>
          typeof node === 'string' ? (
            <span key={at}>{node}</span>
          ) : (
            // The innermost node that fails names itself in the report.
            <ErrorBoundary
              key={`${at}:${node.type}`}
              fallback={null}
              onError={(error) => ui.fail(node, error)}
            >
              <Node node={node} path={at} />
            </ErrorBoundary>
          ),
        )}
    </>
  );
}

function text(node: UiElement): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

const TONES: Record<string, Tone> = {
  default: 'neutral',
  muted: 'neutral',
  info: 'research',
  success: 'done',
  warning: 'attention',
  error: 'blocked',
};

/** A prop of a node, typed by the caller (main validated the tree; trees stored before may lack props). */
function prop<T>(node: UiElement, name: string): T | undefined {
  return node.props?.[name] as T | undefined;
}

function Node({ node, path }: { node: UiElement; path: string }): ReactNode {
  const ui = useUi();
  const kids = <Nodes nodes={node.children} path={path} />;
  switch (node.type) {
    case 'Root':
      return kids;
    case 'Form':
      return (
        <section className="flex flex-col gap-4" aria-label={prop<string>(node, 'title')}>
          {prop<string>(node, 'title') ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-[15px] font-semibold leading-snug text-fg">
                {prop<string>(node, 'title')}
              </h3>
              {prop<string>(node, 'description') ? (
                <p className="text-[13.5px] leading-relaxed text-fg-muted">
                  {prop<string>(node, 'description')}
                </p>
              ) : null}
            </div>
          ) : null}
          {kids}
        </section>
      );
    case 'Section':
      return (
        <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
          {prop<string>(node, 'title') ? (
            <h4 className="text-[12.5px] font-semibold tracking-wide text-fg-subtle uppercase">
              {prop<string>(node, 'title')}
            </h4>
          ) : null}
          {kids}
        </section>
      );
    case 'Text': {
      const tone = prop<string>(node, 'tone') ?? 'default';
      return (
        <p
          className={cn(
            'selectable leading-relaxed',
            prop<string>(node, 'size') === 'sm' ? 'text-[12.5px]' : 'text-[14px]',
            tone === 'muted'
              ? 'text-fg-muted'
              : tone === 'error'
                ? 'text-danger'
                : tone === 'warning'
                  ? 'text-st-attention-fg'
                  : tone === 'success'
                    ? 'text-st-done-fg'
                    : 'text-fg',
          )}
        >
          {kids}
        </p>
      );
    }
    case 'Callout':
      return (
        <Callout
          tone={TONES[prop<string>(node, 'tone') ?? 'info'] ?? 'research'}
          title={prop<string>(node, 'title')}
        >
          {kids}
        </Callout>
      );
    case 'Facts':
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
          {(prop<{ label: string; value: string }[]>(node, 'items') ?? []).map((item) => (
            <div key={item.label} className="contents">
              <dt className="text-fg-muted">{item.label}</dt>
              <dd className="selectable text-fg">{item.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'Link': {
      const href = prop<string>(node, 'href') ?? '';
      return (
        <button
          type="button"
          onClick={() => href.startsWith('https://') && void api.invoke('app.openExternal', href)}
          className="inline-flex items-center gap-1 self-start text-[13.5px] font-medium text-accent-text underline-offset-4 hover:underline"
        >
          {kids}
          <ArrowUpRight size={13} aria-hidden />
        </button>
      );
    }
    case 'Divider':
      return <hr className="border-line" />;
    case 'Progress':
      return (
        <p className="flex items-center gap-2 text-[13px] text-fg-muted" aria-live="polite">
          <Spinner size={14} className="text-fg-subtle" />
          {prop<string>(node, 'label')}
        </p>
      );
    case 'Actions':
      return <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{kids}</div>;
    case 'Button':
      return <UiButton node={node} />;
    case 'TextField':
      return <UiTextField node={node} />;
    case 'Select':
      return <UiSelect node={node} />;
    case 'Choice':
    case 'MultiChoice':
      return <UiChoice node={node} multiple={node.type === 'MultiChoice'} />;
    case 'Checkbox':
      return <UiCheckbox node={node} />;
    case 'Province':
      return <UiProvince node={node} />;
    case 'DocumentPicker':
      return <UiDocument node={node} />;
    case 'Map':
      return <UiMap node={node} />;
    case 'Appointment':
      return <UiAppointment node={node} />;
    default:
      void ui;
      return null;
  }
}

/** The value the user is choosing: theirs while they act, the workflow's otherwise. */
function useLocalValue<T>(node: UiElement, name = 'value', fallback: T): [T, (v: T) => void] {
  const ui = useUi();
  const fromTree = (prop<T>(node, name) ?? fallback) as T;
  const [local, setLocal] = useState<{ value: T; rev: number } | null>(null);
  // A newer tree from the workflow wins once it reflects (or replaces) what the user did.
  useEffect(() => {
    if (local && ui.rev > local.rev && JSON.stringify(fromTree) === JSON.stringify(local.value))
      setLocal(null);
  }, [ui.rev, fromTree, local]);
  const handler = prop<UiHandler>(node, name === 'checked' ? 'onChange' : 'onChange');
  const change = (value: T) => {
    setLocal({ value, rev: ui.rev });
    void ui.send(handler, value as UiEvent['value']);
  };
  return [local ? local.value : fromTree, change];
}

function UiButton({ node }: { node: UiElement }) {
  const ui = useUi();
  const [pending, setPending] = useState<number | null>(null);
  // Pending until the workflow answers with a new tree (or closes the interface).
  useEffect(() => {
    if (pending !== null && ui.rev > pending) setPending(null);
  }, [ui.rev, pending]);
  const type = prop<string>(node, 'type') ?? 'secondary';
  return (
    <Button
      variant={
        type === 'primary'
          ? 'primary'
          : type === 'danger'
            ? 'danger'
            : type === 'ghost'
              ? 'ghost'
              : 'secondary'
      }
      disabled={prop<boolean>(node, 'disabled')}
      loading={prop<boolean>(node, 'loading') || pending !== null}
      onClick={() => {
        setPending(ui.rev);
        void ui.send(prop<UiHandler>(node, 'onClick'));
        window.setTimeout(() => setPending(null), 8_000);
      }}
    >
      {text(node)}
    </Button>
  );
}

function UiField({
  node,
  children,
}: {
  node: UiElement;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const tc = useT(common);
  const label = prop<string>(node, 'label');
  return (
    <Field
      label={label ?? ''}
      help={prop<string>(node, 'help')}
      error={prop<string>(node, 'error') ?? null}
      required={prop<boolean>(node, 'required') ?? true}
      optionalLabel={tc.optional}
    >
      {children}
    </Field>
  );
}

function UiTextField({ node }: { node: UiElement }) {
  const [value, setValue] = useLocalValue<string>(node, 'value', '');
  const type = prop<string>(node, 'type') ?? 'text';
  return (
    <UiField node={node}>
      {({ id, describedBy, invalid }) =>
        type === 'textarea' ? (
          <Textarea
            id={id}
            autosize
            minRows={3}
            maxRows={8}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={value}
            placeholder={prop<string>(node, 'placeholder')}
            disabled={prop<boolean>(node, 'disabled')}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            type={
              type === 'email'
                ? 'email'
                : type === 'phone'
                  ? 'tel'
                  : type === 'date'
                    ? 'date'
                    : 'text'
            }
            inputMode={type === 'number' ? 'decimal' : undefined}
            value={value}
            placeholder={prop<string>(node, 'placeholder')}
            disabled={prop<boolean>(node, 'disabled')}
            onChange={(e) => setValue(e.target.value)}
            className={type === 'number' || type === 'date' ? 'max-w-56' : undefined}
          />
        )
      }
    </UiField>
  );
}

function UiSelect({ node }: { node: UiElement }) {
  const t = useT(codemodeDict);
  const [value, setValue] = useLocalValue<string>(node, 'value', '');
  const options = prop<{ value: string; label: string }[]>(node, 'options') ?? [];
  return (
    <UiField node={node}>
      {({ id, describedBy, invalid }) => (
        <Select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={value}
          disabled={prop<boolean>(node, 'disabled')}
          onChange={(e) => setValue(e.target.value)}
        >
          {value === '' ? (
            <option value="">{prop<string>(node, 'placeholder') ?? t.chooseOne}</option>
          ) : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </UiField>
  );
}

function UiChoice({ node, multiple }: { node: UiElement; multiple: boolean }) {
  const [single, setSingle] = useLocalValue<string>(node, 'value', '');
  const [list, setList] = useLocalValue<string[]>(node, 'value', []);
  const options =
    prop<{ value: string; label: string; description?: string }[]>(node, 'options') ?? [];
  const label = prop<string>(node, 'label');
  const group = (
    <ToggleGroup.Root
      {...(multiple
        ? { type: 'multiple' as const, value: list, onValueChange: (v: string[]) => setList(v) }
        : {
            type: 'single' as const,
            value: single,
            onValueChange: (v: string) => v && setSingle(v),
          })}
      aria-label={label}
      disabled={prop<boolean>(node, 'disabled')}
      className="flex flex-wrap gap-2"
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(chipClass, o.description && 'h-auto flex-col items-start py-2 text-left')}
        >
          <span className="inline-flex items-center gap-1.5">
            {multiple ? (
              <Check size={14} className="hidden in-data-[state=on]:inline" aria-hidden />
            ) : null}
            {o.label}
          </span>
          {o.description ? (
            <span className="text-[12px] font-normal text-fg-subtle">{o.description}</span>
          ) : null}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
  if (!label) return group;
  return <UiField node={node}>{() => group}</UiField>;
}

function UiCheckbox({ node }: { node: UiElement }) {
  const [checked, setChecked] = useLocalValue<boolean>(node, 'checked', false);
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={setChecked}
      label={prop<string>(node, 'label') ?? ''}
      description={prop<string>(node, 'help')}
      disabled={prop<boolean>(node, 'disabled')}
    />
  );
}

function UiProvince({ node }: { node: UiElement }) {
  const t = useT(codemodeDict);
  const [value, setValue] = useLocalValue<string>(node, 'value', '');
  return (
    <UiField
      node={{ ...node, props: { ...node.props, label: prop<string>(node, 'label') ?? t.province } }}
    >
      {({ id, describedBy, invalid }) => (
        <ProvinceSelect
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-label={t.province}
          value={value}
          onValueChange={setValue}
        />
      )}
    </UiField>
  );
}

function UiDocument({ node }: { node: UiElement }) {
  const [value, setValue] = useLocalValue<string>(node, 'value', '');
  return (
    <UiField node={node}>
      {({ id, describedBy }) => (
        <DocumentPicker
          inputId={id}
          value={value}
          onChange={setValue}
          {...(describedBy ? { describedBy } : {})}
        />
      )}
    </UiField>
  );
}

function asField(node: UiElement, type: FormField['type'], key: string): FormField {
  return {
    key,
    label: prop<string>(node, 'label') ?? '',
    type,
    required: true,
    ...(prop(node, 'options') ? { options: prop<FormField['options']>(node, 'options') } : {}),
    ...(prop(node, 'slots') ? { slots: prop<string[]>(node, 'slots') } : {}),
  };
}

function UiMap({ node }: { node: UiElement }) {
  const ui = useUi();
  const t = useT(codemodeDict);
  const key = useId();
  const [value, setValue] = useLocalValue<string>(node, 'value', '');
  const options = prop<{ address: string }[]>(node, 'options') ?? [];
  const addresses = options.map((o) => o.address);
  const addressKey = addresses.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the addresses are what matter
  const loadPins = useCallback(
    () => api.invoke('codemode.pins', ui.workflowId, ui.uiKey, addresses),
    [ui.workflowId, ui.uiKey, addressKey],
  );
  const field = asField(node, 'map-options', key);
  return (
    <UiField
      node={{ ...node, props: { ...node.props, label: prop<string>(node, 'label') ?? t.place } }}
    >
      {({ id, describedBy, invalid }) => (
        <MapOptionsPicker
          promptId={`${ui.workflowId}/${ui.uiKey}`}
          field={field}
          value={value}
          onChange={setValue}
          inputId={id}
          {...(describedBy ? { describedBy } : {})}
          invalid={invalid}
          onReadyChange={() => {}}
          loadPins={loadPins}
        />
      )}
    </UiField>
  );
}

function UiAppointment({ node }: { node: UiElement }) {
  const t = useT(codemodeDict);
  const key = useId();
  const [value, setValue] = useLocalValue<string>(node, 'value', '');
  const field = asField(node, 'appointment', key);
  return (
    <UiField
      node={{
        ...node,
        props: { ...node.props, label: prop<string>(node, 'label') ?? t.appointment },
      }}
    >
      {({ id, describedBy, invalid }) => (
        <AppointmentPicker
          field={field}
          value={value === APPOINTMENT_MORE ? '' : value}
          onChange={setValue}
          onRequestMore={() => prop<boolean>(node, 'allowMore') && setValue(APPOINTMENT_MORE)}
          inputId={id}
          {...(describedBy ? { describedBy } : {})}
          invalid={invalid}
        />
      )}
    </UiField>
  );
}
