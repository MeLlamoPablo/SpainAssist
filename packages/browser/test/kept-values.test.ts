import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestService, page, refOf, startServer, type TestServer } from './helpers';

// Fields whose page keeps, clears or blocks what the agent types.
const FIELDS = page(
  `<label>Nombre <input></label>
   <label>Fecha <input id=fecha placeholder="01/01/2021"></label>
   <label>Código <input id=codigo></label>
   <label>Bloqueada <input readonly value="01/01/2021"></label>
   <label>Marcada <input id=marcada aria-readonly="true"></label>
   <label>Clave <input id=clave type=password></label>
   <label>Clave buena <input type=password></label>
   <script>
     // A custom date picker that only accepts dates chosen in its calendar.
     fecha.addEventListener('blur', () => { fecha.value = ''; });
     codigo.addEventListener('input', () => { codigo.value = ''; });
     marcada.addEventListener('blur', () => { marcada.value = ''; });
     clave.addEventListener('blur', () => { clave.value = ''; });
   </script>`,
);

let server: TestServer;
let t: ReturnType<typeof createTestService>;

beforeAll(async () => {
  server = await startServer({ '/fields': FIELDS });
  t = createTestService();
});

afterAll(async () => {
  await t?.cleanup();
  await server?.close();
});

/** Types into the textbox labelled `label` on a fresh page and returns the notes. */
async function typeInto(label: string, text: string, opts: { secret?: boolean } = {}) {
  const procedureId = `kept-${label}`;
  const opened = await t.service.open(procedureId, `${server.origin}/fields`);
  const ref = refOf(opened.snapshot, `textbox "${label}"`);
  const obs = await t.service.type(procedureId, ref, text, opts);
  return { ref, notes: obs.notes.join('\n'), snapshot: obs.snapshot };
}

describe('typing reports values the page did not keep', () => {
  it('adds no note when the field keeps the value', async () => {
    const { notes } = await typeInto('Nombre', 'María');
    expect(notes).toBe('');
  });

  it('reports the value a date picker left after losing focus', async () => {
    const { ref, notes } = await typeInto('Fecha', '15/01/2022');
    expect(notes).toContain(
      `${ref} now contains "" (typed "15/01/2022"): the page rejected or reformatted the value.`,
    );
    expect(notes).toContain('picker/calendar');
  });

  it('reports a field whose script clears every key', async () => {
    const { ref, notes } = await typeInto('Código', 'ABC123');
    expect(notes).toContain(`${ref} now contains "" (typed "ABC123")`);
  });

  it('does not type into a read-only field and says so', async () => {
    const { ref, notes, snapshot } = await typeInto('Bloqueada', '15/01/2022');
    expect(notes).toContain(`${ref} is read-only, so nothing was typed.`);
    expect(snapshot).not.toContain('15/01/2022');
  });

  it('mentions aria-readonly when the page then clears the value', async () => {
    const { notes } = await typeInto('Marcada', '15/01/2022');
    expect(notes).toContain('It is marked read-only.');
  });

  it('reports an emptied password field without echoing the value', async () => {
    const secret = 'S3cr3t pass!';
    // Not flagged as secret: the password input type alone keeps it out of the note.
    const { ref, notes } = await typeInto('Clave', secret);
    expect(notes).toContain(`${ref} is empty: the page rejected or reformatted the value.`);
    expect(notes).not.toContain(secret);
  });

  it('adds no note when a password field keeps the value', async () => {
    const { notes } = await typeInto('Clave buena', 'otra-clave');
    expect(notes).toBe('');
  });
});
