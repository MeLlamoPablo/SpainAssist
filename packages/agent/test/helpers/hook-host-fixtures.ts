/** What the test host entry (hook-host.ts) is told and what its stand-ins answer. */

export interface TestHooks {
  /** JSONL file the hooks append to. */
  log: string;
  /** A fixed ISO instant, or a file holding one (read on every call). */
  now?: string | { file: string };
  egress?: boolean;
  research?: 'key-server' | 'exa' | 'none';
  /** `rename` breaks the contract on purpose. */
  wrapTool?: boolean | 'rename';
  /** `global-fetch` also replaces globalThis.fetch with a recording wrapper. */
  onModel?: boolean | 'global-fetch';
}

export const SEDE_PAGE =
  '<html><head><title>Sede de prueba</title></head><body><main><h1>Sede de prueba</h1><p>Texto servido por el egress de prueba.</p></main></body></html>';

export const BOE_BODY = {
  status: { code: '200', text: 'ok' },
  data: [
    {
      identificador: 'BOE-A-2005-21163',
      titulo: 'Real Decreto 1553/2005, por el que se regula el documento nacional de identidad.',
      vigencia_agotada: 'N',
    },
  ],
};

export const RESEARCH_RUN = '0b6c1d7e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
export const RESEARCH_TEXT = 'Resultado de investigación del stub';
