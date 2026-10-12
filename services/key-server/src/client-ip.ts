import { isIPv4, isIPv6 } from 'node:net';
import type { Context } from 'hono';

function socketAddress(c: Context): string | undefined {
  // @hono/node-server exposes the Node request as c.env.incoming (or c.env.server.incoming).
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } }; server?: unknown }
    | undefined;
  const bindings = (env?.server ?? env) as { incoming?: { socket?: { remoteAddress?: string } } };
  return bindings?.incoming?.socket?.remoteAddress;
}

/** Strips IPv4-mapped IPv6 prefixes, zone ids, brackets and ports; returns null if not an IP. */
export function normalizeIp(raw: string): string | null {
  let ip = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  ip = ip.replace(/%.*$/, '').toLowerCase();
  if (ip.startsWith('::ffff:') && isIPv4(ip.slice(7))) ip = ip.slice(7);
  return isIPv4(ip) || isIPv6(ip) ? ip : null;
}

/**
 * Client IP. `X-Forwarded-For` is only trusted when the server runs behind `trustProxyHops`
 * reverse proxies (TRUST_PROXY): each proxy appends the address it saw, so the client address
 * is the Nth entry from the right; anything further left is client-controlled.
 */
export function clientIp(c: Context, trustProxyHops: number): string | null {
  if (trustProxyHops > 0) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const hops = forwarded
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const candidate = hops[Math.max(0, hops.length - trustProxyHops)];
      const ip = candidate ? normalizeIp(candidate) : null;
      if (ip) return ip;
    }
  }
  const remote = socketAddress(c);
  return remote ? normalizeIp(remote) : null;
}

/** Expands an IPv6 address to its 8 hextets. */
function ipv6Groups(ip: string): string[] {
  let address = ip;
  // Embedded IPv4 tail (e.g. 64:ff9b::192.0.2.1) → two hextets.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    address = `${address.slice(0, -v4[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  if (tail === undefined) return left;
  const right = tail ? tail.split(':') : [];
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
}

/**
 * Key used for per-client limits: the IPv4 address, or the /64 prefix for IPv6 (a single
 * subscriber usually controls a whole /64, so per-address limits would be trivial to evade).
 */
export function networkKey(ip: string | null): string {
  if (!ip) return 'unknown';
  if (isIPv4(ip)) return ip;
  const prefix = ipv6Groups(ip)
    .slice(0, 4)
    .map((g) => Number.parseInt(g || '0', 16).toString(16))
    .join(':');
  return `${prefix}::/64`;
}
