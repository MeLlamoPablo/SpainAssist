import { PHONE_CALL_AUDIO, PHONE_CALL_MAX_SECONDS, wavFile } from '@sa/shared';

/**
 * Records a phone call from the microphone as PHONE_CALL_AUDIO WAV (16 kHz mono 16-bit PCM).
 * Web Audio, not MediaRecorder: Chromium's MediaRecorder writes only WebM, which the
 * transcription service does not take. The browser resamples the microphone to 16 kHz.
 *
 * Realistic setups: the phone on speaker next to the computer, or a call made on the computer
 * (FaceTime, a softphone) through its speakers. Echo cancellation is off so the other side's
 * voice from the speakers is kept; headphones would hide it.
 */

/** Samples (-1…1) as little-endian 16-bit PCM. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Loudness of a block of samples for the level meter, 0…1 (speech is about 0.2–0.8). */
export function levelOf(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  // Perceptual curve: quiet speech should still move the meter.
  return Math.min(1, Math.sqrt(rms) * 1.6);
}

/** One WAV file from the recorded PCM blocks. */
export function joinPcm(blocks: Uint8Array[]): Uint8Array {
  const total = blocks.reduce((n, b) => n + b.byteLength, 0);
  const samples = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    samples.set(block, offset);
    offset += block.byteLength;
  }
  return wavFile(samples);
}

export interface CallRecording {
  /** Stops and returns the WAV file. */
  stop(): Uint8Array;
  /** Stops and drops everything. */
  cancel(): void;
}

const BLOCK = 4096;

/**
 * Starts recording. `onTick` gets the recorded seconds and the current level about 4 times a
 * second; `onLimit` fires when PHONE_CALL_MAX_SECONDS is reached (recording has stopped and the
 * caller should call `stop()` to get the file). Rejects when the microphone is unavailable.
 */
export async function startCallRecording(handlers: {
  onTick(seconds: number, level: number): void;
  onLimit(): void;
}): Promise<CallRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
  });
  const context = new AudioContext({ sampleRate: PHONE_CALL_AUDIO.sampleRate });
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but needs no worklet module (the app's CSP has no blob:).
  const processor = context.createScriptProcessor(BLOCK, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const blocks: Uint8Array[] = [];
  const maxSamples = PHONE_CALL_MAX_SECONDS * context.sampleRate;
  let recorded = 0;
  let stopped = false;

  const release = () => {
    if (stopped) return;
    stopped = true;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    const room = maxSamples - recorded;
    const take = input.length <= room ? input : input.subarray(0, room);
    blocks.push(toPcm16(take));
    recorded += take.length;
    handlers.onTick(recorded / context.sampleRate, levelOf(take));
    if (recorded >= maxSamples) {
      release();
      handlers.onLimit();
    }
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  return {
    stop() {
      release();
      return joinPcm(blocks);
    },
    cancel() {
      release();
      blocks.length = 0;
    },
  };
}

/** "m:ss" for the recording timer. */
export function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
