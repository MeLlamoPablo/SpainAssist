import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline';
import type { ChatGPTLoginPages } from '@sa/agent';
import {
  FRAGMENT,
  fallbackBackground,
  NUM_COLORS,
  SPLASH_GRADIENT,
  VERTEX,
} from '../../liquid-gradient';
import serifItalic from '../../renderer/src/assets/brand/instrument-serif-italic.ttf?inline';
import serifRegular from '../../renderer/src/assets/brand/instrument-serif-regular.ttf?inline';
import colors from '../../renderer/src/design/colors.css?raw';

/**
 * The browser tab ChatGPT sends the user back to after "Continuar con ChatGPT": the onboarding's
 * look (liquid gradient, white wordmark, card) as one self-contained document, since it is served
 * by the loopback listener and can load nothing else. Spanish only.
 */
export function chatgptLoginPages(): ChatGPTLoginPages {
  return {
    success: page({
      title: 'Listo',
      lines: ['Has conectado ChatGPT.', 'Ya puedes cerrar esta ventana.'],
      icon: 'check',
    }),
    failure: page({
      title: 'No se pudo conectar',
      lines: ['Vuelve a Spain Assist e inténtalo de nuevo.'],
      icon: 'alert',
    }),
    notFound: page({
      title: 'No encontrado',
      lines: ['Esta dirección no es parte del inicio de sesión.'],
      icon: 'alert',
    }),
  };
}

const ICONS = {
  // Lucide "circle-check" and "circle-alert".
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};

const FLAG = `<svg class="flag" viewBox="0 0 58 58" aria-hidden="true"><defs><clipPath id="flag"><rect x="1" y="10" width="56" height="38" rx="7"/></clipPath></defs><g clip-path="url(#flag)"><path fill="var(--sa-flag-red)" d="M0 9h58v40H0z"/><path fill="var(--sa-flag-yellow)" d="M0 19h58v20H0z"/></g><rect x="1" y="10" width="56" height="38" rx="7" fill="none" stroke="var(--sa-flag-outline)" stroke-width="2"/></svg>`;

const STYLE = `
@font-face{font-family:"Inter Variable";font-weight:100 900;font-display:block;src:url(${interLatin}) format("woff2")}
@font-face{font-family:"Instrument Serif";font-weight:400;font-display:block;src:url(${serifRegular}) format("truetype")}
@font-face{font-family:"Instrument Serif";font-style:italic;font-weight:400;font-display:block;src:url(${serifItalic}) format("truetype")}
${colors}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:#3a1a14;font-family:"Inter Variable",system-ui,sans-serif;color:var(--sa-fg);-webkit-font-smoothing:antialiased}
.bg{position:fixed;inset:0;background:${fallbackBackground(SPLASH_GRADIENT.colors)}}
canvas{display:block;width:100%;height:100%}
main{position:relative;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 32px 56px}
.logo{display:flex;align-items:center;gap:11px;height:44px;margin-bottom:32px;color:var(--sa-white);filter:drop-shadow(0 4px 16px rgba(30,8,4,.55));animation:logo 600ms cubic-bezier(.16,1,.3,1) both}
.flag{width:40px;height:40px;flex-shrink:0}
.name{font:400 44px/1 "Instrument Serif",serif;letter-spacing:-.02em;white-space:nowrap;display:inline-flex;gap:.25em}
.card{width:100%;max-width:520px;padding:40px;background:var(--sa-surface);border-radius:16px;box-shadow:var(--sa-shadow-pop),0 0 0 1px var(--sa-black-10)}
.icon{display:flex;align-items:center;justify-content:center;width:56px;height:56px;margin:0 0 24px;border-radius:999px;color:var(--sa-white)}
.icon.check{background:var(--st-done-dot)}
.icon.alert{background:var(--sa-danger)}
.icon svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-size:30px;font-weight:600;letter-spacing:-.025em;line-height:1.25}
p{margin:12px 0 0;font-size:15.5px;line-height:1.625;color:var(--sa-fg-muted)}
@keyframes logo{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion:reduce){.logo{animation:none}}
`;

// The renderer's LiquidGradient without the pointer pass: same GLSL and controls, one draw per frame.
const SCRIPT = `(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) return;
  const o = ${JSON.stringify(SPLASH_GRADIENT)};
  const compile = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, ${JSON.stringify(VERTEX)});
  const fs = compile(gl.FRAGMENT_SHADER, ${JSON.stringify(FRAGMENT)});
  if (!vs || !fs) return;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_position');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);
  const u = (name) => gl.getUniformLocation(program, name);
  const packed = new Float32Array(${NUM_COLORS} * 4);
  o.colors.slice(0, ${NUM_COLORS}).forEach((hex, i) => {
    const n = parseInt(hex.slice(1), 16);
    packed.set([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1], i * 4);
  });
  gl.uniform4fv(u('u_colors'), packed);
  gl.uniform1i(u('u_colors_length'), Math.min(o.colors.length, ${NUM_COLORS}));
  for (const k of ['seed', 'speed', 'loop', 'scale', 'turbAmp', 'turbFreq', 'turbIter', 'waveFreq',
    'distBias', 'mousePush', 'mouseRadius', 'mouseStretch', 'mousePersist', 'ditherMode', 'dither',
    'exposure', 'contrast', 'saturation']) gl.uniform1f(u('u_' + k), o[k]);
  gl.uniform1f(u('u_jellify'), o.jellify ? 1 : 0);
  gl.uniform1i(u('u_push_buffer'), 0);
  gl.uniform4f(u('u_mousePosition'), -999, -999, 0, 0);
  gl.uniform1f(u('u_mouseHover'), 0);
  // Empty push field: the folds don't follow the pointer.
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const uTime = u('u_time'), uDelta = u('u_deltaTime'), uRatio = u('u_pixelRatio'), uRes = u('u_resolution');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now();
  let last = start;
  const draw = (now) => {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform1f(uTime, still ? 0 : (now - start) / 1000);
    gl.uniform1f(uDelta, Math.min((now - last) / 1000, 0.1));
    gl.uniform1f(uRatio, ratio);
    gl.uniform2f(uRes, w, h);
    last = now;
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!still) requestAnimationFrame(draw);
  };
  if (still) { draw(start); addEventListener('resize', () => draw(performance.now())); }
  else requestAnimationFrame(draw);
})();`;

function page({
  title,
  lines,
  icon,
}: {
  title: string;
  lines: string[];
  icon: keyof typeof ICONS;
}): string {
  const body = lines.map((line) => `<span style="display:block">${line}</span>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · Spain Assist</title><style>${STYLE}</style></head><body><div class="bg" aria-hidden="true"><canvas></canvas></div><main><div class="logo">${FLAG}<span class="name"><span>Spain</span><i>Assist</i></span></div><section class="card"><div class="icon ${icon}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg></div><h1>${title}</h1><p>${body}</p></section></main><script>${SCRIPT}</script></body></html>`;
}
