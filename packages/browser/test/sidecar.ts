/**
 * One sidecar per test file (setupFiles), used by `createTestService` unless a test passes its
 * own `certificates`, or `certificates: undefined` for a browser without one.
 */
import { Sidecar } from '@sa/sidecar';
import { afterAll, inject } from 'vitest';

const sidecar = await Sidecar.start({ binaryPath: inject('sidecarBinary') });
(globalThis as { testSidecar?: Sidecar }).testSidecar = sidecar;

afterAll(() => sidecar.close());
