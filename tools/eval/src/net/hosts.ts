/**
 * The host table: which real hostnames the evaluated agents reach SpainBench through. Everything
 * else is refused like a dead domain (the network layer fails closed). Pure: no I/O, shared by the
 * browser proxy (`eval-network.ts`), the host process transport (`world-fetch.ts`) and the exfiltration
 * detector (`canary.ts`).
 *
 * Entries are exact lower-case hostnames or `*.suffix` wildcards. A wildcard matches every host
 * below the suffix at any depth, never the suffix itself. IP literals and `localhost` can never be
 * mapped: loopback is where the scoring API lives.
 */
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { BenchHost } from '../contracts';

type HostKind = BenchHost['kind'] | 'collector';

export interface HostEntry {
  /** Lower-case exact hostname, or `*.suffix`. */
  pattern: string;
  /**
   * `site`/`asset`/`external` as published by SpainBench (`GET /meta/hosts`); `collector` for the
   * attacker host a fixture registers at runtime.
   */
  kind: HostKind;
  site?: string;
  key?: string;
}

/**
 * Canonical form of a hostname: ASCII (punycode), lower case, no trailing dot, no IPv6 brackets.
 * Returns '' for something that is not a hostname. A port is not accepted: split it first
 * (`splitAuthority`).
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, '');
  if (!h) return '';
  if (isIP(h)) return h;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
  if (/[\s/\\@?#%\x00-\x1f]/.test(h)) return '';
  const ascii = /^[\x20-\x7e]+$/.test(h) ? h : domainToASCII(h);
  return /^[a-z0-9_*]([a-z0-9_.*-]*[a-z0-9_])?$/.test(ascii) && !ascii.includes('..') ? ascii : '';
}

/** `host:port` or a bare host, as a CONNECT target or an URL authority gives it. */
export function splitAuthority(authority: string): { host: string; port?: number } {
  const a = authority.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: normalizeHost(v6[1] as string), ...port(v6[2]) };
  const colon = a.lastIndexOf(':');
  if (colon > 0 && a.indexOf(':') === colon)
    return { host: normalizeHost(a.slice(0, colon)), ...port(a.slice(colon + 1)) };
  return { host: normalizeHost(a) };
}

function port(text: string | undefined): { port?: number } {
  const n = text ? Number(text) : Number.NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? { port: n } : {};
}

/**
 * True for names and addresses that mean this machine: never mapped, refused as a closed port.
 * An IPv4-mapped IPv6 address counts as the IPv4 address it wraps (`[::ffff:127.0.0.1]` is what
 * a URL makes of it: `[::ffff:7f00:1]`).
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const version = isIP(h);
  if (version === 4) return h.startsWith('127.') || h === '0.0.0.0';
  if (version !== 6) return false;
  // The URL parser gives every IPv6 spelling one canonical form.
  const canonical = new URL(`http://[${h}]`).hostname.slice(1, -1);
  if (canonical === '::1' || canonical === '::') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1] as string, 16);
  return high >> 8 === 127 || (high === 0 && mapped[2] === '0');
}

/**
 * Whether two origins are the same listener on this machine: both loopback names or addresses and
 * the same port. `http://localhost:3010` and `http://127.0.0.1:3010` are one server, and a server
 * bound to every interface answers on any loopback address, so equal ports are treated as equal
 * listeners. Origins that are not both on this machine are different.
 */
export function sameLoopbackListener(a: string | URL, b: string | URL): boolean {
  const left = new URL(a);
  const right = new URL(b);
  const port = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
  return (
    isLoopbackHost(left.hostname) && isLoopbackHost(right.hostname) && port(left) === port(right)
  );
}

function parsePattern(pattern: string): { pattern: string; suffix?: string } {
  const p = normalizeHost(pattern);
  if (!p) throw new TypeError(`Not a hostname: "${pattern}"`);
  if (isIP(p) || isLoopbackHost(p))
    throw new TypeError(
      `"${pattern}" is an address of this machine or an IP literal: it cannot be mapped`,
    );
  if (p.includes('*')) {
    if (!p.startsWith('*.') || p.indexOf('*', 1) !== -1)
      throw new TypeError(`Wildcards are "*.suffix" only (got "${pattern}")`);
    const suffix = p.slice(2);
    if (suffix.split('.').length < 2)
      throw new TypeError(`Wildcard "${pattern}" is too broad: the suffix needs two labels`);
    return { pattern: p, suffix };
  }
  return { pattern: p };
}

export class HostTable {
  private readonly exact = new Map<string, HostEntry>();
  private readonly wildcards = new Map<string, HostEntry>();
  private changes = 0;

  constructor(entries: Iterable<string | HostEntry> = []) {
    for (const entry of entries) this.add(entry);
  }

  /**
   * The table of `GET /meta/hosts`: every published host (sites, asset hosts and the real hosts
   * that are deliberately out of scope, which SpainBench answers with a neutral 404), plus any
   * extra patterns (e.g. the collector the fixture names).
   */
  static fromBenchHosts(
    hosts: readonly BenchHost[],
    extra: Iterable<string | HostEntry> = [],
  ): HostTable {
    const table = new HostTable();
    for (const h of hosts) table.add({ pattern: h.host, kind: h.kind, site: h.site, key: h.key });
    for (const entry of extra) table.add(entry);
    return table;
  }

  /** Increases on every change: a cache key for what is derived from the table (certificates). */
  get version(): number {
    return this.changes;
  }

  get size(): number {
    return this.exact.size + this.wildcards.size;
  }

  /** Adds a pattern. Returns false (and keeps the first entry) when it is already there. */
  add(entry: string | HostEntry): boolean {
    const e: HostEntry =
      typeof entry === 'string' ? { pattern: entry, kind: 'site' } : { ...entry };
    const parsed = parsePattern(e.pattern);
    e.pattern = parsed.pattern;
    const map = parsed.suffix ? this.wildcards : this.exact;
    const key = parsed.suffix ?? parsed.pattern;
    if (map.has(key)) return false;
    map.set(key, e);
    this.changes++;
    return true;
  }

  /**
   * Registers the attacker host of a fixture (the mock answers it as the collector). A host that
   * is already served as something else is a fixture mistake and throws.
   */
  addCollector(host: string): void {
    const existing = this.exact.get(parsePattern(host).pattern);
    if (existing && existing.kind !== 'collector')
      throw new Error(
        `Collector host ${existing.pattern} is already mapped as a ${existing.kind} host`,
      );
    this.add({ pattern: host, kind: 'collector' });
  }

  /** The entry that serves `host` (exact entries first, then the longest wildcard suffix). */
  match(host: string): HostEntry | undefined {
    const h = normalizeHost(host);
    if (!h || h.includes('*') || isIP(h)) return undefined;
    const exact = this.exact.get(h);
    if (exact) return exact;
    let dot = h.indexOf('.');
    while (dot !== -1) {
      const wildcard = this.wildcards.get(h.slice(dot + 1));
      if (wildcard) return wildcard;
      dot = h.indexOf('.', dot + 1);
    }
    return undefined;
  }

  has(host: string): boolean {
    return this.match(host) !== undefined;
  }

  entries(): HostEntry[] {
    return [...this.exact.values(), ...this.wildcards.values()];
  }

  /** The patterns, as `HostEvalConfig.routes` lists them. */
  patterns(): string[] {
    return this.entries().map((e) => e.pattern);
  }
}
