import { useEffect, useRef, useState } from 'react';
import {
  createProgram,
  FRAGMENT,
  fallbackBackground,
  type GradientOptions,
  PUSH_FRAGMENT,
  PUSH_SCALE,
  SPLASH_GRADIENT,
  setControls,
} from '../../../liquid-gradient';
import { cn } from '../lib/cn';

/**
 * Animated "liquid gradient" background: a port of Framer's built-in Liquid Gradient shader, as
 * used by the Splash frame on Framer's Design page. Same GLSL, uniforms and conventions as
 * Framer's runtime (WebGL2, `u_time` in seconds, rendered at the device pixel ratio):
 *
 * - colour pass: a seeded, rotated domain goes through a few layers of coupled sine turbulence;
 *   the distance of the warped point drives sine bands that pick a colour from the palette
 *   (interpolated in OKLCH, in linear light), with interleaved-gradient-noise dither, exposure,
 *   OKLab contrast/saturation and a soft gamut map;
 * - push pass (opt-in, `interactive`): a ping-pong buffer accumulates cursor velocity, blurs and
 *   decays it, and the colour pass displaces its domain by that field so the folds drag along
 *   with the pointer. Off by default because Framer's published site doesn't feed the pointer to
 *   this shader either, so the folds don't react to it there.
 *
 * Falls back to a static CSS gradient without WebGL2.
 */

export function LiquidGradient({
  className,
  animate = true,
  interactive = false,
  options = SPLASH_GRADIENT,
}: {
  className?: string;
  /** False renders one still frame, like Framer's canvas (also the case with reduced motion). */
  animate?: boolean;
  /** Let the mouse drag the folds (the shader's Mouse controls). */
  interactive?: boolean;
  options?: GradientOptions;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    // No `alpha: false`, though every pixel the shader writes is opaque: the compositor must still
    // draw what is under the canvas (the onboarding's rehearsal). For the same reason, the
    // fallback background goes away once the canvas has drawn.
    const gl = canvas?.getContext('webgl2', { antialias: false });
    if (!canvas || !gl) return;

    const main = createProgram(gl, FRAGMENT);
    const push = createProgram(gl, PUSH_FRAGMENT);
    if (!main || !push) return;
    setControls(gl, main, options);
    setControls(gl, push, options);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const still = !animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The push field holds signed values: it needs a float target. Without one (or when still or
    // not interactive), the colour pass samples an empty field and the pointer has no effect.
    const floatTargets =
      interactive && !still && Boolean(gl.getExtension('EXT_color_buffer_float'));
    const makeTarget = (w: number, h: number) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (floatTargets) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo };
    };
    let targets: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
    let pushSize = [1, 1];
    const freeTargets = () => {
      for (const t of targets) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    };

    let pixelRatio = 1;
    const resize = () => {
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
      const h = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      if (canvas.width === w && canvas.height === h && targets.length) return;
      canvas.width = w;
      canvas.height = h;
      freeTargets();
      pushSize = [Math.max(1, Math.round(w * PUSH_SCALE)), Math.max(1, Math.round(h * PUSH_SCALE))];
      targets = [makeTarget(pushSize[0]!, pushSize[1]!), makeTarget(pushSize[0]!, pushSize[1]!)];
    };

    // Mouse pointer in the canvas's UV space (y up) and its velocity in UV per second, as
    // Framer's runtime passes them (`u_mousePosition` = x, y, vx, vy). Touch is ignored.
    const pointer = { x: -999, y: -999, lastX: -999, lastY: -999, vx: 0, vy: 0, hover: 0 };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = (e.clientX - rect.left) / rect.width;
      pointer.y = 1 - (e.clientY - rect.top) / rect.height;
      if (!pointer.hover) {
        pointer.lastX = pointer.x;
        pointer.lastY = pointer.y;
      }
      pointer.hover = 1;
    };
    const onLeave = () => {
      pointer.hover = 0;
    };
    if (floatTargets) {
      window.addEventListener('pointermove', onMove);
      document.documentElement.addEventListener('pointerleave', onLeave);
    }

    const start = performance.now();
    let last = start;
    let current = 0;
    let frame = 0;
    const draw = (now: number) => {
      const time = still ? 0 : (now - start) / 1000;
      const delta = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (delta > 0) {
        pointer.vx = (pointer.x - pointer.lastX) / delta;
        pointer.vy = (pointer.y - pointer.lastY) / delta;
        pointer.lastX = pointer.x;
        pointer.lastY = pointer.y;
      }
      const setFrame = (program: WebGLProgram, w: number, h: number) => {
        // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook
        gl.useProgram(program);
        gl.uniform1f(gl.getUniformLocation(program, 'u_time'), time);
        gl.uniform1f(gl.getUniformLocation(program, 'u_deltaTime'), delta);
        gl.uniform1f(gl.getUniformLocation(program, 'u_pixelRatio'), pixelRatio);
        gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), w, h);
        gl.uniform4f(
          gl.getUniformLocation(program, 'u_mousePosition'),
          pointer.x,
          pointer.y,
          pointer.vx,
          pointer.vy,
        );
        gl.uniform1f(gl.getUniformLocation(program, 'u_mouseHover'), pointer.hover);
      };
      const read = targets[current]!;
      if (floatTargets) {
        const write = targets[1 - current]!;
        setFrame(push, pushSize[0]!, pushSize[1]!);
        gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
        gl.viewport(0, 0, pushSize[0]!, pushSize[1]!);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, read.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        current = 1 - current;
      }
      setFrame(main, canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets[current]!.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      setDrawn(true);
    };
    const loop = (now: number) => {
      draw(now);
      frame = requestAnimationFrame(loop);
    };

    const observer = new ResizeObserver(() => {
      resize();
      if (still) draw(performance.now());
    });
    observer.observe(canvas);
    resize();
    if (still) draw(start);
    else frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      freeTargets();
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(main);
      gl.deleteProgram(push);
    };
  }, [animate, interactive, options]);

  return (
    <div
      aria-hidden
      className={cn('overflow-hidden', className)}
      style={drawn ? undefined : { background: fallbackBackground(options.colors) }}
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
