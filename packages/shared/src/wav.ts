import { PHONE_CALL_AUDIO, WAV_HEADER_BYTES } from './chat';

/**
 * The plain WAV files of call recordings (PHONE_CALL_AUDIO: 16-bit PCM, mono, 16 kHz). The
 * renderer writes them; main checks them and cuts them into parts for transcription.
 */

const { sampleRate, channels, bitsPerSample } = PHONE_CALL_AUDIO;
const BLOCK_ALIGN = channels * (bitsPerSample / 8);
const BYTE_RATE = sampleRate * BLOCK_ALIGN;

/** The 44-byte header of a PHONE_CALL_AUDIO WAV file with `dataBytes` bytes of samples. */
export function wavHeader(dataBytes: number): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, BYTE_RATE, true);
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/** A WAV file of PHONE_CALL_AUDIO samples (little-endian 16-bit PCM). */
export function wavFile(samples: Uint8Array): Uint8Array {
  const file = new Uint8Array(WAV_HEADER_BYTES + samples.byteLength);
  file.set(wavHeader(samples.byteLength), 0);
  file.set(samples, WAV_HEADER_BYTES);
  return file;
}

/**
 * The samples of a WAV file the app wrote: exactly the header `wavHeader` writes, and a data
 * size that matches the file. Undefined for anything else.
 */
export function wavSamples(file: Uint8Array): Uint8Array | undefined {
  if (file.byteLength < WAV_HEADER_BYTES) return undefined;
  const dataBytes = file.byteLength - WAV_HEADER_BYTES;
  if (dataBytes % BLOCK_ALIGN !== 0) return undefined;
  const expected = wavHeader(dataBytes);
  for (let i = 0; i < WAV_HEADER_BYTES; i++) if (file[i] !== expected[i]) return undefined;
  return file.subarray(WAV_HEADER_BYTES);
}

/** Seconds of audio in `bytes` bytes of PHONE_CALL_AUDIO samples. */
export function wavSeconds(bytes: number): number {
  return bytes / BYTE_RATE;
}

/** Cuts samples into WAV files of at most `seconds` each (the last one may be shorter). */
export function splitWav(samples: Uint8Array, seconds: number): Uint8Array[] {
  const size = Math.max(BLOCK_ALIGN, Math.floor(seconds * sampleRate) * BLOCK_ALIGN);
  const parts: Uint8Array[] = [];
  for (let start = 0; start < samples.byteLength; start += size)
    parts.push(wavFile(samples.subarray(start, start + size)));
  return parts;
}
