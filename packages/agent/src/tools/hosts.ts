import { isOfficialHost, type Language } from '@sa/shared';
import type { BridgeTransport } from '../bridge/client';
import { clip } from './common';

/**
 * Which web hosts the agent may read on its own (fetch_url, run_script's fetch) or use in the
 * procedure's browser. Official hosts (`isOfficialHost` in @sa/shared) need nothing. Any other
 * host needs the user's approval in the app (bridge `prompt.confirm`), once per host and use
 * for this agent run: reading a site does not allow browsing it (typing, clicking), and browsing
 * does not allow scripts to read it. Only the app's answer counts,
 * never anything the model says. Both answers are remembered, so a script can't ask again and
 * again, and requests that wait for the same host share one prompt.
 */
export interface HostPolicy {
  /**
   * Whether the host of `url` may be read. Asks the user the first time a non-official host is
   * seen. Bridge failures and aborts reject and are not remembered.
   */
  approve(url: URL, signal?: AbortSignal, use?: HostUse): Promise<boolean>;
}

/** read: fetch_url / run_script (default). browse: the procedure's browser. */
export type HostUse = 'read' | 'browse';

export interface HostPolicyOptions {
  bridge: BridgeTransport;
  /** Language of the prompt's copy. Default es. */
  language?: Language;
}

/** The host as the policy keys it: lower case, no IPv6 brackets or trailing dot. */
export function hostKey(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

export function createHostPolicy(options: HostPolicyOptions): HostPolicy {
  const answers = new Map<string, Promise<boolean>>();
  const copy = COPY[options.language ?? 'es'];
  return {
    approve(url, signal, use = 'read') {
      const host = hostKey(url);
      if (isOfficialHost(host)) return Promise.resolve(true);
      const key = `${use} ${host}`;
      const known = answers.get(key);
      if (known) return known;
      const text = copy[use];
      const answer = options.bridge
        .call(
          'prompt.confirm',
          {
            confirmKind: 'action',
            title: text.title(host),
            message: text.message(host),
            details: [
              { label: copy.site, value: host },
              { label: copy.address, value: clip(url.href, 500) },
            ],
            confirmLabel: copy.allow,
            rejectLabel: copy.reject,
          },
          { signal },
        )
        .then((response) => response.approved === true);
      answers.set(key, answer);
      // Only the user's answer is kept: a failed or aborted prompt is asked again next time.
      answer.catch(() => answers.delete(key));
      return answer;
    },
  };
}

const COPY: Record<
  Language,
  Record<HostUse, { title: (host: string) => string; message: (host: string) => string }> & {
    site: string;
    address: string;
    allow: string;
    reject: string;
  }
> = {
  es: {
    read: {
      title: (host) => `¿Dejas que el asistente lea ${host}?`,
      message: (host) =>
        `${host} no es una web oficial. El asistente quiere leer información de esta web. Solo lee páginas: no envía formularios. Mira la dirección: si lleva datos tuyos, no lo permitas. Te lo preguntamos una vez por web en este trámite.`,
    },
    browse: {
      title: (host) => `¿Dejas que el asistente use ${host}?`,
      message: (host) =>
        `${host} no es una web oficial. El asistente quiere usarla en el navegador del trámite: puede pulsar botones y escribir en ella. Mira la dirección: si lleva datos tuyos, no lo permitas. Te lo preguntamos una vez por web en este trámite.`,
    },
    site: 'Web',
    address: 'Dirección',
    allow: 'Permitir',
    reject: 'No permitir',
  },
  en: {
    read: {
      title: (host) => `Let the assistant read ${host}?`,
      message: (host) =>
        `${host} isn't an official website. The assistant wants to read information from it. It only reads pages: it doesn't submit forms. Check the address: if it contains your data, don't allow it. We ask once per website in this procedure.`,
    },
    browse: {
      title: (host) => `Let the assistant use ${host}?`,
      message: (host) =>
        `${host} isn't an official website. The assistant wants to use it in the procedure's browser: it can click buttons and type in it. Check the address: if it contains your data, don't allow it. We ask once per website in this procedure.`,
    },
    site: 'Website',
    address: 'Address',
    allow: 'Allow',
    reject: "Don't allow",
  },
};
