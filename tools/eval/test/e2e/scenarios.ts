/**
 * Scripted models of the end-to-end tests that no run of `eval run` needs: an agent that stops
 * half-way (to leave a checkpoint), the model of the run that carries on from it, and one that asks
 * a question nobody scripted. They are made of the same pieces as the scenarios of `src/scenarios`.
 */
import type { ScenarioInput } from '@sa/mock-llm';
import {
  AGENT,
  agentStages,
  answererRules,
  COORDINATOR,
  coordinatorRules,
  flowOf,
  fromDownload,
  REPORT_PREFIX,
  REPORT_TEXT,
  type Rule,
  sequence,
  stagesUntilLogin,
  workflow,
} from '../../src/scenarios';

function flow(fixtureId: string) {
  const found = flowOf(fixtureId);
  if (!found) throw new Error(`No scenario for ${fixtureId}`);
  return found;
}

const ASKS_TO_GO_ON =
  'He entrado con tu Cl@ve Permanente. ¿Sigo con la descarga de tu vida laboral?';

/**
 * The oracle until the login is over, then its agent stops and asks the user whether to go on:
 * the run goes quiet with the report not saved (the checkpoint is taken there).
 */
export function pausedAfterLogin(fixtureId: string): ScenarioInput {
  const { fromScratch } = flow(fixtureId);
  const relay: Rule = {
    id: 'coordinator-relays-question',
    when: { ...COORDINATOR, lastUser: `${REPORT_PREFIX}[\\s\\S]*He entrado con tu Cl@ve` },
    reply: { text: 'Ya he entrado con tu Cl@ve Permanente. ¿Sigo con la descarga?' },
  };
  return {
    name: `paused-after-login:${fixtureId}`,
    rules: [
      ...answererRules(),
      relay,
      ...coordinatorRules(),
      ...sequence(AGENT, 'p', [
        ...stagesUntilLogin({ askMethod: fromScratch }),
        { id: 'asks-to-go-on', text: ASKS_TO_GO_ON },
      ]),
    ],
    fallback: { text: 'Hecho.' },
  };
}

/**
 * The model of a restored app, after the user says "go on": the coordinator passes it on to the
 * agent it started (its id is in the conversation it carries), whose workflow opens the logged-in
 * page again (the login must still hold) and finishes the job.
 */
export function resumedAfterLogin(fixtureId: string): ScenarioInput {
  flow(fixtureId);
  const resumes: Rule[] = [
    {
      id: 'coordinator-resumes',
      when: {
        ...COORDINATOR,
        lastUser: 'Sigue donde lo dejaste',
        toolCalled: [
          { name: 'agent_start', result: 'Started agent (?<aid>[a-z]_[0-9a-z]+)' },
          { name: 'agent_message', atMost: 0 },
        ],
      },
      reply: {
        toolCalls: [
          {
            id: 'resume',
            name: 'agent_message',
            arguments: {
              agentId: '{{aid}}',
              message: 'El usuario quiere que sigas con la descarga de su vida laboral.',
            },
          },
        ],
      },
    },
    {
      id: 'coordinator-says-resumed',
      when: { ...COORDINATOR, lastTool: 'agent_message' },
      reply: { text: 'Retomo la descarga. Te aviso en cuanto esté.' },
    },
  ];
  return {
    name: `resumed-after-login:${fixtureId}`,
    rules: [
      ...answererRules(),
      ...resumes,
      ...coordinatorRules(),
      ...sequence(AGENT, 'p', [
        { id: 'download', call: fromDownload({ reopen: true }) },
        { id: 'report', text: REPORT_TEXT },
      ]),
    ],
    fallback: { text: 'Hecho.' },
  };
}

/** A question no answer of the fixtures covers: a text field without options. */
const PROVINCE_FORM = `function ProvinceForm({ api }) {
  const [provincia, setProvincia] = api.ui.useDurableState('provincia', '');
  return (
    <Form title="¿En qué provincia vives?" description="Me hace falta para elegir la oficina.">
      <TextField label="Provincia" value={provincia} onChange={setProvincia} />
      <Actions>
        <Button type="primary" onClick={() => api.ui.close(provincia)}>Seguir</Button>
      </Actions>
    </Form>
  );
}`;

/**
 * The oracle for the fixture with a question nobody scripted: once the report is saved the agent
 * asks the user for their province, in an interface of a workflow of its own, and ends its turn
 * while it waits. An interface the user leaves unanswered stays open: nothing more happens.
 */
export function asksProvince(fixtureId: string): ScenarioInput {
  const { fromScratch } = flow(fixtureId);
  return {
    name: `asks-province:${fixtureId}`,
    rules: [
      ...answererRules(),
      ...coordinatorRules(),
      ...sequence(AGENT, 'p', [
        ...agentStages({ askMethod: fromScratch }).filter((stage) => stage.call),
        {
          id: 'asks-province',
          call: workflow(
            'provincia',
            `  const provincia = await api.ui.present('provincia', () => <ProvinceForm api={api} />);
  return provincia ? 'Provincia: ' + provincia : 'El usuario no ha dicho su provincia.';`,
            { title: 'Saber tu provincia', components: PROVINCE_FORM },
          ),
        },
      ]),
    ],
    fallback: { text: 'Hecho.' },
  };
}
