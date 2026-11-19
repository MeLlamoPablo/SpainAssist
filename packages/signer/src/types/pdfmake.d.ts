// pdfmake 0.3 ships no types: what create.ts uses of its Node build.
declare module 'pdfmake' {
  type FontFiles = { normal: string; bold: string; italics: string; bolditalics: string };
  const pdfmake: {
    sharedVirtualfs: { writeFileSync(name: string, content: Buffer): void };
    setFonts(fonts: Record<string, FontFiles>): void;
    setUrlAccessPolicy(allow: (url: string) => boolean): void;
    setLocalAccessPolicy(allow: (path: string) => boolean): void;
    createPdf(definition: Record<string, unknown>): { getBuffer(): Promise<Buffer> };
  };
  export default pdfmake;
}
