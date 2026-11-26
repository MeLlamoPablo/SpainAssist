import { describe, expect, it } from 'vitest';
import { CertificateBlocks } from './certificate-blocks';

const QUIET_MS = 20;

/** Blocks with a short quiet time, and the procedures whose certificate they turned off. */
function blocks() {
  const stopped: { procedureId: string; tls: boolean }[] = [];
  const b = new CertificateBlocks(async (procedureId, tls) => {
    stopped.push({ procedureId, tls });
  }, QUIET_MS);
  return { b, stopped };
}

describe('certificate blocks', () => {
  it('end only after the signatures in them are over', async () => {
    const { b, stopped } = blocks();
    const blockId = b.open('p_1', true);
    if (!blockId) throw new Error('the block did not open');
    const done = b.busy('p_1');
    const closing = b.close(blockId);
    await new Promise((resolve) => setTimeout(resolve, 3 * QUIET_MS));
    expect(stopped).toEqual([]);
    expect(b.isOpen('p_1')).toBe(true);

    done();
    expect(await closing).toBe(true);
    expect(stopped).toEqual([{ procedureId: 'p_1', tls: true }]);
    expect(b.isOpen('p_1')).toBe(false);
    expect(await b.close(blockId)).toBe(false);
  });

  it('open one at a time per procedure', () => {
    const { b } = blocks();
    expect(b.open('p_1', false)).toBeDefined();
    expect(b.open('p_1', false)).toBeUndefined();
    expect(b.open('p_2', false)).toBeDefined();
  });

  it("close the blocks a run left open when it ends, and only that run's", async () => {
    const { b, stopped } = blocks();
    b.open('p_1', false, 'r_1');
    b.open('p_2', true, 'r_2');
    b.closeRun('r_1');
    await new Promise((resolve) => setTimeout(resolve, 10 * QUIET_MS));
    expect(stopped).toEqual([{ procedureId: 'p_1', tls: false }]);
    expect(b.isOpen('p_2')).toBe(true);
  });

  it('give the reason of a refused request once, and none inside a block', () => {
    const { b } = blocks();
    b.refuse('p_1');
    expect(b.refusal('p_1')).toMatch(/AutoFirma\) outside page.withCertificate/);
    expect(b.refusal('p_1')).toBeUndefined();
    expect(b.refusal('p_1', ['w2.seg-social.es'])).toMatch(/origins: \["https:\/\/w2/);
    b.open('p_1', false);
    expect(b.refusal('p_1', ['w2.seg-social.es'])).toBeUndefined();
  });
});
