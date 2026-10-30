import { ICONS } from '../icons.js';

/**
 * The launch video as a pure function of time: `seek(t)` sets every style for second `t`, so
 * render.mjs can capture any frame deterministically. Times live in `T`; tweak them there.
 */

export const DURATION = 18.6;

const T = {
  winIn: 1.3,
  camChat: 2.15,
  typeFrom: 2.7,
  typeTo: 3.55,
  send: 3.75,
  chip1: 4.15,
  camFull1: 4.3,
  card: 4.45,
  step1: 5.7,
  ai1: 5.15,
  camCard1: 6.05,
  q1: 6.1,
  dragFrom: 6.65,
  drop: 7.45,
  press1: 8.1,
  q1Close: 8.25,
  step2: 8.45,
  camFull2: 8.3,
  ai2: 8.6,
  q2: 9.15,
  camCard2: 9.3,
  phoneIn: 9.7,
  tap: 10.45,
  cardIn: 10.65,
  read: 11.0,
  signed: 11.95,
  phoneOut: 12.4,
  step3: 12.55,
  camFull3: 12.55,
  step4: 13.3,
  chip2: 13.25,
  ai3: 13.4,
  attach: 14.0,
  camChat2: 13.65,
  cert: 14.45,
  outro: 16.0,
};

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const lerp = (a, b, p) => a + (b - a) * p;
const E = {
  lin: (x) => x,
  out: (x) => 1 - (1 - x) ** 3,
  out5: (x) => 1 - (1 - x) ** 5,
  in: (x) => x * x * x,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  back: (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2,
  spring: (x) => (x >= 1 ? 1 : 1 - Math.exp(-6.5 * x) * Math.cos(10 * x)),
};
/** Eased progress of a tween that starts at `a` and lasts `d` seconds. */
const P = (t, a, d, e = E.out) => e(clamp01((t - a) / d));
/** In over [a, a+din], out over [b, b+dout]. */
const inOut = (t, a, din, b, dout) => P(t, a, din) * (1 - P(t, b, dout, E.in));

function set(el, styles) {
  for (const [k, v] of Object.entries(styles)) {
    if (k.startsWith('--')) el.style.setProperty(k, v);
    else el.style[k] = v;
  }
}

for (const el of document.querySelectorAll('[data-icon]')) {
  el.innerHTML = `<svg class="icon" viewBox="0 0 24 24">${ICONS[el.dataset.icon]}</svg>`;
}

/** Wraps every word of a streamed message in a span. */
function splitWords(root) {
  const words = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(part);
          else {
            const span = document.createElement('span');
            span.className = 'w';
            span.textContent = part;
            words.push(span);
            frag.append(span);
          }
        }
        child.replaceWith(frag);
      } else walk(child);
    }
  };
  walk(root);
  return words;
}

// ------------------------------------------------------------------------------------------
// Setup: measure natural heights once, then everything is driven by seek().
// ------------------------------------------------------------------------------------------

const chatItems = {
  user: { el: $('c-user'), at: T.send },
  chip1: { el: $('c-chip1'), at: T.chip1 },
  ai1: { el: $('c-ai1'), at: T.ai1 + 0.25 },
  ai2: { el: $('c-ai2'), at: T.ai2 + 0.2 },
  chip2: { el: $('c-chip2'), at: T.chip2 },
  ai3: { el: $('c-ai3'), at: T.ai3 + 0.2 },
};
const GAP = 18;
const streams = {
  ai1: { words: splitWords($('c-ai1').querySelector('.ai')), from: T.ai1 + 0.25, rate: 26 },
  ai2: { words: splitWords($('c-ai2').querySelector('.ai')), from: T.ai2 + 0.2, rate: 26 },
  ai3: { words: splitWords($('c-ai3').querySelector('.ai')), from: T.ai3 + 0.2, rate: 26 },
};
const cols = ['q1', 'q2'].map((id) => $(id));
const heights = new Map();

export async function ready() {
  await document.fonts.ready;
  for (const { el } of Object.values(chatItems)) heights.set(el, el.scrollHeight);
  // ai3's attachment appears after the text, so its height grows in two steps.
  heights.set('ai3-text', $('c-ai3').querySelector('.ai').offsetHeight);
  for (const el of cols) heights.set(el, el.scrollHeight);
}

// ------------------------------------------------------------------------------------------
// Camera: focus point (cx, cy) in window coordinates and zoom z.
// ------------------------------------------------------------------------------------------

const FULL = { cx: 640, cy: 418, z: 1.2 };
const CAMERA = [
  // [start, duration, target]
  [T.camChat, 0.75, { cx: 330, cy: 520, z: 1.78 }],
  [T.camFull1, 0.75, FULL],
  [T.camCard1, 0.7, { cx: 870, cy: 410, z: 1.62 }],
  [T.camFull2, 0.7, FULL],
  [T.camCard2, 0.7, { cx: 1010, cy: 420, z: 1.42 }],
  [T.camFull3, 0.7, FULL],
  [T.camChat2, 0.75, { cx: 330, cy: 500, z: 1.78 }],
  [T.outro, 0.8, { cx: 640, cy: 418, z: 1.05 }],
];

function camera(t) {
  let s = { cx: 640, cy: 470, z: 1.08 };
  // The window settles from a wider shot during its entrance.
  s = mix(s, FULL, P(t, T.winIn + 0.2, 1.1, E.inOut));
  for (const [a, d, target] of CAMERA) s = mix(s, target, P(t, a, d, E.inOut));
  return s;
}
const mix = (a, b, p) => ({
  cx: lerp(a.cx, b.cx, p),
  cy: lerp(a.cy, b.cy, p),
  z: lerp(a.z, b.z, p),
});

// ------------------------------------------------------------------------------------------
// Pieces
// ------------------------------------------------------------------------------------------

function background(t) {
  set($('blob-r'), {
    transform: `translate(${Math.sin(t * 0.5) * 60}px, ${Math.cos(t * 0.4) * 40}px)`,
  });
  set($('blob-y'), {
    transform: `translate(${Math.cos(t * 0.45) * 70}px, ${Math.sin(t * 0.35) * 50}px)`,
  });
  set($('blob-s'), {
    transform: `translate(${Math.sin(t * 0.3) * 120}px, ${Math.cos(t * 0.5) * 60}px)`,
  });
}

function title(t) {
  const outro = t >= T.outro;
  const t0 = outro ? T.outro + 0.35 : 0.1;
  const flagP = P(t, t0, 0.55, E.back);
  const w1 = P(t, t0 + 0.15, 0.5, E.out5);
  const w2 = P(t, t0 + 0.27, 0.5, E.out5);
  const tag = P(t, t0 + 0.55, 0.5);
  const exit = outro ? 0 : P(t, 1.25, 0.45, E.in);
  set($('title'), {
    opacity: 1 - exit,
    transform: `translateY(${-80 * exit}px) scale(${1 - 0.06 * exit})`,
    filter: exit > 0 ? `blur(${exit * 10}px)` : 'none',
    display: !outro && exit >= 1 ? 'none' : 'flex',
  });
  set($('t-flag'), {
    transform: `scale(${flagP}) rotate(${(1 - flagP) * -25}deg)`,
    opacity: clamp01(flagP * 2),
  });
  set($('t-w1'), { transform: `translateY(${(1 - w1) * 110}%)` });
  set($('t-w2'), { transform: `translateY(${(1 - w2) * 110}%)` });
  const tagEl = $('t-tag');
  tagEl.textContent = outro ? 'Tus trámites, resueltos.' : 'España, sin complicaciones';
  set(tagEl, { opacity: tag, transform: `translateY(${(1 - tag) * 16}px)` });
  const url = outro ? P(t, t0 + 0.85, 0.5, E.back) : 0;
  set($('t-url'), {
    opacity: clamp01(url * 1.5),
    transform: `translateY(${(1 - url) * 20}px) scale(${0.9 + 0.1 * url})`,
  });
}

function windowAndCamera(t) {
  const p = P(t, T.winIn, 1.0, E.out5);
  const out = P(t, T.outro, 0.7, E.in);
  const { cx, cy, z } = camera(t);
  set($('world'), {
    transform: `translate(960px, 540px) scale(${z}) translate(${-cx}px, ${-cy}px)`,
    opacity: 1 - out,
    filter: out > 0 ? `blur(${out * 14}px)` : 'none',
  });
  set($('win'), {
    transform: `translateY(${(1 - p) * 520}px) rotateX(${(1 - p) * 22}deg) scale(${0.92 + 0.08 * p})`,
    opacity: clamp01(p * 2.5),
  });
}

function composer(t) {
  const text = 'Me quiero empadronar';
  const n = Math.round(clamp01((t - T.typeFrom) / (T.typeTo - T.typeFrom)) * text.length);
  const sent = t >= T.send;
  const typed = sent ? '' : text.slice(0, n);
  $('typed').textContent = typed;
  set($('placeholder'), { opacity: typed ? 0 : 1 });
  // The caret blinks while idle and stays solid while typing.
  const focused = t > T.camChat + 0.4 && t < T.camFull1 + 1.5;
  const typing = t >= T.typeFrom && t <= T.send;
  set($('caret'), { opacity: focused && (typing || Math.floor(t * 2) % 2 === 0) ? 1 : 0 });
  const active = typed.length > 0;
  const press = sent ? 1 - Math.abs(P(t, T.send - 0.08, 0.2, E.lin) * 2 - 1) : 0;
  set($('send'), {
    background: active ? 'var(--fg)' : 'var(--accent-soft)',
    color: active ? '#fff' : 'var(--fg-faint)',
    transform: `scale(${1 - 0.14 * press})`,
  });
}

function chat(t) {
  const heroOut = P(t, T.send, 0.3);
  set($('hero'), { opacity: 1 - heroOut, transform: `translateY(${-30 * heroOut}px)` });

  let prev = null;
  for (const [key, { el, at }] of Object.entries(chatItems)) {
    const h = heights.get(el);
    const grow = P(t, at, 0.35, E.out5);
    let full = h;
    if (key === 'ai3') {
      // Text first, then the attachment slides in under it.
      const textH = heights.get('ai3-text');
      full = lerp(textH, h, P(t, T.attach, 0.4, E.out5));
    }
    set(el, {
      height: `${full * grow}px`,
      marginTop: prev && grow > 0 ? `${GAP * grow}px` : '0px',
      opacity: grow > 0 ? 1 : 0,
    });
    const pop = P(t, at, 0.45, key === 'user' ? E.back : E.out);
    set(el.firstElementChild, {
      transform: `translateY(${(1 - pop) * 14}px) scale(${0.94 + 0.06 * pop})`,
      opacity: clamp01(pop * 1.6),
    });
    if (grow > 0) prev = el;
  }
  for (const { words, from, rate } of Object.values(streams)) {
    words.forEach((w, i) => {
      const a = from + i / rate;
      set(w, { opacity: P(t, a, 0.18, E.lin) });
    });
  }
  const att = P(t, T.attach, 0.45, E.out5);
  set($('attach'), { opacity: clamp01(att * 1.5), transform: `translateY(${(1 - att) * 16}px)` });
}

function stepState(t, id, current, done) {
  const el = $(id);
  const isCur = t >= current && t < done;
  const ok = P(t, done, 0.4, E.back);
  const [o, cur, okEl, burst] = el.querySelectorAll('.st > i');
  set(o, { opacity: t < current ? 1 : 0 });
  set(cur, {
    opacity: isCur ? 1 : 0,
    transform: `scale(${isCur ? 0.8 + 0.2 * P(t, current, 0.3, E.back) : 1})`,
  });
  set(okEl, { opacity: ok > 0 ? 1 : 0, transform: `scale(${ok})` });
  const b = P(t, done, 0.6, E.out);
  set(burst, { opacity: t >= done ? (1 - b) * 0.9 : 0, transform: `scale(${1 + b * 1.4})` });
  set(el.querySelector('.lbl'), {
    color: t >= done || isCur ? 'var(--fg)' : 'var(--fg-subtle)',
    fontWeight: isCur ? 600 : t >= done ? 500 : 400,
  });
  set(el, { '--line-cur': t >= done ? 'rgba(23, 163, 95, 0.4)' : 'rgba(212, 206, 200, 0.7)' });
}

function card(t) {
  const emptyOut = P(t, T.card - 0.15, 0.25);
  set($('empty'), { opacity: 1 - emptyOut, transform: `scale(${1 - 0.05 * emptyOut})` });
  const p = P(t, T.card, 0.9, E.spring);
  set($('card'), {
    opacity: clamp01(P(t, T.card, 0.25, E.lin)),
    transform: `translateY(${(1 - p) * 60}px) scale(${0.9 + 0.1 * p})`,
  });
  set($('badge'), { transform: `scale(${P(t, T.card + 0.2, 0.4, E.back)})` });

  stepState(t, 's1', T.card, T.step1);
  stepState(t, 's2', T.step1, T.step2);
  stepState(t, 's3', T.step2, T.step3);
  stepState(t, 's4', T.step3, T.step4);

  // While the card asks, it has the app's amber border and ring.
  const glow = inOut(t, T.q1, 0.3, T.q1Close, 0.3) + inOut(t, T.q2, 0.3, T.phoneOut, 0.3);
  set($('card'), { '--glow': glow });
  const pill = P(t, T.step4 + 0.05, 0.45, E.back);
  set($('pill-done'), {
    opacity: clamp01(pill * 2),
    transform: `scale(${pill})`,
    display: pill > 0 ? 'inline-flex' : 'none',
  });

  // Collapsible sections.
  const open = (el, p) =>
    set(el, { height: `${heights.get(el) * p}px`, opacity: clamp01(p * 1.4) });
  open($('q1'), inOut(t, T.q1, 0.4, T.q1Close, 0.35));
  open($('q2'), inOut(t, T.q2, 0.4, T.phoneOut, 0.35));

  // The status strip: the agent's current activity while it works, else only "Detalles".
  const runs = [
    [T.card + 0.3, T.step1, 'Leyendo sede.sevilla.org'],
    [T.step3, T.step4, 'Abriendo sede.sevilla.org'],
  ];
  const run = runs.find(([a, b]) => t >= a && t < b);
  set($('working'), { visibility: run ? 'visible' : 'hidden' });
  if (run) {
    $('strip-text').textContent = run[2];
    // A procedure's agent takes a while; the clock runs faster than the video.
    $('elapsed').textContent = `${Math.floor((t - run[0]) * 6) + 3}s`;
  }
  set($('working').parentElement, { background: run ? 'rgba(252, 251, 249, 0.6)' : 'transparent' });
  set($('spin'), { transform: `rotate(${t * 420}deg)` });

  // Upload question: hover, drop, chosen file.
  const hover = inOut(t, T.drop - 0.3, 0.15, T.drop, 0.2);
  set($('drop'), { '--hover': hover });
  const dropped = P(t, T.drop, 0.35, E.back);
  set($('drop-file'), {
    opacity: clamp01(dropped * 2),
    transform: `scale(${0.85 + 0.15 * dropped})`,
  });
  set($('drop-empty'), { opacity: 1 - clamp01(dropped * 3) });
  const press = 1 - Math.abs(P(t, T.press1 - 0.08, 0.22, E.lin) * 2 - 1);
  set($('btn-go'), { transform: `scale(${1 - 0.07 * press})` });

  // DNIe question: stages follow the phone.
  const stage =
    t < T.tap + 0.1
      ? ['scan-eye', 'Revisa la firma en el móvil', 'Comprueba qué firmas y para quién.', T.q2]
      : t < T.read
        ? [
            'nfc',
            'Acerca el DNIe a la parte de atrás del móvil',
            'Pon el DNIe sobre una mesa y apoya el móvil encima.',
            T.tap + 0.1,
          ]
        : ['nfc', 'Leyendo el DNIe…', 'No muevas el DNIe ni el móvil hasta que termine.', T.read];
  const icon = $('stage-icon');
  if (icon.dataset.icon !== stage[0]) {
    icon.dataset.icon = stage[0];
    icon.innerHTML = `<svg class="icon" viewBox="0 0 24 24">${ICONS[stage[0]]}</svg>`;
  }
  $('stage-title').textContent = stage[1];
  $('stage-hint').textContent = stage[2];
  const sw = P(t, stage[3], 0.25);
  set($('stage-title').parentElement, { opacity: sw, transform: `translateX(${(1 - sw) * 8}px)` });
}

/** The pointer and the dragged PDF, in window coordinates. */
function pointer(t) {
  const dragStart = { x: 1420, y: 700 };
  const dropAt = { x: 720, y: 470 };
  const goAt = { x: 1180, y: 531 };
  const d = P(t, T.dragFrom, T.drop - T.dragFrom, E.inOut);
  const m = P(t, T.drop + 0.2, 0.4, E.inOut);
  let x = lerp(dragStart.x, dropAt.x, d);
  let y = lerp(dragStart.y, dropAt.y, d) - Math.sin(d * Math.PI) * 60;
  x = lerp(x, goAt.x, m);
  y = lerp(y, goAt.y, m);
  const visible = inOut(t, T.dragFrom, 0.1, T.q1Close + 0.1, 0.25);
  set($('cursor'), { opacity: visible, transform: `translate(${x - 6}px, ${y - 3}px)` });

  const carrying = t < T.drop;
  const fileP = carrying ? clamp01((t - T.dragFrom) / 0.15) : 1 - P(t, T.drop, 0.18);
  set($('dragfile'), {
    opacity: fileP,
    transform: `translate(${x - 30}px, ${y - 26}px) rotate(${carrying ? -4 + d * 4 : 0}deg) scale(${carrying ? 1.05 : 1 - 0.3 * (1 - fileP)})`,
  });
  const click = P(t, T.press1 - 0.05, 0.4);
  set($('click'), {
    opacity: t > T.press1 - 0.05 ? (1 - click) * 0.9 : 0,
    transform: `translate(${goAt.x}px, ${goAt.y}px) scale(${0.4 + click})`,
  });
}

function phone(t) {
  const inP = P(t, T.phoneIn, 0.8, E.spring);
  const outP = P(t, T.phoneOut, 0.45, E.in);
  set($('phone'), {
    opacity: t >= T.phoneIn ? 1 : 0,
    transform: `translateX(${(1 - inP) * 760 + outP * 900}px) rotate(${(1 - inP) * 10 + outP * 8}deg)`,
  });
  const v1 = 1 - P(t, T.tap + 0.12, 0.2);
  const v2 = P(t, T.tap + 0.15, 0.25) * (1 - P(t, T.signed, 0.15));
  const v3 = P(t, T.signed, 0.3);
  set($('pv1'), { opacity: v1, transform: `translateX(${(1 - v1) * -30}px)` });
  set($('pv2'), { opacity: v2, transform: `translateX(${(1 - P(t, T.tap + 0.15, 0.3)) * 30}px)` });
  set($('pv3'), { opacity: v3 });
  const ok = P(t, T.signed, 0.5, E.back);
  set($('pv3').querySelector('.p-ok'), { transform: `scale(${ok})` });
  const ring = P(t, T.read, T.signed - T.read - 0.05, E.inOut);
  set($('p-ring-bar'), { strokeDashoffset: `${326.7 * (1 - ring)}` });
  $('pv2-title').textContent =
    t < T.read ? 'Acerca el DNIe a la parte de atrás del móvil' : 'Leyendo el DNIe…';
  $('pv2-hint').textContent =
    t < T.read
      ? 'Pon el DNIe sobre una mesa y apoya el móvil encima.'
      : 'No muevas el DNIe ni el móvil.';
  const pbtn = 1 - Math.abs(P(t, T.tap - 0.08, 0.2, E.lin) * 2 - 1);
  set($('p-btn'), { transform: `scale(${1 - 0.05 * pbtn})` });
  const tap = P(t, T.tap - 0.05, 0.45);
  set($('tap'), {
    opacity: t > T.tap - 0.05 ? (1 - tap) * 0.9 : 0,
    transform: `scale(${0.3 + tap * 1.4})`,
  });

  // The DNIe slides in and taps the back of the phone.
  const c = P(t, T.cardIn, 0.55, E.out5);
  const cOut = P(t, T.phoneOut - 0.1, 0.4, E.in);
  const bump = Math.sin(clamp01((t - T.read) / 0.25) * Math.PI) * 10;
  set($('dnie'), {
    opacity: c > 0 && cOut < 1 ? 1 : 0,
    transform: `translate(${(1 - c) * 520 + cOut * 700}px, ${(1 - c) * 300 - bump}px) rotate(${-12 + (1 - c) * 30}deg)`,
  });
  [...$('rings').children].forEach((r, i) => {
    const local = (t - T.read + 0.25 - i * 0.3) % 0.9;
    const active = t >= T.read - 0.25 + i * 0.3 && t < T.signed + 0.2;
    const q = clamp01(local / 0.9);
    set(r, { opacity: active ? (1 - q) * 0.8 : 0, transform: `scale(${0.4 + q * 1.4})` });
  });
}

/** The certificate pops out of the chat attachment. */
function certificate(t) {
  const a = $('attach').getBoundingClientRect();
  const p = P(t, T.cert, 0.75, E.spring);
  const out = P(t, T.outro, 0.5, E.in);
  const startX = a.left + a.width / 2 - 960;
  const startY = a.top + a.height / 2 - 540;
  set($('cert'), {
    opacity: t >= T.cert ? clamp01((t - T.cert) / 0.12) * (1 - out) : 0,
    transform: `translate(${lerp(startX, 0, p)}px, ${lerp(startY, 0, p) - out * 80}px) scale(${lerp(0.12, 1, p)}) rotate(${lerp(-12, -2.5, p) + Math.sin(t * 1.6) * 0.6}deg)`,
  });
  set($('veil'), { opacity: inOut(t, T.cert, 0.4, T.outro, 0.4) });
  confetti(t);
}

// Deterministic confetti: closed-form ballistic paths from the certificate.
const rand = (() => {
  let s = 7;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
})();
const COLORS = ['#c60b1e', '#ffc400', '#ffc400', '#17a35f', '#28211d', '#f4a26b'];
const PIECES = Array.from({ length: 90 }, () => {
  const angle = -Math.PI / 2 + (rand() - 0.5) * 2.4;
  const speed = 900 + rand() * 1100;
  return {
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    w: 9 + rand() * 9,
    h: 5 + rand() * 6,
    spin: (rand() - 0.5) * 18,
    wobble: rand() * 6,
    color: COLORS[Math.floor(rand() * COLORS.length)],
    delay: rand() * 0.12,
  };
});
const ctx = $('confetti').getContext('2d');

function confetti(t) {
  ctx.clearRect(0, 0, 1920, 1080);
  const t0 = T.cert + 0.25;
  if (t < t0 || t > t0 + 2.4) return;
  for (const c of PIECES) {
    const s = t - t0 - c.delay;
    if (s < 0) continue;
    const drag = (1 - Math.exp(-2.2 * s)) / 2.2;
    const x = 960 + c.vx * drag + Math.sin(s * c.wobble) * 14;
    const y = 470 + c.vy * drag + 700 * s * s * 0.5;
    const alpha = clamp01(1 - (s - 1.6) / 0.6);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(s * c.spin);
    ctx.scale(1, Math.cos(s * c.spin * 0.7));
    ctx.fillStyle = c.color;
    ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }
}

export function seek(t) {
  background(t);
  windowAndCamera(t);
  composer(t);
  chat(t);
  card(t);
  pointer(t);
  phone(t);
  certificate(t);
  title(t);
}

window.scene = { ready, seek, DURATION };
