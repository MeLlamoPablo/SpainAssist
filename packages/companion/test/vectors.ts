import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COMPANION_PROTOCOL, type SignatureBinding } from '@sa/shared';
import { createCades, createPades, type KeySigner, resolveAlgorithm } from '@sa/signer';
import {
  deriveSessionKeys,
  ecdh,
  FRAME,
  hkdfSha256,
  Opener,
  Sealer,
  singleRecord,
} from '../src/channel';
import { encodePairingLink } from '../src/link';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fixed = (label: string, n: number) =>
  crypto.createHash('sha512').update(label).digest().subarray(0, n);

function keyPair(label: string) {
  const ecdhKey = crypto.createECDH('prime256v1');
  ecdhKey.setPrivateKey(fixed(label, 32));
  return { privateKey: ecdhKey.getPrivateKey(), publicKey: ecdhKey.getPublicKey() };
}

const HKDF_CASE = {
  ikm: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
  salt: '000102030405060708090a0b0c',
  info: 'f0f1f2f3f4f5f6f7f8f9',
  length: 42,
};

/** A one-page PDF with a fixed /ID, so the PAdES update is the same on every run. */
function minimalPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 41 >>\nstream\nBT /F1 12 Tf 20 100 Td (Solicitud) Tj ET\nendstream',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n\r\n`;
  const id = '<00112233445566778899aabbccddeeff>';
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /ID [${id} ${id}] >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Records what the signer is asked to sign (and its binding); signs with zeros. */
function recordingSigner(): KeySigner & { calls: { data: Buffer; binding?: SignatureBinding }[] } {
  const calls: { data: Buffer; binding?: SignatureBinding }[] = [];
  return {
    keyType: 'rsa',
    calls,
    sign: async (data, _algorithm, options) => {
      calls.push({ data: Buffer.from(data), binding: options?.binding });
      return Buffer.alloc(256);
    },
  };
}

/** What the desktop sends the phone for a CAdES and a PAdES signature (@sa/signer output). */
async function bindingVectors() {
  const cert = readFileSync(new URL('./fixtures/test-cert.der', import.meta.url));
  const algorithm = resolveAlgorithm('SHA256withRSA', 'rsa');
  const signingTime = new Date('2026-10-11T10:00:00Z');

  const text = Buffer.from('Solicitud de prueba', 'utf8');
  const cades = recordingSigner();
  await createCades({
    data: text,
    implicit: false,
    algorithm,
    signer: cades,
    chain: [cert],
    binding: { kind: 'cms', document: 0 },
    attributes: { signingTime },
  });

  const pdf = minimalPdf();
  const pades = recordingSigner();
  await createPades({
    pdf,
    algorithm,
    signer: pades,
    chain: [cert],
    params: {},
    signingTime,
    document: 0,
  });
  const padesCall = pades.calls[0];
  const padesBinding = padesCall?.binding;
  if (padesBinding?.kind !== 'pades') throw new Error('No PAdES binding');

  return {
    algorithm: 'SHA256withRSA',
    cms: {
      document: text.toString('base64'),
      toBeSigned: cades.calls[0]?.data.toString('base64'),
      check: { kind: 'cms', document: 0 },
    },
    pades: {
      document: pdf.toString('base64'),
      toBeSigned: padesCall?.data.toString('base64'),
      check: {
        kind: 'pades',
        document: 0,
        update: Buffer.from(padesBinding.update).toString('base64'),
        byteRange: padesBinding.byteRange,
      },
    },
  };
}

/** Deterministic vectors for the Kotlin implementation (see scripts/vectors.ts). */
export async function buildVectors() {
  const desktop = keyPair('desktop');
  const phone = keyPair('phone');
  const secret = fixed('secret', 32);
  const room = fixed('room', 16);
  const desktopNonce = fixed('desktop nonce', 16);
  const phoneNonce = fixed('phone nonce', 16);
  const relayUrl = 'wss://relay.example.test';
  const shared = ecdh(phone.privateKey, desktop.publicKey);
  const keys = deriveSessionKeys({
    shared,
    secret,
    desktopKey: desktop.publicKey,
    phoneKey: phone.publicKey,
    desktopNonce,
    phoneNonce,
  });

  const helloPlain = singleRecord({
    type: 'hello',
    protocol: COMPANION_PROTOCOL,
    app: '1.0.0',
    platform: 'android',
    device: 'Pixel 8',
  });
  const phoneSealer = new Sealer(keys.phoneToDesktop, 'phoneToDesktop');
  const helloPrefix = Buffer.concat([
    Buffer.from([FRAME.hello]),
    phone.publicKey,
    phoneNonce,
    desktopNonce,
  ]);
  const hello = phoneSealer.seal(helloPrefix, helloPlain);
  const welcomePlain = singleRecord({
    type: 'welcome',
    protocol: COMPANION_PROTOCOL,
    app: '0.1.0',
    expiresAt: '2026-10-11T12:00:00.000Z',
  });
  const desktopSealer = new Sealer(keys.desktopToPhone, 'desktopToPhone');
  const welcome = desktopSealer.seal(Buffer.from([FRAME.welcome]), welcomePlain);
  // Records 1 and 2 from the desktop: one message in two fragments (flag 0, then flag 1).
  const part1 = Buffer.concat([Buffer.from([0]), Buffer.from('{"type":"sign.done",', 'utf8')]);
  const part2 = Buffer.concat([
    Buffer.from([1]),
    Buffer.from('"requestId":"6f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e"}', 'utf8'),
  ]);
  const desktopRecords = [part1, part2].map((plaintext, i) => ({
    seq: i + 1,
    plaintext: hex(plaintext),
    frame: hex(desktopSealer.seal(Buffer.from([FRAME.record]), plaintext)),
  }));
  // A phone record (seq 1) for the other direction.
  const phonePlain = Buffer.concat([Buffer.from([1]), Buffer.from('{"type":"bye"}', 'utf8')]);
  const phoneRecord = phoneSealer.seal(Buffer.from([FRAME.record]), phonePlain);

  // Self-check: the desktop opens what the phone sealed.
  new Opener(keys.phoneToDesktop, 'phoneToDesktop').open(hello, helloPrefix.length);

  return {
    description:
      'Generated by packages/companion/scripts/vectors.ts. Hex unless noted. See src/channel.ts.',
    hkdf: {
      ...HKDF_CASE,
      okm: hex(
        hkdfSha256(
          Buffer.from(HKDF_CASE.ikm, 'hex'),
          Buffer.from(HKDF_CASE.salt, 'hex'),
          Buffer.from(HKDF_CASE.info, 'hex'),
          HKDF_CASE.length,
        ),
      ),
    },
    desktopPrivateKey: hex(desktop.privateKey),
    desktopPublicKey: hex(desktop.publicKey),
    phonePrivateKey: hex(phone.privateKey),
    phonePublicKey: hex(phone.publicKey),
    secret: hex(secret),
    room: hex(room),
    relayUrl,
    /** Text, not hex. */
    link: encodePairingLink({ relayUrl, room, secret, desktopKey: desktop.publicKey }),
    desktopNonce: hex(desktopNonce),
    phoneNonce: hex(phoneNonce),
    sharedSecret: hex(shared),
    desktopToPhoneKey: hex(keys.desktopToPhone),
    phoneToDesktopKey: hex(keys.phoneToDesktop),
    challengeFrame: hex(Buffer.concat([Buffer.from([FRAME.challenge]), desktopNonce])),
    helloPlaintext: hex(helloPlain),
    helloFrame: hex(hello),
    welcomePlaintext: hex(welcomePlain),
    welcomeFrame: hex(welcome),
    desktopRecords,
    phoneRecord: { seq: 1, plaintext: hex(phonePlain), frame: hex(phoneRecord) },
    /** Base64 here. The phone checks these before signing (sign/Binding.kt). */
    bindings: await bindingVectors(),
    login: {
      request: {
        type: 'sign.request',
        requestId: '6f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e',
        purpose: 'login',
        origin: 'https://sede.example.gob.es',
        description: 'Entrar en sede.example.gob.es',
        format: '',
        documents: [],
        verifiable: false,
        expiresAt: '2026-10-11T12:00:00.000Z',
        /** The CAN and the PIN the user typed on the desktop. */
        can: '123456',
        pin: '12345678',
      },
      /** The phone's request when the card refused that PIN. */
      need: {
        type: 'sign.need',
        requestId: '6f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e',
        what: 'pin',
        refused: true,
        triesLeft: 2,
      },
      /** The desktop's answer: the PIN the user typed again. */
      unlock: {
        type: 'sign.unlock',
        requestId: '6f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e',
        pin: '87654321',
        expiresAt: '2026-10-11T12:05:00.000Z',
      },
      toBeSigned: {
        type: 'sign.toBeSigned',
        requestId: '6f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e',
        seq: 1,
        algorithm: 'SHA256withRSA',
        data: Buffer.alloc(32, 7).toString('base64'),
        prehashed: true,
      },
    },
  };
}
