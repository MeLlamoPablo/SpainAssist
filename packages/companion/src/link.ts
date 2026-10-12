/**
 * The pairing link the desktop shows as a QR code:
 *
 *   https://<relay host>/p#<Base64url payload>
 *
 * The payload sits in the fragment, so browsers never send it to the server. Binary layout:
 *
 *   version (1) = 1 | room id (16) | secret (32) | desktop public key (65, P-256 uncompressed)
 *   | relay base URL (UTF-8, the rest: ws:// or wss://)
 *
 * The phone app opens the link (App Links) or scans it with its own camera.
 */
import { fromBase64Url, toBase64Url } from './bytes';

export const LINK_VERSION = 1;
export const ROOM_BYTES = 16;
export const SECRET_BYTES = 32;
export const PUBLIC_KEY_BYTES = 65;
const FIXED = 1 + ROOM_BYTES + SECRET_BYTES + PUBLIC_KEY_BYTES;

export interface PairingLink {
  /** WebSocket base URL of the relay (ws:// or wss://, no trailing slash). */
  relayUrl: string;
  room: Uint8Array;
  secret: Uint8Array;
  desktopKey: Uint8Array;
}

/** The https:// (or http:// for a local ws:// relay) page the link points at. */
export function linkBase(relayUrl: string): string {
  const url = new URL(relayUrl);
  const scheme = url.protocol === 'ws:' ? 'http:' : 'https:';
  return `${scheme}//${url.host}/p`;
}

export function normalizeRelayUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Unsupported relay URL');
  if (url.search || url.hash || url.username || url.password) throw new Error('Bad relay URL');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function encodePairingLink(link: PairingLink): string {
  if (link.room.length !== ROOM_BYTES) throw new Error('Bad room id');
  if (link.secret.length !== SECRET_BYTES) throw new Error('Bad secret');
  if (link.desktopKey.length !== PUBLIC_KEY_BYTES || link.desktopKey[0] !== 0x04)
    throw new Error('Bad desktop key');
  const relay = normalizeRelayUrl(link.relayUrl);
  const payload = Buffer.concat([
    Buffer.from([LINK_VERSION]),
    link.room,
    link.secret,
    link.desktopKey,
    Buffer.from(relay, 'utf8'),
  ]);
  return `${linkBase(relay)}#${toBase64Url(payload)}`;
}

export function decodePairingLink(text: string): PairingLink {
  const hash = text.indexOf('#');
  if (hash < 0) throw new Error('Not a pairing link');
  const payload = fromBase64Url(text.slice(hash + 1));
  if (payload.length <= FIXED || payload.length > FIXED + 512 || payload[0] !== LINK_VERSION) {
    throw new Error('Not a pairing link');
  }
  let at = 1;
  const take = (n: number) => {
    const out = payload.subarray(at, at + n);
    at += n;
    return out;
  };
  const room = take(ROOM_BYTES);
  const secret = take(SECRET_BYTES);
  const desktopKey = take(PUBLIC_KEY_BYTES);
  if (desktopKey[0] !== 0x04) throw new Error('Not a pairing link');
  const relayUrl = normalizeRelayUrl(payload.subarray(at).toString('utf8'));
  return { relayUrl, room, secret, desktopKey };
}

export function roomId(room: Uint8Array): string {
  return toBase64Url(room);
}
