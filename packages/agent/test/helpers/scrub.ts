import type { ScrubOutgoing } from '../../src/research/scrub';

/** A personal value the fake scrubber knows, like the app knows the vault's. */
export const DNI = '12345678Z';

/** The app's scrubber (bridge `research.scrub`), reduced to one known value. */
export const fakeScrub: ScrubOutgoing = async (text) => ({
  text: text.replaceAll(DNI, '[DNI]'),
  redactions: text.split(DNI).length - 1,
});

/** The app could not scrub (e.g. the bridge is down). */
export const failingScrub: ScrubOutgoing = async () => {
  throw new Error('bridge unavailable');
};
