/**
 * Scripted models of the end-to-end tests that no run of `eval run` needs: a procedure agent that
 * stops half-way (to leave a checkpoint) and the model of the run that carries on from it. They are
 * made of the same pieces as the scenarios of `src/scenarios`.
 */
import type { ScenarioInput } from '@sa/mock-llm';
import {
  answererRules,
  flowOf,
  ORCHESTRATOR,
  orchestratorRules,
  PROCEDURE_AGENT,
  procedureStages,
  REPORT_PREFIX,
  type Rule,
  sequence,
  stagesFromDownload,
  stagesUntilLogin,
  VIDA_LABORAL_URL,
  waitForText,
} from '../../src/scenarios';

function flow(fixtureId: string) {
  const found = flowOf(fixtureId);
  if (!found) throw new Error(`No scenario for ${fixtureId}`);
  return found;
}

/**
 * The oracle until the login is over, then it stops and asks the user whether to go on: the run
 * goes quiet with the report not saved (the checkpoint is taken there).
 */
export function pausedAfterLogin(fixtureId: string): ScenarioInput {
  const { fromScratch } = flow(fixtureId);
  const relay: Rule = {
    id: 'assistant-relays-question',
    when: { ...ORCHESTRATOR, lastUser: REPORT_PREFIX },
    reply: { text: 'Ya he entrado con tu Cl@ve Permanente. ¿Sigo con la descarga?' },
  };
  return {
    name: `paused-after-login:${fixtureId}`,
    rules: [
      ...answererRules(),
      relay,
      ...orchestratorRules({ askMethod: fromScratch }),
      ...sequence(PROCEDURE_AGENT, 'p', [
        ...stagesUntilLogin({}),
        {
          id: 'asks-to-go-on',
          text: 'He entrado con tu Cl@ve Permanente. ¿Sigo con la descarga de tu vida laboral?',
        },
      ]),
    ],
    fallback: { text: 'Hecho.' },
  };
}

/**
 * The model of a restored app, after the user says "go on": the orchestrator reads the card and
 * resumes the procedure (the procedure's id is in the conversation it carries), whose agent opens
 * the logged-in page again (the login must still hold) and finishes the job.
 */
export function resumedAfterLogin(fixtureId: string): ScenarioInput {
  const { fromScratch } = flow(fixtureId);
  const started = { name: 'procedure_start', result: 'Started (?<pid>p_[0-9a-f]{16})' };
  const resumes: Rule[] = [
    {
      id: 'assistant-resumes',
      when: {
        ...ORCHESTRATOR,
        lastUser: '^Sigue donde lo dejaste',
        toolCalled: [started, { name: 'procedure_message', atMost: 0 }],
      },
      reply: {
        toolCalls: [
          { id: 'read', name: 'procedure_read', arguments: { procedureId: '{{pid}}' } },
          {
            id: 'resume',
            name: 'procedure_message',
            arguments: {
              procedureId: '{{pid}}',
              message: 'El usuario quiere que sigas con la descarga de su vida laboral.',
            },
          },
        ],
      },
    },
    {
      id: 'assistant-says-resumed',
      when: { ...ORCHESTRATOR, lastTool: 'procedure_message' },
      reply: { text: 'Retomo la descarga. Te aviso en cuanto esté.' },
    },
  ];
  return {
    name: `resumed-after-login:${fixtureId}`,
    rules: [
      ...answererRules(),
      ...resumes,
      ...orchestratorRules({ askMethod: fromScratch }),
      ...sequence(PROCEDURE_AGENT, 'p', [
        {
          id: 'reopen',
          calls: [{ id: 'reopen', name: 'browser_open', arguments: { url: VIDA_LABORAL_URL } }],
        },
        waitForText('reopen-ready', 'Descargar vida laboral'),
        ...stagesFromDownload({}),
      ]),
    ],
    fallback: { text: 'Hecho.' },
  };
}

/**
 * The oracle for the fixture with a question nobody scripted: after its plan the procedure agent
 * asks the user for their province (a form without options, which no answer of the fixtures covers).
 */
export function asksProvince(fixtureId: string): ScenarioInput {
  const { fromScratch } = flow(fixtureId);
  const stages = procedureStages({});
  const plan = stages.findIndex((stage) => stage.id === 'plan');
  stages.splice(plan + 1, 0, {
    id: 'asks-province',
    calls: [
      {
        id: 'province',
        name: 'ask_user',
        arguments: {
          title: '¿En qué provincia vives?',
          message: 'Me hace falta para elegir la oficina.',
          fields: [{ key: 'provincia', label: 'Provincia', type: 'text', required: true }],
        },
      },
    ],
  });
  return {
    name: `asks-province:${fixtureId}`,
    rules: [
      ...answererRules(),
      ...orchestratorRules({ askMethod: fromScratch }),
      ...sequence(PROCEDURE_AGENT, 'p', stages),
    ],
    fallback: { text: 'Hecho.' },
  };
}
