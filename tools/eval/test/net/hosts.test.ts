import { describe, expect, it } from 'vitest';
import type { BenchHost } from '../../src/contracts';
import {
  HostTable,
  isLoopbackHost,
  normalizeHost,
  sameLoopbackListener,
  splitAuthority,
} from '../../src/net/hosts';

describe('normalizeHost', () => {
  it('lower-cases, drops trailing dots and brackets', () => {
    expect(normalizeHost('Portal.Seg-Social.GOB.es.')).toBe('portal.seg-social.gob.es');
    expect(normalizeHost('  idp.seg-social.es..  ')).toBe('idp.seg-social.es');
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('converts internationalised names to punycode', () => {
    expect(normalizeHost('Mínimo.es')).toBe('xn--mnimo-zsa.es');
  });

  it('rejects what is not a hostname', () => {
    for (const bad of [
      '',
      '.',
      'a b.es',
      'a/b.es',
      'user@host.es',
      'a..b.es',
      'host.es?x',
      '-a.es',
    ])
      expect(normalizeHost(bad), bad).toBe('');
  });
});

describe('splitAuthority', () => {
  it('splits host and port', () => {
    expect(splitAuthority('Portal.es:8443')).toEqual({ host: 'portal.es', port: 8443 });
    expect(splitAuthority('portal.es')).toEqual({ host: 'portal.es' });
    expect(splitAuthority('portal.es.:443')).toEqual({ host: 'portal.es', port: 443 });
    expect(splitAuthority('[::1]:3020')).toEqual({ host: '::1', port: 3020 });
    expect(splitAuthority('[::1]')).toEqual({ host: '::1' });
    expect(splitAuthority('::1')).toEqual({ host: '::1' });
  });

  it('ignores an invalid port', () => {
    expect(splitAuthority('portal.es:99999')).toEqual({ host: 'portal.es' });
    expect(splitAuthority('portal.es:x')).toEqual({ host: 'portal.es' });
  });
});

describe('isLoopbackHost', () => {
  it('recognises names and addresses of this machine', () => {
    for (const h of [
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      '127.0.0.1',
      '127.8.8.8',
      '::1',
      '0.0.0.0',
    ])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['portal.es', '192.0.2.1', 'localhost.example.es', ''])
      expect(isLoopbackHost(h), h).toBe(false);
  });

  it('sees through IPv4-mapped IPv6, in every spelling (a URL gives [::ffff:7f00:1])', () => {
    for (const h of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:7f00:1]',
      '::FFFF:7F00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:7f01:203',
      '::ffff:0.0.0.0',
      '::ffff:0:0',
      '0:0:0:0:0:0:0:1',
      '::',
    ])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [
      '::ffff:203.0.113.9',
      '::ffff:cb00:7109',
      '::ffff:8000:1',
      '2606:4700:4700::1111',
      '64:ff9b::7f00:1',
    ])
      expect(isLoopbackHost(h), h).toBe(false);
    expect(isLoopbackHost(new URL('http://[::ffff:127.0.0.1]:3010').hostname)).toBe(true);
  });
});

describe('sameLoopbackListener', () => {
  it('is one server whatever loopback name it is reached by', () => {
    for (const other of [
      'http://127.0.0.1:3010',
      'http://localhost:3010/',
      'http://[::1]:3010',
      'http://127.9.9.9:3010',
      'http://[::ffff:127.0.0.1]:3010',
      'http://0.0.0.0:3010',
    ])
      expect(sameLoopbackListener('http://127.0.0.1:3010', other), other).toBe(true);
  });

  it('is not when the port differs or an origin is not on this machine', () => {
    expect(sameLoopbackListener('http://127.0.0.1:3010', 'http://127.0.0.1:3020')).toBe(false);
    expect(sameLoopbackListener('http://127.0.0.1:3010', 'http://203.0.113.9:3010')).toBe(false);
    expect(sameLoopbackListener('http://bench.example:3010', 'http://bench.example:3010')).toBe(
      false,
    );
    expect(sameLoopbackListener('http://127.0.0.1', 'http://localhost:80')).toBe(true);
    expect(sameLoopbackListener('http://127.0.0.1', 'https://127.0.0.1')).toBe(false);
  });
});

describe('HostTable', () => {
  it('matches exact hosts ignoring case and a trailing dot', () => {
    const table = new HostTable(['portal.seg-social.gob.es']);
    expect(table.match('PORTAL.seg-social.gob.es.')?.pattern).toBe('portal.seg-social.gob.es');
    expect(table.has('idp.seg-social.es')).toBe(false);
    expect(table.has('x.portal.seg-social.gob.es')).toBe(false);
  });

  it('matches *.suffix at any depth but never the suffix itself', () => {
    const table = new HostTable(['*.seg-social.gob.es']);
    expect(table.has('a.seg-social.gob.es')).toBe(true);
    expect(table.has('a.b.seg-social.gob.es')).toBe(true);
    expect(table.has('seg-social.gob.es')).toBe(false);
    expect(table.has('evilseg-social.gob.es')).toBe(false);
    expect(table.has('a.seg-social.gob.es.evil.test')).toBe(false);
  });

  it('prefers the exact entry, then the longest wildcard', () => {
    const table = new HostTable([
      { pattern: '*.gob.es', kind: 'external' },
      { pattern: '*.seg-social.gob.es', kind: 'site' },
      { pattern: 'portal.seg-social.gob.es', kind: 'asset' },
    ]);
    expect(table.match('portal.seg-social.gob.es')?.kind).toBe('asset');
    expect(table.match('x.seg-social.gob.es')?.kind).toBe('site');
    expect(table.match('x.agenciatributaria.gob.es')?.kind).toBe('external');
  });

  it('never maps IP literals, localhost or a bare TLD wildcard', () => {
    const table = new HostTable();
    for (const bad of [
      '127.0.0.1',
      '::1',
      '10.0.0.1',
      'localhost',
      'a.localhost',
      '*.es',
      '*',
      'a.*.es',
      '*a.es',
    ])
      expect(() => table.add(bad), bad).toThrow();
    expect(table.size).toBe(0);
    expect(new HostTable(['a.es']).has('127.0.0.1')).toBe(false);
    expect(new HostTable(['*.a.es']).match('*.a.es')).toBeUndefined();
  });

  it('is built from the hosts of GET /meta/hosts', () => {
    const hosts: BenchHost[] = [
      { host: 'portal.seg-social.gob.es', site: 'seg-social-es', key: 'portal', kind: 'site' },
      { host: 'fonts.gstatic.com', site: 'seg-social-es', key: 'fonts', kind: 'asset' },
      { host: 'sede.seg-social.gob.es', site: 'seg-social-es', key: 'sede', kind: 'external' },
    ];
    const table = HostTable.fromBenchHosts(hosts, ['*.example.es']);
    expect(table.size).toBe(4);
    expect(table.match('portal.seg-social.gob.es')).toEqual({
      pattern: 'portal.seg-social.gob.es',
      kind: 'site',
      site: 'seg-social-es',
      key: 'portal',
    });
    expect(table.match('sede.seg-social.gob.es')?.kind).toBe('external');
    expect(table.match('a.example.es')?.kind).toBe('site');
    expect(table.patterns()).toEqual([
      'portal.seg-social.gob.es',
      'fonts.gstatic.com',
      'sede.seg-social.gob.es',
      '*.example.es',
    ]);
  });

  it('adds collector hosts at runtime and bumps its version', () => {
    const table = new HostTable(['portal.es']);
    const before = table.version;
    table.addCollector('Colaborador-TGSS.example.');
    expect(table.version).toBe(before + 1);
    expect(table.match('colaborador-tgss.example')?.kind).toBe('collector');
    // Adding the same host again changes nothing.
    table.addCollector('colaborador-tgss.example');
    expect(table.version).toBe(before + 1);
    expect(table.add('portal.es')).toBe(false);
    expect(table.version).toBe(before + 1);
  });

  it('refuses a collector that is already a site host', () => {
    const table = new HostTable(['portal.es']);
    expect(() => table.addCollector('portal.es')).toThrow(/already mapped/);
  });
});
