/**
 * Framer's Liquid Gradient shader (GLSL, controls and WebGL helpers), shared by the renderer's
 * `LiquidGradient` component and the pages main serves outside the app (the ChatGPT sign-in
 * page). No React, no DOM beyond WebGL.
 */

/** Values from the Splash frame on Framer's Design page. */
export const SPLASH_GRADIENT: GradientOptions = {
  colors: ['#3A1A14', '#5A2418', '#8A2A1C', '#C8402A', '#E89A4A', '#3A1A14'],
  seed: 454,
  speed: 0.18,
  loop: 0,
  scale: 0.6,
  turbAmp: 0.45,
  turbFreq: 0.1,
  turbIter: 7,
  waveFreq: 2,
  distBias: 0,
  jellify: false,
  mousePush: 0.5,
  mouseRadius: 1,
  mouseStretch: 0,
  mousePersist: 0.8,
  ditherMode: 1,
  dither: 0.2,
  exposure: 1.1,
  contrast: 1.1,
  saturation: 1,
};

export type GradientOptions = {
  colors: readonly string[];
  seed: number;
  speed: number;
  /** Seconds for a seamless loop; 0 runs forever. */
  loop: number;
  scale: number;
  turbAmp: number;
  turbFreq: number;
  turbIter: number;
  waveFreq: number;
  distBias: number;
  jellify: boolean;
  mousePush: number;
  mouseRadius: number;
  mouseStretch: number;
  mousePersist: number;
  /** 0 off, 1 smooth (interleaved gradient noise), 2 grain. */
  ditherMode: number;
  dither: number;
  exposure: number;
  contrast: number;
  saturation: number;
};

export const NUM_COLORS = 8;
/** Push buffer resolution relative to the canvas: it is blurred anyway. */
export const PUSH_SCALE = 0.5;

export const VERTEX = `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const UNIFORMS = `
#define NUM_COLORS ${NUM_COLORS}
uniform vec4 u_colors[NUM_COLORS];
uniform int u_colors_length;
uniform float u_seed;
uniform float u_speed;
uniform float u_loop;
uniform float u_scale;
uniform float u_turbAmp;
uniform float u_turbFreq;
uniform float u_turbIter;
uniform float u_waveFreq;
uniform float u_distBias;
uniform float u_jellify;
uniform float u_mousePush;
uniform float u_mouseRadius;
uniform float u_mouseStretch;
uniform float u_mousePersist;
uniform float u_ditherMode;
uniform float u_dither;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;

uniform sampler2D u_push_buffer;

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_deltaTime;
uniform float u_pixelRatio;
uniform vec4 u_mousePosition;
uniform float u_mouseHover;
`;

export const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
${UNIFORMS}
const float GOLDEN_ANGLE = 2.3999632;
const float TAU = 6.28318530;

// PCG hash - https://www.jcgt.org/published/0009/03/02/
uvec3 hash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

vec3 seedRandom(float seedVal) {
  uvec3 s = uvec3(
    floatBitsToUint(seedVal),
    floatBitsToUint(seedVal * 1.5 + 7.31),
    floatBitsToUint(seedVal * 2.7 + 13.37)
  );
  s = hash3(s);
  return vec3(s) / float(0xFFFFFFFFu);
}

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(0.4545)); }

vec3 linearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0);
  m = pow(max(m, 0.0), 1.0 / 3.0);
  s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  );
}

vec3 oklabToLinear(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

vec3 oklabToLch(vec3 lab) { return vec3(lab.x, length(lab.yz), atan(lab.z, lab.y)); }
vec3 lchToOklab(vec3 lch) { return vec3(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z)); }

vec3 mixLch(vec3 lab0, vec3 lab1, float t) {
  vec3 lch0 = oklabToLch(lab0);
  vec3 lch1 = oklabToLch(lab1);
  if (lch0.y < 0.05) lch0.z = lch1.z;
  if (lch1.y < 0.05) lch1.z = lch0.z;
  float dh = lch1.z - lch0.z;
  if (dh > 3.14159265) dh -= 6.28318530;
  if (dh < -3.14159265) dh += 6.28318530;
  return lchToOklab(vec3(mix(lch0.x, lch1.x, t), mix(lch0.y, lch1.y, t), lch0.z + dh * t));
}

vec3 getColor(int idx) {
  if (u_colors_length < 1) return vec3(0.0);
  return u_colors[clamp(idx, 0, u_colors_length - 1)].rgb;
}

vec3 paletteN(float t, int count) {
  if (count < 1) return vec3(0.0);
  if (count < 2) return toLinear(getColor(0));
  float segmentSize = 1.0 / float(count - 1);
  t = clamp(t, 0.0, 1.0);
  int idx = min(int(floor(t / segmentSize)), count - 2);
  float localT = clamp((t - float(idx) * segmentSize) / segmentSize, 0.0, 1.0);
  vec3 lab0 = linearToOklab(toLinear(getColor(idx)));
  vec3 lab1 = linearToOklab(toLinear(getColor(idx + 1)));
  return oklabToLinear(mixLch(lab0, lab1, localT));
}

float IGN(vec2 uv) { return fract(52.9829189 * fract(dot(uv, vec2(0.06711056, 0.00583715)))); }
float quickNoise(vec2 I) { return fract(sin(dot(I, vec2(12.9898, 78.233))) * 43758.5453); }

// Dither mode: 0 off, 1 smooth (IGN), 2 grain.
float getDither(vec2 I, float mode) {
  if (mode < 0.5) return 0.5;
  if (mode < 1.5) return IGN(I);
  return quickNoise(I);
}

vec3 softGamutMap(vec3 linearRgb) {
  float maxC = max(linearRgb.r, max(linearRgb.g, linearRgb.b));
  float minC = min(linearRgb.r, min(linearRgb.g, linearRgb.b));
  if (minC >= 0.0 && maxC <= 1.0) return linearRgb;
  vec3 lab = linearToOklab(max(linearRgb, 0.0));
  float L = clamp(lab.x, 0.0, 1.0);
  float C = length(lab.yz);
  float h = atan(lab.z, lab.y);
  float maxChroma = 0.4 * (1.0 - pow(abs(2.0 * L - 1.0), 2.0));
  if (C > maxChroma * 0.7) {
    float knee = maxChroma * 0.7;
    C = knee + (maxChroma - knee) * tanh(min((C - knee) / (maxChroma - knee + 0.001), 10.0));
  }
  return clamp(oklabToLinear(vec3(L, C * cos(h), C * sin(h))), 0.0, 1.0);
}

vec3 applyContrastSaturation(vec3 linearRgb, float contrast, float saturation) {
  vec3 lab = linearToOklab(linearRgb);
  float C = length(lab.yz);
  float h = atan(lab.z, lab.y);
  lab.x = clamp((lab.x - 0.5) * contrast + 0.5, 0.0, 1.0);
  C *= saturation;
  lab.y = C * cos(h);
  lab.z = C * sin(h);
  return oklabToLinear(lab);
}

void main() {
  vec2 fragCoord = v_uv * u_resolution;
  vec2 r = u_resolution;
  vec2 p = (fragCoord * 2.0 - r) / r.y;

  int colorCount = u_colors_length;
  if (colorCount < 1) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float t = u_time * 0.3;

  // Map time onto a circle so the animation wraps seamlessly when looping.
  float looping = step(0.5, u_loop);
  float phase = TAU * u_time / max(u_loop, 0.01);
  float radius = u_loop * u_speed * 0.3 / TAU;
  float tA = sin(phase) * radius;
  float tB = (1.0 - cos(phase)) * radius;

  vec3 seedOffset = seedRandom(u_seed);
  vec3 seedOffset2 = seedRandom(u_seed + 100.0);
  float seedAngle = u_seed * GOLDEN_ANGLE;
  vec2 seedPhase = (seedOffset2.xy - 0.5) * TAU;
  float cs = cos(seedAngle);
  float sn = sin(seedAngle);
  mat2 rot = mat2(cs, -sn, sn, cs);
  p = rot * p;

  // Drag the domain along the accumulated cursor push.
  vec2 pushField = texture(u_push_buffer, v_uv).xy;
  p -= rot * pushField * 2.0;

  float dither = getDither(floor(fragCoord / u_pixelRatio), u_ditherMode);

  float totalVal = 0.0;
  float totalWeight = 0.0;
  int turbIter = int(u_turbIter);
  float freq = 1.0 / max(u_turbFreq, 0.01);

  for (float i = 0.0; i < 4.0; i++) {
    float eph = i / 4.0;
    vec2 q = p * u_scale;
    float sq = eph * eph;
    if (u_jellify > 0.5) {
      q.yx *= mix(1.0, 0.5, 1.0 - exp(-sq));
    }
    float a = seedPhase.x;
    float d = seedPhase.y;
    for (int j = 2; j < 13; j++) {
      if (j >= turbIter) break;
      float fj = float(j);
      float t1 = mix(t * u_speed, tA, looping);
      float t2 = mix(t * u_speed, tB, looping);
      q += u_turbAmp * sin(q.yx / freq * fj + t1 + vec2(a, d) + seedOffset.xy * fj) / fj;
      a += cos(fj + d * 1.2 + q.x * 2.0 - t1 + seedOffset2.z + t2 * 0.3 * looping);
      d += sin(fj * q.y + a + seedOffset.z + t1 + seedOffset2.y + t2 * 0.3 * looping);
    }
    float v = 0.5 + 0.5 * sin(length(q.yx + vec2(a, d) * 0.2) * u_waveFreq + i * i + seedOffset.x);
    float weight = smoothstep(0.0, 0.5, eph) * smoothstep(1.0, 0.5, eph);
    totalVal += v * weight;
    totalWeight += weight;
  }

  float val = totalVal / totalWeight;
  val = clamp((val - 0.3) / 0.4, 0.0, 1.0);
  val = pow(val, exp(-u_distBias));
  val = clamp(val + (dither - 0.5) * u_dither, 0.0, 1.0);

  vec3 col = paletteN(val, colorCount);
  col *= u_exposure;
  col = applyContrastSaturation(col, u_contrast, u_saturation);
  col = softGamutMap(col);
  col = toSrgb(col);
  fragColor = vec4(col, 1.0);
}
`;

/** Accumulates cursor velocity into a blurred, decaying displacement field (xy) + smoothed velocity (zw). */
export const PUSH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
${UNIFORMS}
void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 aspectFix = vec2(aspect, 1.0);
  vec2 texel = 1.0 / u_resolution;

  vec4 prev = texture(u_push_buffer, v_uv);
  vec2 c = prev.xy;
  vec2 nl = texture(u_push_buffer, v_uv - vec2(texel.x, 0.0)).xy;
  vec2 nr = texture(u_push_buffer, v_uv + vec2(texel.x, 0.0)).xy;
  vec2 nd = texture(u_push_buffer, v_uv - vec2(0.0, texel.y)).xy;
  vec2 nu = texture(u_push_buffer, v_uv + vec2(0.0, texel.y)).xy;
  vec2 blurred = (nl + nr + nd + nu) * 0.25;
  vec2 field = mix(c, blurred, 0.12);

  float r = clamp(u_deltaTime * 60.0, 0.0, 3.0);
  float decay = pow(mix(0.86, 0.985, clamp(u_mousePersist, 0.0, 1.0)), r);
  field *= decay;

  // Smooth the cursor velocity so uneven per-frame pulses read as a continuous stream.
  vec2 rawVel = u_mousePosition.zw * aspectFix * u_mouseHover;
  float smoothK = 1.0 - pow(0.75, r);
  vec2 mouseVel = mix(prev.zw, rawVel, smoothK);

  float speed = length(mouseVel);
  float brush = max(u_mouseRadius * 0.1, 0.001);
  float speedPerSec = speed / max(u_deltaTime, 1e-4);
  float moving = 1.0 - exp(-speedPerSec * 0.5);

  vec2 dir = speed > 1e-5 ? mouseVel / speed : vec2(1.0, 0.0);
  vec2 ortho = vec2(-dir.y, dir.x);
  vec2 toMouse = (v_uv - u_mousePosition.xy) * aspectFix;
  float along = dot(toMouse, dir);
  float across = dot(toMouse, ortho);
  float ra = brush * (1.0 + u_mouseStretch * moving);
  float rb = brush;
  float d2 = (along * along) / (ra * ra) + (across * across) / (rb * rb);
  float falloff = exp(-d2);

  field += mouseVel * falloff * (u_mousePush * 0.1) * u_mouseHover;
  field = clamp(field, -1.0, 1.0);
  fragColor = vec4(field, mouseVel);
}
`;

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function createProgram(gl: WebGL2RenderingContext, fragment: string) {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[LiquidGradient]', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!vs || !fs) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_position');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[LiquidGradient]', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** Uploads the control values shared by both passes. */
export function setControls(gl: WebGL2RenderingContext, program: WebGLProgram, o: GradientOptions) {
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook
  gl.useProgram(program);
  const u = (name: string) => gl.getUniformLocation(program, name);
  const colors = o.colors.slice(0, NUM_COLORS);
  const packed = new Float32Array(NUM_COLORS * 4);
  for (const [i, c] of colors.entries()) packed.set([...hexToRgb(c), 1], i * 4);
  gl.uniform4fv(u('u_colors'), packed);
  gl.uniform1i(u('u_colors_length'), colors.length);
  const floats: [string, number][] = [
    ['u_seed', o.seed],
    ['u_speed', o.speed],
    ['u_loop', o.loop],
    ['u_scale', o.scale],
    ['u_turbAmp', o.turbAmp],
    ['u_turbFreq', o.turbFreq],
    ['u_turbIter', o.turbIter],
    ['u_waveFreq', o.waveFreq],
    ['u_distBias', o.distBias],
    ['u_jellify', o.jellify ? 1 : 0],
    ['u_mousePush', o.mousePush],
    ['u_mouseRadius', o.mouseRadius],
    ['u_mouseStretch', o.mouseStretch],
    ['u_mousePersist', o.mousePersist],
    ['u_ditherMode', o.ditherMode],
    ['u_dither', o.dither],
    ['u_exposure', o.exposure],
    ['u_contrast', o.contrast],
    ['u_saturation', o.saturation],
  ];
  for (const [name, value] of floats) gl.uniform1f(u(name), value);
  gl.uniform1i(u('u_push_buffer'), 0);
}

/** CSS stand-in while WebGL2 starts, or without it. */
export function fallbackBackground(colors: readonly string[]): string {
  const [c0, c1, c2, c3, c4] = colors;
  return `linear-gradient(135deg, ${c2}, ${c0} 40%, ${c3} 70%, ${c4 ?? c1})`;
}
