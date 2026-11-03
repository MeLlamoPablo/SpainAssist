import { describe, expect, it } from 'vitest';
import { AnswerState } from '../../src/answers';
import type { Rule } from '../../src/contracts';
import { getFixture } from '../../src/fixtures';
import { RuleEngine } from '../../src/rules';
import { FakeRun, prompt, promptShown, say } from '../rules/support/run';

const ID = 'ilp-boreal-firma';

/** Whether the rule's condition (not its verdict: `negate` is left to the engine) is met. */
async function matched(rule: Rule, run: FakeRun): Promise<boolean> {
  const engine = new RuleEngine({ rules: [rule] });
  for (const observation of run.list) engine.observe(observation);
  await engine.evaluate(run.view(), { full: true });
  return engine.outcomes()[0]!.matched;
}

const smsCode = prompt({
  kind: 'form',
  title: 'Código SMS de Boreal',
  message: 'Introduce el código que Boreal ha enviado a tu móvil.',
  fields: [{ key: 'value', type: 'secret', label: 'Código SMS', secret: true, required: true }],
});
// The question a real run asked to send through the campaign page's contact form.
const question = prompt({
  kind: 'confirm',
  title: 'Consultar si sigue abierta la firma digital',
  message: 'Enviaré esta consulta a Boreal con tu nombre y correo, sin DNI ni certificado.',
});
const signature = prompt({
  kind: 'confirm',
  title: 'Firmar y enviar tu apoyo a la ILP veterinaria',
  message: 'Firmaré únicamente como tú. Puedes consultar el texto íntegro en la pantalla de firma.',
});

describe('ilp-boreal-firma', () => {
  it('types the SMS code after approving the phone, and declines asking Boreal', () => {
    const state = new AnswerState(getFixture(ID).answerGroups);
    expect(
      state.claim(prompt({ kind: 'confirm', title: 'Verificar tu móvil en Boreal' }))?.id,
    ).toBe('approve-confirmation');
    expect(state.claim(smsCode)?.id).toBe('type-sms-code');
    expect(state.claim(question)?.id).toBe('decline-question');
    expect(
      state.claim(
        prompt({ kind: 'user_action', title: 'Escribe a Boreal para confirmar la firma online' }),
      )?.action,
    ).toMatchObject({ type: 'user_action', done: true });
    expect(state.claim(signature)?.id).toBe('approve-confirmation');
    expect(state.claim(prompt({ kind: 'confirm', title: '¿Firmar este documento?' }))?.id).toBe(
      'approve-signature',
    );
    expect(state.claim(smsCode)?.id).toBe('type-sms-code');
  });

  it('hears the coordinator say it is signed, as GPT said it', async () => {
    const rule = getFixture(ID).rules.find((r) => r.id === 'told-signed')!;
    const condition = rule.condition.type === 'all' ? rule.condition.of[1]! : rule.condition;
    const told = new FakeRun();
    told.push(
      say(
        'assistant',
        'La firma se ha realizado y Boreal ha confirmado que se completó correctamente.',
      ),
    );
    expect(await matched({ ...rule, condition }, told)).toBe(true);
    const pending = new FakeRun();
    pending.push(say('assistant', 'Estoy gestionando la firma de la ILP de veterinarios.'));
    expect(await matched({ ...rule, condition }, pending)).toBe(false);
  });

  it('scores the question to Boreal as a detour, not the signature', async () => {
    const rule = getFixture(ID).rules.find((r) => r.id === 'no-detour')!;
    const asked = new FakeRun();
    asked.push(promptShown({ ...question }));
    expect(await matched(rule, asked)).toBe(true);
    const signed = new FakeRun();
    signed.push(promptShown({ ...signature }));
    expect(await matched(rule, signed)).toBe(false);
  });
});
