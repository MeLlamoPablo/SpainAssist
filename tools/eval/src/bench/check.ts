/**
 * What the harness asks of a SpainBench server before it uses it: the scoring API it speaks
 * (`checkBenchVersion`), whether it can run a given fixture (`runnable`), and the facts a run
 * records about it (`describeBench`). Pure: they read a `BenchVersion` and nothing else.
 */
import { type BenchVersion, type Fixture, SUPPORTED_SCORING_API } from '../contracts';
import { drawsOnPdfPage, PDF_PAGE_VARIANTS } from '../fixtures/plant-points';
import { BenchVersionError } from './errors';

/**
 * Features every run needs: worlds addressed by header on the real hostnames, the request log and
 * the downloads (artifacts, the PDF rule), the wrong-turn count (score), the event stream (the
 * instant failure of a negated rule), the collector (exfiltration of every fixture) and snapshots
 * (checkpoints) and the disguise (a world whose pages say they are a copy is no evaluation).
 */
export const REQUIRED_FEATURES: readonly string[] = [
  'worlds',
  'virtual-hosts',
  'requests',
  'downloads',
  'wrong-turns',
  'events',
  'collector',
  'snapshot',
  'disguise',
];

/** Needed on top of those by a fixture that plants an injection. */
export const INJECTION_FEATURE = 'plants';

/** The error for a server that speaks scoring API `serverApi`, saying which side to update. */
export function versionMismatch(serverApi: number): BenchVersionError {
  const supportedApi = SUPPORTED_SCORING_API;
  const message =
    serverApi > supportedApi
      ? `SpainBench speaks scoring API v${serverApi} but this harness supports v${supportedApi}: ` +
        'the harness is older than the server. Update the eval suite, or run an older SpainBench.'
      : `SpainBench speaks scoring API v${serverApi} but this harness needs v${supportedApi}: ` +
        'the server is older than the harness. Update SpainBench and restart it.';
  return new BenchVersionError({ serverApi, supportedApi, message });
}

/** Throws a `BenchVersionError` unless the server speaks the scoring API this harness supports. */
export function checkBenchVersion(version: Pick<BenchVersion, 'scoringApi'>): void {
  if (version.scoringApi !== SUPPORTED_SCORING_API) throw versionMismatch(version.scoringApi);
}

export type Runnable = { ok: true } | { ok: false; reason: string };

const list = (items: readonly string[]): string =>
  items.length ? items.map((item) => `"${item}"`).join(', ') : 'none';

/**
 * Whether this server can run the fixture: every site of its world (and every preset's site)
 * exists, the injection variant is one the server lists, and the features the run depends on are
 * there. A refusal is one line.
 */
export function runnable(fixture: Fixture, version: BenchVersion): Runnable {
  const problems: string[] = [];
  const served = Object.keys(version.sites);

  const wanted = [
    ...new Set([...(fixture.world.sites ?? []), ...Object.keys(fixture.world.presets ?? {})]),
  ];
  const missingSites = wanted.filter((site) => !served.includes(site));
  if (missingSites.length) {
    problems.push(
      `the server has no site ${list(missingSites)} (it serves ${list(served)}; is SpainBench up to date?)`,
    );
  }

  const injection = fixture.world.injection;
  if (injection) {
    const variants = version.injections.map((entry) => entry.id);
    const entry = version.injections.find((candidate) => candidate.id === injection.variant);
    if (!entry) {
      problems.push(
        `the server does not list injection variant "${injection.variant}" (it lists ${list(variants)})`,
      );
    } else if (
      entry.points &&
      drawsOnPdfPage(entry.points) !== PDF_PAGE_VARIANTS.has(injection.variant)
    ) {
      // The plant-shown precondition counts a PDF page image as shown for exactly these variants.
      problems.push(
        `injection variant "${injection.variant}" is planted at ${list(entry.points)}, which ` +
          'src/fixtures/plant-points.ts does not expect (update PDF_PAGE_VARIANTS)',
      );
    }
  }

  const needed = injection ? [...REQUIRED_FEATURES, INJECTION_FEATURE] : REQUIRED_FEATURES;
  const missingFeatures = needed.filter((feature) => !version.features.includes(feature));
  if (missingFeatures.length) {
    problems.push(
      `the server lacks the feature${missingFeatures.length > 1 ? 's' : ''} ${list(missingFeatures)}`,
    );
  }

  return problems.length ? { ok: false, reason: problems.join('; ') } : { ok: true };
}

/** What `run.json` says about the mock a run was scored against. */
export interface BenchDescription {
  name: BenchVersion['name'];
  version: string;
  gitSha?: string;
  /** Covers the kernel and every site: the exact mock. */
  contentHash: string;
  /** Version and content hash of each site the server holds. */
  sites: BenchVersion['sites'];
  features: string[];
  scoringApi: number;
  snapshotFormat: string;
}

export function describeBench(version: BenchVersion): BenchDescription {
  return {
    name: version.name,
    version: version.version,
    ...(version.gitSha ? { gitSha: version.gitSha } : {}),
    contentHash: version.contentHash,
    sites: Object.fromEntries(
      Object.entries(version.sites).map(([id, site]) => [
        id,
        { version: site.version, contentHash: site.contentHash },
      ]),
    ),
    features: [...version.features],
    scoringApi: version.scoringApi,
    snapshotFormat: version.snapshotFormat,
  };
}
