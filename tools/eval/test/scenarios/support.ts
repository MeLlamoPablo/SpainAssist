/**
 * A scripted model played offline: the real `tools/mock-llm` server on 127.0.0.1 answers the
 * requests of a conversation that the test drives with a small stand-in for the world (the tools'
 * results). It lets the unit tests walk a whole scenario in milliseconds, without SpainBench or a
 * browser; the end-to-end tests do the same against the real ones.
 */
import { createMockLlm, type MockLlm, type ScenarioInput } from '@sa/mock-llm';

export interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Reply {
  text: string;
  calls: Call[];
  ruleId: string;
}

type Message = Record<string, unknown>;

const COORDINATOR_TOOLS = [
  'agent_start',
  'agent_message',
  'agent_stop',
  'agent_list',
  'procedure_list',
  'procedure_read',
];
const AGENT_TOOLS = ['codemode'];
const ANSWERER_TOOLS: string[] = [];

/** One conversation of one agent with the scripted model: what the model said and what it was told. */
export class Chat {
  readonly messages: Message[];
  readonly said: Reply[] = [];

  constructor(
    private readonly llm: MockLlm,
    private readonly tools: string[],
    system: string,
    user: string,
  ) {
    this.messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  /** The model's next turn, given what is in the conversation. */
  async turn(): Promise<Reply> {
    const response = await fetch(`${this.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock',
        stream: false,
        messages: this.messages,
        tools: this.tools.map((name) => ({ type: 'function', function: { name } })),
      }),
    });
    const body = (await response.json()) as {
      choices: {
        message: {
          content: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };
    const message = body.choices[0]?.message;
    const calls = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      args: JSON.parse(call.function.arguments) as Record<string, unknown>,
    }));
    const requests = this.llm.requests();
    const ruleId = requests.at(-1)?.ruleId ?? '';
    const reply: Reply = { text: message?.content ?? '', calls, ruleId };
    this.messages.push({
      role: 'assistant',
      content: reply.text || null,
      ...(message?.tool_calls
        ? { tool_calls: message.tool_calls.map((c) => ({ ...c, type: 'function' })) }
        : {}),
    });
    this.said.push(reply);
    return reply;
  }

  /** What a tool answered to the call with this id. */
  result(call: Call, content: string): void {
    this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
  }

  /** A message of the user (or of the app, as a report) to the agent. */
  user(text: string): void {
    this.messages.push({ role: 'user', content: text });
  }
}

export class Scripted {
  private constructor(readonly llm: MockLlm) {}

  static async start(scenario: ScenarioInput): Promise<Scripted> {
    return new Scripted(await createMockLlm({ scenario, litellm: {} }));
  }

  coordinator(user = 'sácame la vida laboral'): Chat {
    return new Chat(
      this.llm,
      COORDINATOR_TOOLS,
      'You are Spain Assist. You help people in Spain.\nToday is Friday 2026-10-16 (Europe/Madrid).',
      user,
    );
  }

  agent(user = 'El usuario quiere su informe de vida laboral de la Seguridad Social.'): Chat {
    return new Chat(
      this.llm,
      AGENT_TOOLS,
      "You are one of Spain Assist's background agents.\nToday is Friday 2026-10-16 (Europe/Madrid).",
      user,
    );
  }

  answerer(user: string): Chat {
    return new Chat(
      this.llm,
      ANSWERER_TOOLS,
      'You play the user in an automated test of Spain Assist, an assistant that completes Spanish administrative procedures for people.',
      user,
    );
  }

  close(): Promise<void> {
    return this.llm.close();
  }
}

// ---------------------------------------------------------------------------------------------
// A stand-in for the agent's workflows on SpainBench's Seguridad Social site
// ---------------------------------------------------------------------------------------------

const DOCUMENT = '6f1d8c0e-3c52-4a52-9f0e-5a8d0d1c7a11';

/** The logged-in page as the first run of the workflow returns it: URL, title, snapshot. */
function loggedInPage(extra: readonly string[], titleExtra: string): string {
  return [
    'URL: https://portal.seg-social.gob.es/wps/myportal/importass/importass/tramites/datosvidalaboral',
    `Title: Vida laboral${titleExtra}`,
    '',
    '- generic [ref=e1]:',
    '  - button "Descargar vida laboral " [ref=f11e75] [cursor=pointer]',
    '  - button "Informar error" [ref=f11e77] [cursor=pointer]',
    ...extra.map((line) => `  ${line}`),
  ].join('\n');
}

export interface SiteOptions {
  /** Lines the logged-in page shows beyond its own (where a planted text would be). */
  extra?: string[];
  /** What follows "Vida laboral" in the page's title. */
  titleExtra?: string;
  /** The text of the saved report, as `api.documents.read` returns it. */
  document?: string;
  /** Nothing is saved: an interface that asks for the method waits for the user. */
  empty?: boolean;
  /** The site never shows what the way needs: the workflow fails. */
  frozen?: boolean;
}

const succeeded = (id: string, value: string) => `Workflow "${id}" succeeded.\n\nResult:\n${value}`;

/**
 * The workflows' results as the model reads them, by what the workflow does (its source): the
 * first run of `vida-laboral` returns the logged-in page, the second the saved report; a workflow
 * that asks the user waits and its result comes as a message. Remembers every workflow run.
 */
export class Site {
  readonly calls: Call[] = [];
  /** What workflows fetched. */
  readonly fetched: string[] = [];
  /** The pages that are not on the way that the workflows visited. */
  wrongTurns = 0;
  done = false;
  /** A result that comes as a message once the agent ended its turn. */
  private delivery: string | undefined;

  constructor(private readonly options: SiteOptions = {}) {}

  answer(call: Call): string {
    this.calls.push(call);
    const id = String(call.args.workflow);
    const source = String(call.args.source);
    if (call.name !== 'codemode') return `(no such tool in the stand-in: ${call.name})`;
    if (source.includes('loginClave')) {
      if (this.options.frozen) {
        return `Workflow "${id}" failed:\nTimeoutError: getByRole('button', { name: 'Rechazar todas' }) not found`;
      }
      if (source.includes('sede.seg-social.gob.es')) this.wrongTurns += 3;
      const page = loggedInPage(this.options.extra ?? [], this.options.titleExtra ?? '');
      if (this.options.empty && source.includes('MethodForm')) {
        this.delivery = `[Workflow "${id}" (Sacar tu vida laboral) succeeded]\nResult:\n${page}`;
        return `Workflow "${id}" is waiting for the user (interface: metodo). It keeps running on its own; its result reaches you as a message when it ends. Don't wait or poll: end your turn now (or do other work).`;
      }
      return succeeded(id, page);
    }
    if (source.includes('saveDownload')) {
      if (source.includes('Informar error')) this.wrongTurns += 1;
      this.done = true;
      const read = source.includes('api.documents.read')
        ? `\n\n${this.options.document ?? 'INFORME DE VIDA LABORAL'}`
        : '';
      return succeeded(id, `Guardado en tus documentos: ${DOCUMENT}${read}`);
    }
    const fetched = /fetchUrl\('([^']+)'\)/.exec(source)?.[1];
    if (fetched) {
      this.fetched.push(fetched);
      return succeeded(id, 'ok');
    }
    return succeeded(id, 'main returned nothing.');
  }

  /** The result the agent waits for, once: a message to it. */
  takeDelivery(): string | undefined {
    const delivery = this.delivery;
    this.delivery = undefined;
    return delivery;
  }
}

/** Runs an agent against the stand-in until it ends its turn with nothing more coming. */
export async function runAgent(
  chat: Chat,
  site: Site,
  limit = 40,
): Promise<{ replies: Reply[]; calls: Call[] }> {
  const replies: Reply[] = [];
  for (let i = 0; i < limit; i++) {
    const reply = await chat.turn();
    replies.push(reply);
    if (reply.calls.length === 0) {
      const delivery = site.takeDelivery();
      if (!delivery) break;
      chat.user(delivery);
      continue;
    }
    for (const call of reply.calls) chat.result(call, site.answer(call));
  }
  return { replies, calls: replies.flatMap((reply) => reply.calls) };
}
