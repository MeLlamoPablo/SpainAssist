import { describe, expect, it } from 'vitest';
import { BridgeParams } from '../src/bridge';
import { PHONE_CALL_TRANSCRIPT_MAX, PhoneCallPrompt, PromptResponse, telHref } from '../src/chat';
import { splitWav, wavFile, wavHeader, wavSamples, wavSeconds } from '../src/wav';

const emasesaCall = {
  kind: 'phone_call',
  title: 'Llama a EMASESA',
  organization: 'EMASESA',
  phoneNumber: '900 822 010',
  purpose: 'Cambiar el número de personas que viven en la casa.',
  questions: ['¿Qué papeles hacen falta?'],
};

/** `seconds` of silence in the app's recording format (16 kHz, 16-bit mono). */
const silence = (seconds: number) => new Uint8Array(seconds * 16_000 * 2);

describe('phone call prompt', () => {
  it('accepts Spanish, short and international numbers', () => {
    for (const phoneNumber of ['900 822 010', '+34 954 59 66 00', '010', '0044 20 7946 0000'])
      expect(PhoneCallPrompt.safeParse({ ...emasesaCall, phoneNumber }).success).toBe(true);
  });

  it('rejects numbers with letters and calls without questions', () => {
    expect(PhoneCallPrompt.safeParse({ ...emasesaCall, phoneNumber: '900-CALL-NOW' }).success).toBe(
      false,
    );
    expect(PhoneCallPrompt.safeParse({ ...emasesaCall, questions: [] }).success).toBe(false);
    expect(
      BridgeParams['prompt.phoneCall'].safeParse({ ...emasesaCall, kind: undefined }).success,
    ).toBe(true);
  });

  it('links to tel: with +34 for 9-digit Spanish numbers', () => {
    expect(telHref('900 822 010')).toBe('tel:+34900822010');
    expect(telHref('+34 954 59 66 00')).toBe('tel:+34954596600');
    expect(telHref('0044 20 7946 0000')).toBe('tel:+442079460000');
    expect(telHref('010')).toBe('tel:010');
  });

  it('caps the transcript the user sends back', () => {
    const response = (transcript: string) =>
      PromptResponse.safeParse({ kind: 'phone_call', outcome: 'done', transcript }).success;
    expect(response('Ellos: Hola.')).toBe(true);
    expect(response('a'.repeat(PHONE_CALL_TRANSCRIPT_MAX + 1))).toBe(false);
    expect(PromptResponse.safeParse({ kind: 'phone_call', outcome: 'maybe' }).success).toBe(false);
  });
});

describe('call recordings (WAV)', () => {
  it('reads back the samples of a file the app wrote', () => {
    const samples = silence(2);
    expect(wavSamples(wavFile(samples))?.byteLength).toBe(samples.byteLength);
    expect(wavSeconds(samples.byteLength)).toBe(2);
  });

  it('rejects other formats and truncated files', () => {
    const stereo = wavFile(silence(1));
    stereo[22] = 2;
    expect(wavSamples(stereo)).toBeUndefined();
    expect(wavSamples(wavFile(silence(1)).subarray(0, 100))).toBeUndefined();
    expect(wavSamples(new TextEncoder().encode('not a wav file at all, just text…….'))).toBe(
      undefined,
    );
  });

  it('cuts long recordings into valid parts', () => {
    const parts = splitWav(silence(11), 5);
    expect(parts.map((part) => wavSeconds(part.byteLength - wavHeader(0).byteLength))).toEqual([
      5, 5, 1,
    ]);
    for (const part of parts) expect(wavSamples(part)).toBeDefined();
  });
});
