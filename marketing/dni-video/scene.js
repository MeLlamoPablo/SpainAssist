import { ICONS } from '../icons.js';

/**
 * The DNI video as a pure function of time: `seek(t)` sets every style for second `t`, so
 * render.mjs can capture any frame deterministically. Times live in `T`; tweak them there.
 */

export const DURATION = 20.2;

const T = {
  winIn: -0.2,
  camCard: 1.2,
  dnieIn: 1.4,
  pill: 2.2,
  cursorIn: 3.4,
  press1: 4.25,
  dialogIn: 4.4,
  camDialog: 4.35,
  phoneIn: 5.3,
  tapScan: 6.3,
  scanner: 6.4,
  detect: 7.85,
  pair: 8.2,
  tapLink: 9.15,
  paired: 9.3,
  request: 10.3,
  review: 10.55,
  tapSign: 12.2,
  hold: 12.35,
  cardIn: 12.6,
  read: 13.35,
  signed: 14.7,
  outro: 16.3,
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
  M.pillW = $('early').offsetWidth;
  M.outroPillW = $('t-pill').offsetWidth;
  M.try = center($('btn-try'));
  M.qrH = $('dlg-qr').offsetHeight;
  set($('dialog'), { top: `${410 - M.qrH / 2}px`, height: `${M.qrH}px` });
  const qr = $('dialog').querySelector('.qr');
  M.qr = { ...center(qr), size: qr.offsetWidth };
  // Scroll so the saved DNI, which is taller, ends up whole in the window.
  M.scroll = 150;

  // What the phone's camera films: the window as it stands while the phone scans, copied once.
  // The copy keeps the ids (and so the styles); getElementById still finds the originals first.
  seek(T.detect);
  const copy = $('win').cloneNode(true);
  copy.style.transform = 'none';
  $('feed').append(copy);
}

// ------------------------------------------------------------------------------------------
// Camera: focus point (cx, cy) in window coordinates and zoom z.
// ------------------------------------------------------------------------------------------

const FULL = { cx: 640, cy: 410, z: 1.2 };
const CAMERA = [
  // [start, duration, target]
  [T.camCard, 0.9, { cx: 800, cy: 530, z: 1.75 }],
  [T.camDialog, 0.8, { cx: 640, cy: 410, z: 1.4 }],
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
/** Where a point of the window lands on the stage. */
const onStage = (cam, x, y) => ({
  x: 960 + cam.z * (x - cam.cx),
  y: 540 + cam.z * (y - cam.cy),
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

/** The closing title. */
function title(t) {
  const t0 = T.outro + 0.45;
  const flagP = P(t, t0, 0.55, E.back);
  const w1 = P(t, t0 + 0.15, 0.5, E.out5);
  const w2 = P(t, t0 + 0.27, 0.5, E.out5);
  const tag = P(t, t0 + 0.6, 0.55);
  set($('title'), { display: t >= T.outro ? 'flex' : 'none' });
  set($('t-flag'), {
    transform: `scale(${flagP}) rotate(${(1 - flagP) * -25}deg)`,
    opacity: clamp01(flagP * 2),
  });
  set($('t-w1'), { transform: `translateY(${(1 - w1) * 110}%)` });
  set($('t-w2'), { transform: `translateY(${(1 - w2) * 110}%)` });
  set($('t-tag'), { opacity: tag, transform: `translateY(${(1 - tag) * 16}px)` });

  // Then "Acceso anticipado" joins it: the tagline slides left, the pill springs in and glows.
  const a = t0 + 1.45;
  const room = P(t, a, 0.7, E.inOut);
  const pop = P(t, a + 0.2, 0.8, E.spring);
  const glow = P(t, a + 0.3, 0.5);
  set($('t-slot'), { width: `${room * (M.outroPillW + 22)}px` });
  set($('t-pill'), {
    opacity: clamp01(P(t, a + 0.2, 0.2, E.lin)),
    transform: `scale(${0.4 + 0.6 * pop}) rotate(${(1 - pop) * -6}deg)`,
    backgroundPosition: `${lerp(0, 100, P(t, a, 2.4, E.inOut))}% 0`,
    boxShadow: `inset 0 0 0 1.5px var(--progress-line), 0 0 ${36 * glow}px rgba(131, 89, 227, ${0.35 * glow})`,
  });
  const sweep = clamp01((t - a - 0.75) / 0.7);
  set($('t-shine'), {
    opacity: sweep > 0 && sweep < 1 ? Math.sin(sweep * Math.PI) : 0,
    transform: `translateX(${lerp(-100, M.outroPillW + 20, sweep)}px) skewX(-16deg)`,
  });
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

const DIMMED = ['#side', '.tabs', '.promises', '.lead', '#subtabs', '.creds > .cred'].flatMap(
  (q) => [...document.querySelectorAll(q)],
);

function vault(t) {
  // "Probar" saves the DNI under the pairing dialog; the pane scrolls and the sub-tabs stick.
  const scroll = M.scroll * P(t, T.press1 + 0.2, 0.6, E.inOut);
  set($('pane'), { transform: `translateY(${-scroll}px)` });
  set($('subtabs'), { top: `${Math.max(M.tabsTop - scroll, 0)}px` });

  // The early-access card appears, then becomes the saved DNI.
  const appear = P(t, T.dnieIn, 0.7, E.out5);
  const saved = P(t, T.press1 + 0.15, 0.45, E.inOut);
  set($('dnie-slot'), {
    height: `${lerp(0, lerp(M.addH, M.savedH, saved), appear)}px`,
    marginTop: `${16 * appear}px`,
    // Open while it stands still, so the pill's sparks fly out of the card.
    overflow: appear < 1 || saved > 0 ? 'hidden' : 'visible',
  });
  const pop = P(t, T.dnieIn + 0.05, 0.6, E.out);
  set($('dnie-add'), {
    opacity: clamp01(pop * 1.4) * (1 - saved),
    transform: `translateY(${(1 - pop) * 18}px) scale(${0.97 + 0.03 * pop})`,
  });
  set($('dnie-saved'), { opacity: saved });

  // The rest steps back while the new option shows itself, until "Probar" is clicked.
  const dim = 1 - 0.55 * inOut(t, T.dnieIn, 0.5, T.press1 - 0.05, 0.35);
  for (const el of DIMMED) set(el, { opacity: dim });

  pill(t);
  set($('btn-try'), { transform: `scale(${1 - 0.06 * press(t, T.press1)})` });

  // The phone pairs: its row says so.
  const ok = P(t, T.paired + 0.25, 0.35);
  set($('no-phone'), { opacity: 1 - ok });
  set($('yes-phone'), { opacity: ok });
  set($('btn-link'), { opacity: 1 - ok });
  set($('btn-unlink'), { opacity: ok });
  set($('phone-icon'), { color: ok > 0.5 ? 'var(--done-fg)' : 'var(--fg-subtle)' });
}

/** "Acceso anticipado" springs in, glows, launches its rocket, throws sparks, catches the light. */
function pill(t) {
  const a = T.pill;
  const pop = P(t, a, 0.8, E.spring);
  const glow = inOut(t, a + 0.1, 0.35, a + 1.5, 0.6);
  set($('early'), {
    opacity: clamp01(P(t, a, 0.2, E.lin)),
    transform: `scale(${0.35 + 0.65 * pop}) rotate(${(1 - pop) * -8}deg)`,
    boxShadow: `0 0 0 ${6 * glow}px rgba(131, 89, 227, 0.16), 0 0 ${22 * glow}px rgba(131, 89, 227, ${0.45 * glow})`,
    '--ring': inOut(t, a, 0.3, a + 1.6, 0.5),
    '--hot': inOut(t, a, 0.3, a + 1.6, 0.6),
    '--bgx': `${lerp(0, 100, P(t, a, 2.2, E.inOut))}%`,
  });

  // The rocket lifts off to the top right and comes back in from the bottom left.
  const off = P(t, a + 0.3, 0.3, E.in);
  const back = P(t, a + 0.62, 0.45, E.out5);
  const r = t < a + 0.62 ? off : back - 1;
  set($('rocket'), {
    transform: `translate(${r * 12}px, ${-r * 12}px)`,
    opacity: t < a + 0.62 ? 1 - off : back,
  });

  const sparks = [...$('sparks').children];
  sparks.forEach((el, i) => {
    const angle = (i / sparks.length) * Math.PI * 2 + 0.4;
    const s = P(t, a + 0.18 + i * 0.03, 0.75, E.out);
    const d = 10 + 26 * s;
    set(el, {
      opacity: s > 0 && s < 1 ? Math.sin(s * Math.PI) : 0,
      transform: `translate(${M.pillW / 2 + Math.cos(angle) * (M.pillW / 2 + d)}px, ${Math.sin(angle) * (8 + d)}px) rotate(${s * 90}deg) scale(${0.6 + 0.6 * Math.sin(s * Math.PI)})`,
    });
  });

  const sweeps = [a + 0.45, a + 1.15];
  const sweep = sweeps.map((x) => clamp01((t - x) / 0.55)).find((x) => x > 0 && x < 1);
  set($('shine'), {
    opacity: sweep === undefined ? 0 : Math.sin(sweep * Math.PI),
    transform: `translateX(${lerp(-50, 160, sweep ?? 0)}px) skewX(-16deg)`,
  });
}

/** The pairing dialog, straight from "Probar". */
function dialog(t) {
  const open = P(t, T.dialogIn, 0.3, E.out);
  const close = P(t, T.paired + 0.1, 0.25, E.in);
  const shown = open * (1 - close);
  set($('overlay'), { opacity: shown });
  // The overlay's backdrop blur, on the panes themselves (backdrop-filter mirrors at the edges).
  for (const id of ['side', 'main'])
    set($(id), { filter: shown > 0 ? `blur(${2 * shown}px)` : 'none' });
  set($('dialog'), {
    opacity: shown,
    transform: `translateY(${(1 - open) * 8 + close * 6}px) scale(${0.96 + 0.04 * open - 0.02 * close})`,
    display: shown > 0 ? 'block' : 'none',
  });
}

/** The pointer, in window coordinates: to "Probar". */
function pointer(t) {
  const from = { x: 1250, y: 800 };
  const a = P(t, T.cursorIn, T.press1 - 0.15 - T.cursorIn, E.inOut);
  const x = lerp(from.x, M.try.x, a);
  const y = lerp(from.y, M.try.y, a) - Math.sin(a * Math.PI) * 40;
  const visible = inOut(t, T.cursorIn, 0.15, T.dialogIn, 0.25);
  set($('cursor'), { opacity: visible, transform: `translate(${x - 6}px, ${y - 3}px)` });
  const c = P(t, T.press1 - 0.05, 0.4);
  set($('click'), {
    opacity: t > T.press1 - 0.05 ? (1 - c) * 0.9 : 0,
    transform: `translate(${M.try.x}px, ${M.try.y}px) scale(${0.4 + c})`,
  });
}

// ------------------------------------------------------------------------------------------
// The phone
// ------------------------------------------------------------------------------------------

/** Phone geometry, in px of the phone (424×908): its centre and the viewfinder's centre. */
const PHONE_C = { x: 212, y: 454 };
const VF_C = { x: 212, y: 364.5 };
/** The viewfinder in dp (its own coordinates) and dp → px of the screen. */
const VF = { w: 363.43, h: 632.29 };
const DP = 0.9625;

/** In the middle while it signs. */
const MIDDLE = { x: 748, y: 86 };

function phonePlace(t, cam) {
  // In front of the QR code: the viewfinder's centre on it.
  const qr = onStage(cam, M.qr.x, M.qr.y);
  const over = { x: qr.x - VF_C.x, y: qr.y - VF_C.y };
  const inP = P(t, T.phoneIn, 0.95, E.spring);
  // Held low to tap "Escanear QR", then raised to the code.
  const lift = P(t, T.scanner + 0.1, 1.25, E.inOut);
  const mid = P(t, T.request, 0.9, E.inOut);
  const out = P(t, T.outro, 0.6, E.in);
  // A hand holds it: it sways a little until it moves to the middle to sign.
  const hand = 1 - mid;
  let x = over.x + (1 - inP) * 160 + Math.sin(t * 1.7) * 3 * hand;
  let y = over.y + 300 * (1 - lift) + (1 - inP) * 820 + Math.cos(t * 1.3) * 3 * hand;
  x = lerp(x, MIDDLE.x, mid);
  y = lerp(y, MIDDLE.y, mid) + out * 60;
  return {
    x,
    y,
    rot: (1 - inP) * 9 + Math.sin(t * 1.1) * 0.6 * hand,
    tilt: 14 * (1 - lift) * hand,
    scale: 1 + 0.08 * mid - 0.06 * out,
    out,
  };
}

/** The screens in order: each one's elements spring in one after another. */
const SCREENS = [
  ['s-inicio', T.phoneIn + 0.15],
  ['s-scan', T.scanner],
  ['s-pair', T.pair],
  ['s-home', T.paired],
  ['s-review', T.review],
  ['s-card', T.hold],
  ['s-done', T.signed],
];

function screens(t) {
  SCREENS.forEach(([id, at], i) => {
    const next = SCREENS[i + 1]?.[1] ?? Number.POSITIVE_INFINITY;
    const leave = P(t, next, 0.16, E.lin);
    set($(id), {
      opacity: t >= at - 0.02 ? 1 - leave : 0,
      transform: `translateY(${-leave * 14}px)`,
    });
    [...$(id).querySelectorAll('.st')].forEach((el, k) => {
      const p = P(t, at + 0.04 + k * 0.07, 0.55, E.back);
      set(el, {
        opacity: clamp01(P(t, at + 0.04 + k * 0.07, 0.25, E.lin)),
        transform: `translateY(${(1 - p) * 22}px)`,
      });
    });
  });

  // The wordmark stays while the start, pairing and home screens follow each other.
  const first = 1 - P(t, T.scanner, 0.16, E.lin);
  const again = P(t, T.pair + 0.05, 0.6, E.back) * (1 - P(t, T.review, 0.16, E.lin));
  const wm = t < T.pair ? (t >= T.phoneIn ? first : 0) : again;
  const wmIn = t < T.pair ? 1 : again;
  set($('wordmark'), {
    opacity: clamp01(wm),
    transform: `scale(${0.85 + 0.15 * wmIn})`,
  });
  set($('dots'), { opacity: clamp01(wm) });

  for (const [id, at] of [
    ['b-scan', T.tapScan],
    ['b-link', T.tapLink],
    ['b-sign', T.tapSign],
  ]) {
    const p = press(t, at);
    set($(id), { transform: `scale(${1 - 0.04 * p})`, filter: `brightness(${1 + 0.5 * p})` });
  }

  const ok = P(t, T.paired + 0.2, 0.5, E.back);
  set($('banner-check'), { transform: `scale(${ok}) rotate(${(1 - ok) * -90}deg)` });
}

/** The camera's view: the copy of the window, where the viewfinder would see it. */
function scanner(t, place, cam) {
  const k = DP * place.scale;
  const vf = {
    x: place.x + PHONE_C.x + (VF_C.x - PHONE_C.x) * place.scale,
    y: place.y + PHONE_C.y + (VF_C.y - PHONE_C.y) * place.scale,
  };
  // The lens frames a bit wider than the eye, and closer as the phone nears the screen.
  const near = P(t, T.scanner + 0.1, 1.25, E.inOut);
  const mag = lerp(0.55, 0.8, near);
  const f = (cam.z * mag) / k;
  const ox = VF.w / 2 + ((960 - cam.z * cam.cx - vf.x) * mag) / k;
  const oy = VF.h / 2 + ((540 - cam.z * cam.cy - vf.y) * mag) / k;
  const focus = P(t, T.scanner + 0.3, 0.7);
  const live = P(t, T.scanner + 0.12, 0.25, E.lin);
  set($('feed'), {
    opacity: live,
    transform: `translate(${ox}px, ${oy}px) scale(${f})`,
    filter: focus < 1 ? `blur(${(1 - focus) * 2.5}px)` : 'none',
  });

  // The corners search, then snap onto the code.
  const lock = P(t, T.detect, 0.32, E.back);
  const breathe = 1 + Math.sin((t - T.scanner) * 5) * 0.03 * (1 - lock);
  const free = { x: VF.w / 2, y: VF.h / 2, s: 300 * breathe };
  const code = { x: ox + M.qr.x * f, y: oy + M.qr.y * f, s: M.qr.size * f + 26 };
  const b = {
    x: lerp(free.x, code.x, lock),
    y: lerp(free.y, code.y, lock),
    s: lerp(free.s, code.s, lock),
  };
  set($('brackets'), {
    opacity: P(t, T.scanner + 0.3, 0.3, E.lin),
    left: `${b.x - b.s / 2}px`,
    top: `${b.y - b.s / 2}px`,
    width: `${b.s}px`,
    height: `${b.s}px`,
    '--lock': lock > 0.5 ? 'var(--done-dot)' : '#fff',
  });
  set($('flash'), { opacity: inOut(t, T.detect + 0.12, 0.08, T.detect + 0.2, 0.25) * 0.55 });
}

/** "Acerca el DNI" → "Leyendo el DNI…" → the check. */
function signing(t) {
  // The little phone hovers over the card until the real one is on the DNI.
  const settle = P(t, T.read - 0.4, 0.4, E.out);
  const hover = (0.5 - 0.5 * Math.cos((t - T.hold) * 5.2)) * 12;
  set($('i-phone'), { transform: `translateY(${-hover * (1 - settle)}px)` });
  const r = P(t, T.read, 0.35, E.out);
  set($('w-hold'), { opacity: 1 - r, transform: `translateY(${-r * 12}px)` });
  set($('w-read'), { opacity: r, transform: `translateY(${(1 - r) * 16}px)` });
  set($('b-cancel'), { visibility: r > 0.5 ? 'hidden' : 'visible' });
  set($('i-spin'), {
    opacity: P(t, T.read, 0.2, E.lin),
    transform: `rotate(${(t - T.read) * 400}deg)`,
  });
  $('i-spin').firstElementChild.style.strokeDasharray =
    `${20 + 34 * (0.5 - 0.5 * Math.cos((t - T.read) * 4))} 100`;

  const badge = P(t, T.signed + 0.05, 0.6, E.back);
  set($('r-badge'), { transform: `scale(${badge})` });
  set($('r-check'), { strokeDashoffset: 22 * (1 - P(t, T.signed + 0.28, 0.35, E.out)) });
  const dots = [...$('burst').children];
  dots.forEach((el, i) => {
    const angle = (i / dots.length) * Math.PI * 2 - Math.PI / 2;
    const b = P(t, T.signed + 0.3 + (i % 2) * 0.04, 0.65, E.out);
    const d = 50 + 34 * b + (i % 2) * 8;
    set(el, {
      opacity: b > 0 && b < 1 ? 1 - b ** 2 : 0,
      transform: `translate(${Math.cos(angle) * d}px, ${Math.sin(angle) * d}px) scale(${1 - 0.6 * b})`,
    });
  });
}

function phone(t) {
  const cam = camera(t);
  const place = phonePlace(t, cam);
  set($('phone'), {
    opacity: t >= T.phoneIn ? 1 - place.out : 0,
    transform: `translate(${place.x}px, ${place.y}px) perspective(1800px) rotateX(${place.tilt}deg) rotate(${place.rot}deg) scale(${place.scale})`,
    filter: place.out > 0 ? `blur(${place.out * 12}px)` : 'none',
  });

  screens(t);
  if (t > T.scanner && t < T.pair + 0.3) scanner(t, place, cam);
  signing(t);

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

  // The DNI slides under the phone, which reads it.
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
