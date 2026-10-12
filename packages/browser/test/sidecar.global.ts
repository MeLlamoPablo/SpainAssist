import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSidecar } from '@sa/sidecar/build';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    sidecarBinary: string;
  }
}

/** Builds sa-sidecar once for the whole run (Go's cache makes it quick). */
export default async function setup(project: TestProject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sidecar-'));
  project.provide('sidecarBinary', await buildSidecar({ outDir: dir }));
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
