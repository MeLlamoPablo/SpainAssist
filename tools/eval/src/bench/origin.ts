/** Origins of SpainBench's listeners: what is accepted as one, and what counts as this machine. */

/**
 * `value` as an origin (`http://127.0.0.1:3010`), or undefined when it is not a plain http(s)
 * origin: no credentials, no path, no query, no fragment.
 */
export function normalizeOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return undefined;
  }
  return url.origin;
}

/** The loopback interface: `localhost`, 127.0.0.0/8 and ::1 (no other name is trusted to resolve there). */
export function isLoopbackAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return (
    octets !== null && Number(octets[1]) === 127 && octets.slice(1).every((o) => Number(o) <= 255)
  );
}
