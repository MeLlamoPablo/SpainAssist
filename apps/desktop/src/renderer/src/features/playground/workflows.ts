import type { Language } from '@sa/shared';

export interface PlaygroundWorkflow {
  id: string;
  label: string;
  /** What it shows off. */
  code: string;
  /** The module, as an agent writes it (docs/codemode.md): run by the real kernel. */
  source: string;
}

/**
 * Example workflows for the playground: what codemode agents write, in the user's language,
 * against the playground's stand-in host (runner.ts). Together they use every component of
 * `@spainassist/ui` (examples.test.ts checks it).
 */
export function playgroundWorkflows(language: Language): PlaygroundWorkflow[] {
  const t = (es: string, en: string) => (language === 'es' ? es : en);
  /** A string literal for the source. */
  const q = (es: string, en: string) => JSON.stringify(t(es, en));
  return [
    {
      id: 'cita-dni',
      label: t('Cita para el DNI', 'DNI appointment'),
      code: 'present · memo · confirm',
      source: `import { Form, Map, Choice, TextField, Appointment, Actions, Button } from "@spainassist/ui";

const OFFICES = [
  { value: "triana", label: "Comisaría Sevilla-Triana", address: "Calle de ejemplo 20, Sevilla" },
  { value: "sur", label: "Comisaría Sevilla-Sur", address: "Avenida de ejemplo 1, Sevilla" },
  { value: "centro", label: "Comisaría Sevilla-Centro", address: "Plaza de ejemplo 3, Sevilla" },
];

function WhereAndWhen({ api }) {
  const [office, setOffice] = api.ui.useDurableState("office", "");
  const [time, setTime] = api.ui.useDurableState("time", "morning");
  const [from, setFrom] = api.ui.useDurableState("from", "2026-12-01");
  return (
    <Form
      title=${q('Cita para renovar el DNI', 'Appointment to renew your DNI')}
      description=${q('Busco la primera cita libre que te encaje.', 'I look for the first free slot that suits you.')}
    >
      <Map label=${q('Oficina', 'Office')} options={OFFICES} value={office} onChange={setOffice} />
      <Choice
        label=${q('¿A qué hora te viene mejor?', 'What time suits you best?')}
        options={[
          { value: "morning", label: ${q('Mañanas', 'Mornings')} },
          { value: "afternoon", label: ${q('Tardes', 'Afternoons')} },
        ]}
        value={time}
        onChange={setTime}
      />
      <TextField label=${q('A partir de', 'From')} type="date" value={from} onChange={setFrom} />
      <Actions>
        <Button type="primary" disabled={!office} onClick={() => api.ui.close({ office, time, from })}>
          ${t('Buscar cita', 'Find a slot')}
        </Button>
      </Actions>
    </Form>
  );
}

function PickSlot({ api, office, slots }) {
  const [slot, setSlot] = api.ui.useDurableState("slot", "");
  return (
    <Form title=${q('Elige tu cita', 'Pick your appointment')} description={office.label}>
      <Appointment
        slots={slots}
        value={slot}
        allowMore
        onChange={(value) => (value === "more" ? api.ui.close(null) : setSlot(value))}
      />
      <Actions>
        <Button type="primary" disabled={!slot} onClick={() => api.ui.close(slot)}>
          ${t('Reservar esta cita', 'Book this slot')}
        </Button>
      </Actions>
    </Form>
  );
}

export async function main(api) {
  const wish = await api.ui.present("where-and-when", () => <WhereAndWhen api={api} />);
  const office = OFFICES.find((o) => o.value === wish.office);

  await api.setStatus(${q('Buscando citas libres en ', 'Looking for free slots at ')} + office.label + "…");
  // Memoized: a resumed run doesn't read the page again.
  const slots = await api.state.memo("slots", async () => {
    const page = await api.fetchUrl(
      "https://sede.example.gob.es/cita-dni?oficina=" + wish.office + "&desde=" + wish.from + "&franja=" + wish.time,
    );
    return page.text.split("\\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  });

  const slot = await api.ui.present("slot", () => <PickSlot api={api} office={office} slots={slots} />);
  if (!slot) return { booked: false, reason: "none of the slots suits the user" };

  const ok = await api.user.confirm({
    kind: "action",
    title: ${q('Reservar la cita', 'Book the appointment')},
    message: ${q('Voy a reservar esta cita en la sede de la Policía.', 'I will book this appointment on the Police website.')},
    details: [
      { label: ${q('Oficina', 'Office')}, value: office.label },
      { label: ${q('Fecha', 'Date')}, value: slot.replace("T", " ") },
    ],
  });
  if (!ok) return { booked: false, reason: "the user declined" };

  await api.setStatus(${q('Reservando la cita…', 'Booking the appointment…')});
  const dni = await api.procedures.getOrCreate({
    id: "renovar-dni",
    title: ${q('Renovar el DNI', 'Renew your DNI')},
    summary: ${q('Renovar el DNI caducado en una comisaría de Sevilla.', 'Renew the expired DNI at a police station in Seville.')},
    administration: { level: "state", name: ${q('Policía Nacional', 'National Police')} },
    facts: [
      { label: ${q('Coste', 'Cost')}, value: "12 €" },
      { label: ${q('Te lo dan', 'You get it')}, value: ${q('En el momento', 'On the spot')} },
    ],
  });
  await dni.update({
    nextAction: {
      text: ${q('Ve a la comisaría con tu DNI y una foto reciente.', 'Go to the police station with your DNI and a recent photo.')},
      owner: "user",
      appointment: { address: office.label + ", " + office.address, startsAt: slot },
    },
  });
  return { booked: true, office: office.label, slot };
}
`,
    },
    {
      id: 'datos',
      label: t('Datos de la solicitud', 'Application details'),
      code: 'TextField · Select · Province · DocumentPicker',
      source: `import { Form, Section, TextField, Select, Province, DocumentPicker, Text, Actions, Button } from "@spainassist/ui";

function Details({ api }) {
  const [form, setForm] = api.ui.useDurableState("form", {
    name: "", surname: "", email: "", phone: "", income: "", birth: "", province: "", reason: "", photo: "",
    reply: "email",
  });
  const [tried, setTried] = api.ui.useState(false);
  const set = (field) => (value) => setForm((prev) => ({ ...prev, [field]: value }));
  const missing = (field) => (tried && !form[field] ? ${q('Falta este dato.', 'This is missing.')} : undefined);
  const email = tried && form.email && !form.email.includes("@") ? ${q('Revisa el correo.', 'Check the email.')} : undefined;
  const complete = form.name && form.surname && form.email.includes("@") && form.birth && form.province && form.reason && form.photo;

  return (
    <Form
      title=${q('Datos para pedir la ayuda al alquiler', 'Details for the rent support application')}
      description=${q('Lo que la Junta pide en el formulario. Los que ya tenías guardados vienen rellenos.', 'What the regional government asks for. Saved details come filled in.')}
    >
      <Section title=${q('Tú', 'You')}>
        {/* vaultKey: when the interface closes, the app saves these answers to Mis datos itself. */}
        <TextField label=${q('Nombre', 'First name')} vaultKey="givenName" value={form.name} onChange={set("name")} error={missing("name")} />
        <TextField label=${q('Primer apellido', 'First surname')} vaultKey="surname1" value={form.surname} onChange={set("surname")} error={missing("surname")} />
        <TextField label=${q('Fecha de nacimiento', 'Date of birth')} type="date" vaultKey="birthDate" value={form.birth} onChange={set("birth")} error={missing("birth")} />
        <Province vaultKey="addressProvince" value={form.province} onChange={set("province")} error={missing("province")} />
      </Section>
      <Section title=${q('Contacto', 'Contact')}>
        <TextField label=${q('Correo electrónico', 'Email')} type="email" placeholder="nombre@ejemplo.es" vaultKey="email" value={form.email} onChange={set("email")} error={missing("email") || email} />
        <TextField label=${q('Teléfono', 'Phone')} type="phone" vaultKey="phone" value={form.phone} onChange={set("phone")} required={false} />
        <Select
          label=${q('¿Cómo quieres que te avisen?', 'How should they reach you?')}
          options={[
            { value: "email", label: ${q('Por correo', 'By email')} },
            { value: "sms", label: "SMS" },
            { value: "post", label: ${q('Por carta', 'By post')} },
          ]}
          value={form.reply}
          onChange={set("reply")}
        />
      </Section>
      <Section title=${q('La ayuda', 'The support')}>
        <TextField label=${q('Ingresos del año pasado (€)', 'Income last year (€)')} type="number" value={form.income} onChange={set("income")} required={false} help=${q('Está en tu declaración de la renta, casilla 435.', 'It is on your tax return, box 435.')} />
        <TextField label=${q('¿Por qué la pides?', 'Why are you applying?')} type="textarea" value={form.reason} onChange={set("reason")} error={missing("reason")} />
        <DocumentPicker label=${q('Contrato de alquiler', 'Rental contract')} value={form.photo} onChange={set("photo")} error={missing("photo")} />
        <Text tone="muted" size="sm">${t('Solo se envía a la Junta de Andalucía.', 'Only sent to the Junta de Andalucía.')}</Text>
      </Section>
      <Actions>
        <Button type="ghost" onClick={() => api.ui.close(null)}>${t('Ahora no', 'Not now')}</Button>
        <Button type="primary" onClick={() => (complete ? api.ui.close(form) : setTried(true))}>${t('Continuar', 'Continue')}</Button>
      </Actions>
    </Form>
  );
}

export async function main(api) {
  const form = await api.ui.present("details", () => <Details api={api} />);
  if (!form) return { skipped: true };
  return { name: form.name, province: form.province, contract: form.photo };
}
`,
    },
    {
      id: 'tasa',
      label: t('Revisar y pagar la tasa', 'Review and pay the fee'),
      code: 'Facts · Callout · Link · confirm',
      source: `import { Form, Facts, Callout, Text, Link, Divider, Choice, Checkbox, Actions, Button } from "@spainassist/ui";

function Review({ api }) {
  const [method, setMethod] = api.ui.useDurableState("method", "card");
  const [agreed, setAgreed] = api.ui.useDurableState("agreed", false);
  return (
    <Form title=${q('Tasa del DNI: revisa antes de pagar', 'DNI fee: review before paying')}>
      <Facts
        items={[
          { label: ${q('Tasa', 'Fee')}, value: "790-012 · ${t('Renovación del DNI', 'DNI renewal')}" },
          { label: ${q('Importe', 'Amount')}, value: "12,00 €" },
          { label: ${q('Titular', 'Holder')}, value: "Lucía Martín Ortega" },
        ]}
      />
      <Callout tone="warning" title=${q('Familia numerosa', 'Large family')}>
        ${t('Si tienes el título de familia numerosa, no pagas. Dímelo y lo cambio.', 'With a large-family card you pay nothing. Tell me and I will change it.')}
      </Callout>
      <Divider />
      <Choice
        label=${q('Forma de pago', 'Payment method')}
        options={[
          { value: "card", label: ${q('Tarjeta', 'Card')}, description: ${q('Pago al momento en la pasarela de la AEAT.', 'Paid at once on the tax agency’s gateway.')} },
          { value: "bank", label: ${q('En el banco', 'At the bank')}, description: ${q('Imprimes el impreso y pagas en una oficina.', 'You print the form and pay at a branch.')} },
        ]}
        value={method}
        onChange={setMethod}
      />
      <Text size="sm" tone="muted">
        ${t('Precio publicado en el BOE para 2026.', 'Price published in the BOE for 2026.')}
      </Text>
      <Link href="https://www.boe.es/buscar/act.php?id=BOE-A-2026-0000">${t('Ver la tasa en el BOE', 'See the fee in the BOE')}</Link>
      <Checkbox label=${q('He revisado los datos', 'I have checked the details')} checked={agreed} onChange={setAgreed} />
      <Actions>
        <Button type="danger" onClick={() => api.ui.close({ cancel: true })}>${t('Cancelar el trámite', 'Cancel the procedure')}</Button>
        <Button type="primary" disabled={!agreed} onClick={() => api.ui.close({ method })}>${t('Pagar 12 €', 'Pay €12')}</Button>
      </Actions>
    </Form>
  );
}

export async function main(api) {
  const choice = await api.ui.present("review", () => <Review api={api} />);
  if (choice.cancel) return { paid: false, cancelled: true };
  // Binding: the app asks for approval itself, with what will be paid and to whom.
  const ok = await api.user.confirm({
    kind: "payment",
    title: ${q('Pagar la tasa del DNI', 'Pay the DNI fee')},
    message: ${q('Voy a pagar 12,00 € a la Agencia Tributaria con la tarjeta guardada.', 'I will pay €12.00 to the tax agency with the saved card.')},
    details: [{ label: ${q('Importe', 'Amount')}, value: "12,00 €" }],
  });
  return { paid: ok, method: choice.method };
}
`,
    },
    {
      id: 'requisitos',
      label: t('Comprobar requisitos', 'Check the requirements'),
      code: 'MultiChoice · Progress · async handler',
      source: `import { Form, MultiChoice, Progress, Callout, Text, Actions, Button } from "@spainassist/ui";

function Requirements({ api }) {
  const [have, setHave] = api.ui.useDurableState("have", []);
  const [checking, setChecking] = api.ui.useState(false);
  const [answer, setAnswer] = api.ui.useDurableState("answer", null);

  // A handler may await: the interface re-renders while it works.
  async function check() {
    setChecking(true);
    const report = await api.search({
      mode: "fast",
      prompt: "Documentos para empadronarse en Sevilla con contrato de alquiler: " + have.join(", "),
    });
    setAnswer(report);
    setChecking(false);
  }

  return (
    <Form
      title=${q('¿Qué documentos tienes para el padrón?', 'Which documents do you have for the padrón?')}
      description=${q('Marca los que tengas a mano y compruebo si bastan.', 'Tick the ones you have and I will check whether they are enough.')}
    >
      <MultiChoice
        options={[
          { value: "dni", label: "DNI" },
          { value: "contrato", label: ${q('Contrato de alquiler', 'Rental contract')} },
          { value: "recibo", label: ${q('Recibo de la luz', 'Electricity bill')} },
          { value: "autorizacion", label: ${q('Autorización del casero', 'Landlord’s authorisation')} },
        ]}
        value={have}
        onChange={setHave}
      />
      {checking ? <Progress label=${q('Consultando la web del ayuntamiento…', 'Checking the town hall’s website…')} /> : null}
      {answer ? (
        <Callout tone="success" title=${q('Con eso basta', 'That is enough')}>
          {answer}
        </Callout>
      ) : (
        <Text tone="muted" size="sm">${t('Aún no lo he comprobado.', 'Not checked yet.')}</Text>
      )}
      <Actions>
        <Button loading={checking} disabled={!have.length} onClick={check}>${t('Comprobar', 'Check')}</Button>
        <Button type="primary" disabled={!answer} onClick={() => api.ui.close(have)}>${t('Seguir', 'Continue')}</Button>
      </Actions>
    </Form>
  );
}

export async function main(api) {
  const have = await api.ui.present("documents", () => <Requirements api={api} />);
  return { have };
}
`,
    },
    {
      id: 'componentes',
      label: t('Todos los componentes', 'Every component'),
      code: '@spainassist/ui',
      source: `import {
  Form, Section, Text, Callout, Facts, Link, Divider, Progress,
  TextField, Select, Choice, MultiChoice, Checkbox, Province, DocumentPicker, Map, Appointment,
  Actions, Button,
} from "@spainassist/ui";

const TONES = ["default", "muted", "info", "success", "warning", "error"];

function Gallery({ api }) {
  const [values, setValues] = api.ui.useState({});
  const bind = (name, initial = "") => ({
    value: values[name] ?? initial,
    onChange: (value) => setValues((prev) => ({ ...prev, [name]: value })),
  });
  return (
    <Form title="@spainassist/ui" description=${q('Cada componente que un agente puede usar, con sus variantes.', 'Every component an agent can use, with its variants.')}>
      <Section title="Text">
        {TONES.map((tone) => <Text key={tone} tone={tone}>{"tone=" + tone}</Text>)}
        <Text size="sm" tone="muted">size="sm"</Text>
      </Section>
      <Section title="Callout">
        {TONES.map((tone) => (
          <Callout key={tone} tone={tone} title={"tone=" + tone}>
            ${t('Un aviso dentro de la interfaz.', 'A notice inside the interface.')}
          </Callout>
        ))}
      </Section>
      <Section title="Facts · Link · Divider · Progress">
        <Facts items={[{ label: ${q('Coste', 'Cost')}, value: "12 €" }, { label: ${q('Plazo', 'Deadline')}, value: ${q('30 días', '30 days')} }]} />
        <Link href="https://www.boe.es">boe.es</Link>
        <Divider />
        <Progress label=${q('Leyendo la sede…', 'Reading the website…')} />
      </Section>
      <Section title="TextField">
        {["text", "email", "phone", "number", "date", "textarea"].map((type) => (
          <TextField key={type} label={"type=" + type} type={type} {...bind("text-" + type)} />
        ))}
        <TextField label="help" help=${q('Una ayuda bajo el campo.', 'Help under the field.')} {...bind("help")} />
        <TextField label="error" error=${q('Lo que está mal.', 'What is wrong.')} {...bind("error")} />
        <TextField label="required={false}" required={false} {...bind("optional")} />
        <TextField label="disabled" disabled value=${q('No se puede cambiar', 'Cannot be changed')} />
      </Section>
      <Section title=${q('Opciones', 'Options')}>
        <Select label="Select" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} {...bind("select")} />
        <Choice label="Choice" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} {...bind("choice")} />
        <Choice
          label=${q('Choice con descripciones', 'Choice with descriptions')}
          options={[
            { value: "a", label: "A", description: ${q('Una explicación corta.', 'A short explanation.')} },
            { value: "b", label: "B", description: ${q('Otra explicación.', 'Another explanation.')} },
          ]}
          {...bind("described")}
        />
        <MultiChoice label="MultiChoice" options={["L", "M", "X", "J", "V"].map((d) => ({ value: d, label: d }))} {...bind("multi", [])} />
        <Checkbox label="Checkbox" help=${q('Con una ayuda.', 'With help.')} checked={values.check ?? false} onChange={(v) => setValues((p) => ({ ...p, check: v }))} />
        <Province {...bind("province")} />
        <DocumentPicker label="DocumentPicker" {...bind("document")} />
      </Section>
      <Section title="Map · Appointment">
        <Map
          options={[
            { value: "triana", label: "Comisaría Sevilla-Triana", address: "Calle de ejemplo 20, Sevilla" },
            { value: "sur", label: "Comisaría Sevilla-Sur", address: "Avenida de ejemplo 1, Sevilla" },
          ]}
          {...bind("map")}
        />
        <Appointment slots={["2026-12-02T09:10", "2026-12-02T09:40", "2026-12-04T12:20"]} allowMore {...bind("slot")} />
      </Section>
      <Actions>
        <Button type="ghost">ghost</Button>
        <Button type="danger">danger</Button>
        <Button loading>loading</Button>
        <Button disabled>disabled</Button>
        <Button type="primary" onClick={() => api.ui.close(values)}>primary</Button>
      </Actions>
    </Form>
  );
}

export async function main(api) {
  return api.ui.present("gallery", () => <Gallery api={api} />);
}
`,
    },
    {
      id: 'rechazada',
      label: t('Interfaz rechazada', 'Refused interface'),
      code: 'uiTreeProblem → bad_request',
      source: `import { Form, Text, Link } from "@spainassist/ui";

// Main checks every tree before the user sees it: links must be https, so present() throws
// a CodemodeError (code "bad_request") that says which component is wrong. The run fails here
// unless the workflow catches it.
export async function main(api) {
  return api.ui.present("source", () => (
    <Form title=${q('Dónde lo he leído', 'Where I read it')}>
      <Text>${t('Los requisitos están en la web del ayuntamiento.', 'The requirements are on the town hall’s website.')}</Text>
      <Link href="http://www.sevilla.org/padron">sevilla.org</Link>
    </Form>
  ));
}
`,
    },
  ];
}
