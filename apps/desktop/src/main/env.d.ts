/** Defined by electron-vite (Vite) at build time; `DEV` is false in production builds. */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Vite: the file as a base64 data URL. */
declare module '*?inline' {
  const dataUrl: string;
  export default dataUrl;
}

/** Vite: the file's text. */
declare module '*?raw' {
  const text: string;
  export default text;
}
