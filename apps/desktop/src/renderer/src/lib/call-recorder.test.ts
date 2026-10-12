import { wavSamples, wavSeconds } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { formatDuration, joinPcm, levelOf, toPcm16 } from './call-recorder';

describe('call recorder', () => {
  it('turns samples into 16-bit PCM, clipping out-of-range values', () => {
    const pcm = new DataView(toPcm16(new Float32Array([0, 1, -1, 2, -0.5])).buffer);
    expect([0, 1, 2, 3, 4].map((i) => pcm.getInt16(i * 2, true))).toEqual([
      0, 32767, -32768, 32767, -16384,
    ]);
  });

  it('joins recorded blocks into one WAV file the app accepts', () => {
    const second = toPcm16(new Float32Array(16_000));
    const wav = joinPcm([second, second]);
    const samples = wavSamples(wav);
    expect(samples && wavSeconds(samples.byteLength)).toBe(2);
  });

  it('shows silence as 0 and speech as a visible level', () => {
    expect(levelOf(new Float32Array(100))).toBe(0);
    expect(levelOf(new Float32Array(100).fill(0.1))).toBeGreaterThan(0.4);
    expect(levelOf(new Float32Array(100).fill(1))).toBe(1);
  });

  it('formats the timer as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65.7)).toBe('1:05');
    expect(formatDuration(20 * 60)).toBe('20:00');
  });
});
