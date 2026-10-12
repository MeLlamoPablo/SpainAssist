/**
 * End-to-end interop check between the desktop and the phone app, without a phone or a card:
 *
 *   corepack pnpm --filter @sa/relay-server interop
 *
 * Starts this relay, pairs a DesktopPairing, and runs the Android app's InteropTest (the real
 * Kotlin controller, channel and relay client, with a software RSA key for the DNIe) through
 * Gradle. Then it signs CAdES, PAdES and XAdES through @sa/signer's AutoFirma handler with the
 * phone as the key, and checks every signature the phone returns. Every request carries the CAN
 * and the PIN, as the user types them on the desktop: the card's, except for PAdES, which carries
 * a wrong CAN and a wrong PIN. The phone tries each wrong one once and asks the desktop for a new
 * one (`sign.need`), answered as if the user typed it (`sign.unlock`). Needs JDK 17 and the
 * Android SDK (apps/mobile); offline once Gradle has its dependencies.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopPairing, type PhoneNeed, PhoneSigner } from '@sa/companion';
import type {
  AfirmaCall,
  AfirmaHandlerContext,
  CompanionAlgorithm,
  CompanionCheck,
  SignatureBinding,
  SignatureDigest,
} from '@sa/shared';
import { afirmaHandler } from '@sa/signer';
import { createRelay } from '../src';

const ALGORITHMS: Record<SignatureDigest, CompanionAlgorithm> = {
  sha1: 'SHA1withRSA',
  sha256: 'SHA256withRSA',
  sha384: 'SHA384withRSA',
  sha512: 'SHA512withRSA',
};

function toCheck(binding?: SignatureBinding): CompanionCheck | undefined {
  if (!binding || binding.kind === 'cms') return binding;
  return { ...binding, update: Buffer.from(binding.update).toString('base64') };
}

function minimalPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
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
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** The test card's CAN and PIN. */
const CAN = '246810';
const PIN = '12345678';

const call = (format: string, data: Buffer, params: string | null): AfirmaCall => ({
  method: 'sign',
  args: [data.toString('base64'), 'SHA256withRSA', format, params],
  origin: 'https://sede.example.gob.es',
  url: 'https://sede.example.gob.es/firma',
});

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'sa-interop-'));
  // A throwaway key and certificate standing in for the DNIe's FIRMA key.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/C=ES/CN=PRUEBA INTEROP (FIRMA)',
      '-keyout',
      join(work, 'key.pem'),
      '-outform',
      'DER',
      '-out',
      join(work, 'cert.der'),
    ],
    { stdio: 'ignore' },
  );
  const keyPem = readFileSync(join(work, 'key.pem'), 'utf8');
  const privateKey = crypto.createPrivateKey(keyPem);
  const certificate = readFileSync(join(work, 'cert.der'));
  const publicKey = new crypto.X509Certificate(certificate).publicKey;

  const relay = createRelay();
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  const { port } = relay.server.address() as AddressInfo;
  let signer: PhoneSigner | undefined;
  const pairing = new DesktopPairing({
    relayUrl: `ws://127.0.0.1:${port}`,
    appVersion: '0.0.0-interop',
    onMessage: (m) => signer?.onMessage(m),
    onSession: () => signer?.onSession(),
    onStatus: (s) => console.log(`desktop: pairing ${s.state}`),
  });
  signer = new PhoneSigner(pairing);
  const phoneSigner = signer;

  const config = join(work, 'config.json');
  const calls = [
    call('CAdES', Buffer.from('Solicitud de prueba', 'utf8'), 'mode=implicit'),
    call('PAdES', minimalPdf(), null),
    call('XAdES', Buffer.from('<solicitud><nombre>Prueba</nombre></solicitud>', 'utf8'), null),
  ];
  writeFileSync(
    config,
    JSON.stringify({
      link: pairing.link,
      certificate: certificate.toString('base64'),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      can: CAN,
      pin: PIN,
    }),
  );

  const mobile = fileURLToPath(new URL('../../../apps/mobile', import.meta.url));
  const gradle = spawn(
    './gradlew',
    [
      ':shared:testAndroidHostTest',
      '--tests',
      'es.spainassist.firma.InteropTest',
      '--rerun',
      `-Pinterop=${config}`,
      '--console=plain',
      '-i',
    ],
    { cwd: mobile, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lines: string[] = [];
  const show = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      lines.push(line);
      if (/phone:|FAILED|BUILD|Exception|assert/i.test(line)) console.log(`  ${line.trim()}`);
    }
  };
  gradle.stdout.on('data', show);
  gradle.stderr.on('data', show);
  const exited = new Promise<number>((resolve) => gradle.on('close', (code) => resolve(code ?? 1)));
  // The phone side stopped: nothing more will come.
  void exited.then(() => phoneSigner.onEnded('unpaired'));

  let verified = 0;
  const needs: PhoneNeed[] = [];
  // The user types the right one after a moment.
  const onNeed = async (need: PhoneNeed) => {
    needs.push(need);
    console.log(`desktop: the phone needs a new ${need.what} (refused: ${need.refused})`);
    await new Promise((r) => setTimeout(r, 300));
    return need.what === 'can' ? CAN : PIN;
  };
  // The CAN and PIN the desktop sends with each signature: right, except for PAdES.
  const cans: Record<string, string> = { CAdES: CAN, PAdES: '000000', XAdES: CAN };
  const pins: Record<string, string> = { CAdES: PIN, PAdES: '87654321', XAdES: PIN };
  const ctx: AfirmaHandlerContext = {
    procedureId: 'interop',
    approveSignature: async (summary) => {
      const key = await phoneSigner.request({
        purpose: 'document',
        origin: summary.origin,
        description: summary.description,
        format: summary.format,
        documents: summary.documents,
        verifiable: summary.verifiable,
        can: cans[summary.format] ?? CAN,
        pin: pins[summary.format] ?? PIN,
        onNeed,
        reviewTimeoutMs: 180_000,
      });
      return {
        kind: 'external',
        credentialId: 'interop',
        certificates: key.certificates,
        sign: async (data, digest, binding) => {
          const signature = await key.sign(data, ALGORITHMS[digest], toCheck(binding));
          if (!crypto.verify(digest, data, publicKey, signature))
            throw new Error('The phone returned a signature that does not verify');
          verified++;
          return signature;
        },
        release: (ok) => key.finish(ok),
      };
    },
    report: (event) => console.log(`desktop: ${event.format} ${event.status}`),
  };

  let failures = 0;
  for (const c of calls) {
    const reply = await afirmaHandler(c, ctx);
    if (!reply.ok) {
      failures++;
      console.log(`desktop: ${c.args[2]} failed: ${reply.errorMessage}`);
    }
  }
  const login = await phoneSigner.request({
    purpose: 'login',
    origin: 'https://sede.example.gob.es',
    description: 'Entrar en sede.example.gob.es',
    format: '',
    documents: [],
    verifiable: false,
    can: CAN,
    pin: PIN,
    onNeed,
    reviewTimeoutMs: 180_000,
  });
  const handshake = Buffer.from('A test TLS handshake');
  const digest = crypto.createHash('sha256').update(handshake).digest();
  const signature = await login.sign(digest, 'SHA256withRSA', undefined, true);
  if (!crypto.verify('sha256', handshake, publicKey, signature))
    throw new Error('Login digest was hashed twice');
  login.finish(true);
  console.log('interop: login digest verified');
  // Tells the phone we're done; its test ends when it sees the pairing end.
  pairing.unpair();
  const code = await exited;
  await relay.close();
  console.log(
    `interop: ${calls.length - failures}/${calls.length} signed on the desktop, ${verified} phone signatures verified, needs ${JSON.stringify(needs)}, Gradle exit ${code}`,
  );
  if (code !== 0) console.log(lines.filter((l) => /FAILED|Exception|expected/.test(l)).join('\n'));
  process.exit(
    failures === 0 &&
      code === 0 &&
      verified === calls.length &&
      JSON.stringify(needs) ===
        JSON.stringify([
          { what: 'can', refused: true },
          { what: 'pin', refused: true, triesLeft: 2 },
        ])
      ? 0
      : 1,
  );
}

void main();
