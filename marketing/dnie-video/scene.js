import { ICONS } from '../icons.js';

/**
 * The DNIe video as a pure function of time: `seek(t)` sets every style for second `t`, so
 * render.mjs can capture any frame deterministically. Times live in `T`; tweak them there.
 */

export const DURATION = 22.4;

const T = {
  winIn: 1.4,
  camCard: 2.9,
  dnieIn: 3.1,
  pill: 3.95,
  cursorIn: 4.9,
  press1: 5.75,
  dialogIn: 5.95,
  camDialog: 5.9,
  press2: 7.65,
  enable: 7.85,
  camPair: 8.5,
  phoneIn: 8.7,
  tapScan: 9.75,
  scanner: 9.85,
  detect: 11.25,
  tapLink: 12.2,
  paired: 12.35,
  request: 13.4,
  review: 13.65,
  tapSign: 15.3,
  hold: 15.45,
  cardIn: 15.7,
  read: 16.45,
  signed: 17.8,
  outro: 19.4,
};

// ------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
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
/** 0 → 1 → 0 around a press at `at`. */
const press = (t, at) => 1 - Math.abs(P(t, at - 0.08, 0.22, E.lin) * 2 - 1);

function set(el, styles) {
  for (const [k, v] of Object.entries(styles)) {
    if (k.startsWith('--')) el.style.setProperty(k, v);
    else el.style[k] = v;
  }
}

for (const el of document.querySelectorAll('[data-icon]')) {
  el.innerHTML = `<svg class="icon" viewBox="0 0 24 24">${ICONS[el.dataset.icon]}</svg>`;
}

// ------------------------------------------------------------------------------------------
// Setup: measure the layout once (in window coordinates), then everything is driven by seek().
// ------------------------------------------------------------------------------------------

const M = {};

export async function ready() {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode()));
  const win = $('win').getBoundingClientRect();
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - win.left + r.width / 2, y: r.top - win.top + r.height / 2 };
  };
  set($('dnie-slot'), { height: 'auto' });
  M.addH = $('dnie-add').offsetHeight;
  M.savedH = $('dnie-saved').offsetHeight;
  M.tabsTop = $('pane').offsetTop + $('pane').querySelector('.subtabs-slot').offsetTop;
  M.earlyH = $('dlg-early').offsetHeight;
  M.qrH = $('dlg-qr').offsetHeight;
  M.try = center($('btn-try'));
  set($('dialog'), { top: `${410 - M.earlyH / 2}px`, height: `${M.earlyH}px` });
  M.enable = center($('btn-enable'));
  // Scroll so the saved DNIe, which is taller, ends up whole in the window.
  M.scroll = 150;
}

// ------------------------------------------------------------------------------------------
// Camera: focus point (cx, cy) in window coordinates and zoom z.
// ------------------------------------------------------------------------------------------

const FULL = { cx: 640, cy: 410, z: 1.2 };
const CAMERA = [
  // [start, duration, target]
  [T.camCard, 0.9, { cx: 800, cy: 530, z: 1.75 }],
  [T.camDialog, 0.8, { cx: 640, cy: 410, z: 1.55 }],
  [T.camPair, 0.9, { cx: 860, cy: 410, z: 1.25 }],
  [T.request, 0.9, { cx: 640, cy: 410, z: 1.12 }],
  [T.outro, 0.8, { cx: 640, cy: 410, z: 1.02 }],
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
  const t0 = outro ? T.outro + 0.45 : 0.1;
  const flagP = P(t, t0, 0.55, E.back);
  const w1 = P(t, t0 + 0.15, 0.5, E.out5);
  const w2 = P(t, t0 + 0.27, 0.5, E.out5);
  const tag = P(t, t0 + 0.6, 0.55);
  const exit = outro ? 0 : P(t, 1.35, 0.45, E.in);
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
  tagEl.textContent = outro ? 'Firma con tu DNIe' : 'España, sin complicaciones';
  set(tagEl, { opacity: tag, transform: `translateY(${(1 - tag) * 16}px)` });
}

function windowAndCamera(t) {
  const p = P(t, T.winIn, 1.0, E.out5);
  const out = P(t, T.outro, 0.7, E.in);
  // Behind the phone while it signs.
  const back = P(t, T.request, 0.8, E.inOut) * (1 - out);
  const { cx, cy, z } = camera(t);
  const blur = out * 14 + back * 5;
  set($('world'), {
    transform: `translate(960px, 540px) scale(${z}) translate(${-cx}px, ${-cy}px)`,
    opacity: 1 - out,
    filter: blur > 0 ? `blur(${blur}px)` : 'none',
  });
  set($('veil'), { opacity: back });
  set($('win'), {
    transform: `translateY(${(1 - p) * 520}px) rotateX(${(1 - p) * 22}deg) scale(${0.92 + 0.08 * p})`,
    opacity: clamp01(p * 2.5),
  });
}

function vault(t) {
  // The pane scrolls while the dialog covers it; the sub-tabs stick to the top.
  const scroll = M.scroll * P(t, T.enable + 0.05, 0.6, E.inOut);
  set($('pane'), { transform: `translateY(${-scroll}px)` });
  set($('subtabs'), { top: `${Math.max(M.tabsTop - scroll, 0)}px` });

  // The early-access card appears, then becomes the saved DNIe.
  const appear = P(t, T.dnieIn, 0.7, E.out5);
  const saved = P(t, T.enable, 0.45, E.inOut);
  set($('dnie-slot'), {
    height: `${lerp(0, lerp(M.addH, M.savedH, saved), appear)}px`,
    marginTop: `${16 * appear}px`,
  });
  const pop = P(t, T.dnieIn + 0.05, 0.6, E.out);
  set($('dnie-add'), {
    opacity: clamp01(pop * 1.4) * (1 - saved),
    transform: `translateY(${(1 - pop) * 18}px) scale(${0.97 + 0.03 * pop})`,
  });
  set($('dnie-saved'), { opacity: saved });

  // "Acceso anticipado" pops in, then catches the light twice.
  const pill = P(t, T.pill, 0.55, E.back);
  set($('early'), {
    opacity: clamp01(pill * 2),
    transform: `scale(${0.6 + 0.4 * pill})`,
    boxShadow: `0 0 0 ${lerp(0, 6, inOut(t, T.pill + 0.1, 0.35, T.pill + 1.1, 0.6))}px rgba(131, 89, 227, 0.16)`,
    '--ring': inOut(t, T.pill, 0.3, T.pill + 1.3, 0.5),
  });
  const sweeps = [T.pill + 0.35, T.pill + 1.05];
  const sweep = sweeps.map((a) => clamp01((t - a) / 0.55)).find((x) => x > 0 && x < 1);
  set($('shine'), {
    opacity: sweep === undefined ? 0 : Math.sin(sweep * Math.PI),
    transform: `translateX(${lerp(-50, 160, sweep ?? 0)}px) skewX(-16deg)`,
  });

  set($('btn-try'), { transform: `scale(${1 - 0.06 * press(t, T.press1)})` });

  // The phone pairs: its row says so.
  const ok = P(t, T.paired + 0.25, 0.35);
  set($('no-phone'), { opacity: 1 - ok });
  set($('yes-phone'), { opacity: ok });
  set($('btn-link'), { opacity: 1 - ok });
  set($('btn-unlink'), { opacity: ok });
  set($('phone-icon'), { color: ok > 0.5 ? 'var(--done-fg)' : 'var(--fg-subtle)' });
}

function dialog(t) {
  const open = P(t, T.dialogIn, 0.25, E.out);
  const close = P(t, T.paired + 0.1, 0.25, E.in);
  const shown = open * (1 - close);
  set($('overlay'), { opacity: shown });
  // The overlay's backdrop blur, on the panes themselves (backdrop-filter mirrors at the edges).
  for (const id of ['side', 'main'])
    set($(id), { filter: shown > 0 ? `blur(${2 * shown}px)` : 'none' });
  const m = P(t, T.enable, 0.45, E.inOut);
  const h = lerp(M.earlyH, M.qrH, m);
  set($('dialog'), {
    top: `${410 - h / 2}px`,
    height: `${h}px`,
    opacity: shown,
    transform: `translateY(${(1 - open) * 4 + close * 6}px) scale(${0.98 + 0.02 * open - 0.02 * close})`,
    display: shown > 0 ? 'block' : 'none',
  });
  set($('dlg-early'), { opacity: clamp01(1 - m * 2) });
  set($('dlg-qr'), { opacity: clamp01(m * 2 - 0.6), transform: `translateY(${(1 - m) * 10}px)` });
  set($('btn-enable'), { transform: `scale(${1 - 0.05 * press(t, T.press2)})` });
}

/** The pointer, in window coordinates: to "Probar", then to "Ya tengo la app". */
function pointer(t) {
  const from = { x: 1250, y: 800 };
  const a = P(t, T.cursorIn, T.press1 - 0.15 - T.cursorIn, E.inOut);
  const b = P(t, T.press2 - 0.75, 0.6, E.inOut);
  let x = lerp(from.x, M.try.x, a);
  let y = lerp(from.y, M.try.y, a) - Math.sin(a * Math.PI) * 40;
  x = lerp(x, M.enable.x, b);
  y = lerp(y, M.enable.y, b) + Math.sin(b * Math.PI) * 30;
  const visible = inOut(t, T.cursorIn, 0.15, T.enable, 0.25);
  set($('cursor'), { opacity: visible, transform: `translate(${x - 6}px, ${y - 3}px)` });
  const clicks = [
    [T.press1, M.try],
    [T.press2, M.enable],
  ];
  const [at, where] = clicks.findLast(([c]) => t > c - 0.05) ?? clicks[0];
  const c = P(t, at - 0.05, 0.4);
  set($('click'), {
    opacity: t > at - 0.05 ? (1 - c) * 0.9 : 0,
    transform: `translate(${where.x}px, ${where.y}px) scale(${0.4 + c})`,
  });
}

// ------------------------------------------------------------------------------------------
// The phone
// ------------------------------------------------------------------------------------------

/** Where the phone stands: beside the QR code, then in the middle while it signs. */
const SIDE = { x: 1400, y: 86 };
const MIDDLE = { x: 748, y: 86 };

function phonePlace(t) {
  const inP = P(t, T.phoneIn, 0.9, E.spring);
  const mid = P(t, T.request, 0.9, E.inOut);
  const out = P(t, T.outro, 0.6, E.in);
  return {
    x: lerp(SIDE.x, MIDDLE.x, mid) + (1 - inP) * 760,
    y: lerp(SIDE.y, MIDDLE.y, mid) + out * 60,
    rot: (1 - inP) * 10,
    scale: 1 + 0.08 * mid - 0.06 * out,
    out,
  };
}

/** The screens in order, each over the previous one. */
const SCREENS = [
  ['sc-inicio', T.phoneIn - 0.01, 0],
  ['sc-escanear', T.scanner, 0.22],
  ['sc-vincular', T.detect + 0.05, 0.22],
  ['sc-conectado', T.paired, 0.25],
  ['sc-revisar', T.review, 0.4],
  ['sc-acerca', T.hold, 0.25],
  ['sc-leyendo', T.read, 0.25],
  ['sc-firmado', T.signed, 0.25],
];

function phone(t) {
  const place = phonePlace(t);
  set($('phone'), {
    opacity: t >= T.phoneIn ? 1 - place.out : 0,
    transform: `translate(${place.x}px, ${place.y}px) rotate(${place.rot}deg) scale(${place.scale})`,
    filter: place.out > 0 ? `blur(${place.out * 12}px)` : 'none',
  });

  for (const [id, at, d] of SCREENS) {
    const p = d ? P(t, at, d) : t >= at ? 1 : 0;
    // A sign request slides up; the rest move forward.
    const slide =
      id === 'sc-revisar' ? `translateY(${(1 - p) * 40}px)` : `translateX(${(1 - p) * 24}px)`;
    set($(id), { opacity: p, transform: slide });
  }

  // The camera sees the computer's QR code and focuses on it.
  const feed = P(t, T.scanner, 0.22) * (t < T.detect + 0.3 ? 1 : 0);
  const near = P(t, T.scanner + 0.1, T.detect - T.scanner - 0.1, E.inOut);
  const focus = P(t, T.scanner + 0.35, 0.6);
  set($('feed'), { opacity: feed });
  set($('feed-scene'), {
    transform: `translate(${Math.sin(t * 2.3) * 6}px, ${Math.cos(t * 1.9) * 5}px) scale(${lerp(0.72, 1.04, near)}) rotateX(${lerp(16, 5, near)}deg) rotateY(${lerp(-14, -4, near) + Math.sin(t * 1.4) * 1.5}deg) rotateZ(${Math.sin(t * 1.1) * 1.2}deg)`,
    filter: focus < 1 ? `blur(${(1 - focus) * 7}px)` : 'none',
  });

  // The spinner of "Leyendo el DNIe…" turns; the result's check pops.
  set($('spinner'), { opacity: t >= T.read && t < T.signed + 0.3 ? 1 : 0 });
  set($('spinner-part'), { transform: `rotate(${(t - T.read) * 300}deg)` });
  const ok = P(t, T.signed + 0.08, 0.55, E.back);
  set($('check'), { opacity: t >= T.signed ? 1 : 0 });
  set($('check-part'), { transform: `scale(${ok})` });
  const ring = P(t, T.signed + 0.2, 0.7, E.out);
  set($('check-ring'), {
    opacity: t >= T.signed + 0.2 ? (1 - ring) * 0.8 : 0,
    transform: `scale(${1 + ring * 0.9})`,
  });

  // Taps on the screen, in screen pixels.
  const taps = [
    [T.tapScan, 198, 793],
    [T.tapLink, 198, 720],
    [T.tapSign, 198, 720],
  ];
  const [at, x, y] = taps.findLast(([a]) => t > a - 0.08) ?? taps[0];
  const tp = P(t, at - 0.08, 0.45);
  set($('tap'), {
    left: `${x}px`,
    top: `${y}px`,
    opacity: t > at - 0.08 ? (1 - tp) * 0.9 : 0,
    transform: `scale(${0.3 + tp * 1.3})`,
  });

  // The DNIe slides under the phone, which reads it.
  const c = P(t, T.cardIn, 0.7, E.out5);
  const cOut = P(t, T.signed + 0.5, 0.6, E.inOut);
  const bump = Math.sin(clamp01((t - T.read + 0.1) / 0.3) * Math.PI) * 8;
  const px = place.x + 212;
  const py = place.y + 454;
  set($('dnie'), {
    opacity: (c > 0 ? 1 : 0) * (1 - place.out),
    transform: `translate(${px - 210 - 235 - (1 - c) * 700 - cOut * 260}px, ${py - 132 + 175 + (1 - c) * 320 + cOut * 120 - bump}px) rotate(${-12 + (1 - c) * -24 + cOut * -4}deg)`,
  });
  set($('rings'), { transform: `translate(${px}px, ${py - 60}px)` });
  [...$('rings').children].forEach((r, i) => {
    const local = (t - T.read + 0.25 - i * 0.3) % 0.9;
    const active = t >= T.read - 0.25 + i * 0.3 && t < T.signed + 0.1;
    const q = clamp01(local / 0.9);
    set(r, { opacity: active ? (1 - q) * 0.9 : 0, transform: `scale(${0.9 + q * 1.4})` });
  });
}

export function seek(t) {
  background(t);
  windowAndCamera(t);
  vault(t);
  dialog(t);
  pointer(t);
  phone(t);
  title(t);
}

window.scene = { ready, seek, DURATION };
