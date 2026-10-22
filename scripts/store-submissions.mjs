// Store state, rather than a previous Actions run, is the receipt for a submitted version.
// API references and retry rules: docs/research/store-submissions.md.
import { openAsBlob } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const submittedWindowsStates = new Set([
  'CommitStarted',
  'PreProcessing',
  'Certification',
  'PendingPublication',
  'Publishing',
  'Release',
  'Published',
]);

async function request(fetcher, url, options, label) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(600_000), ...options });
  // Submission responses can contain writable upload URLs. Never print their bodies.
  if (!response.ok) {
    let detail = '';
    if (new URL(url).hostname === 'androidpublisher.googleapis.com') {
      const body = await response.json().catch(() => undefined);
      if (typeof body?.error?.message === 'string') {
        detail = body.error.message
          .replaceAll(options.headers.Authorization.slice('Bearer '.length), '[redacted]')
          .replace(/https?:\/\/\S+/g, '[redacted URL]')
          .replace(/\s+/g, ' ')
          .slice(0, 1000);
      }
    }
    throw new Error(`${label}: HTTP ${response.status}${detail ? `: ${detail}` : ''}`, {
      cause: { status: response.status },
    });
  }
  return response.status === 204 ? undefined : response.json();
}

function hasWindowsVersion(submission, version) {
  return submission.applicationPackages?.some(
    (pkg) => pkg.version === version && pkg.fileStatus === 'Uploaded',
  );
}

function newerWindowsVersion(candidate, version) {
  const parts = candidate.split('.').map(Number);
  const target = version.split('.').map(Number);
  const different = parts.findIndex((part, index) => part !== target[index]);
  return different !== -1 && parts[different] > target[different];
}

export async function checkMicrosoft({ token, productId, version, fetcher = fetch }) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid MSIX version');
  const base = `https://manage.devcenter.microsoft.com/v1.0/my/applications/${encodeURIComponent(productId)}`;
  const get = (url) =>
    request(fetcher, url, { headers: { Authorization: `Bearer ${token}` } }, 'Read Partner Center');
  const app = await get(base);
  if (app.lastPublishedApplicationSubmission?.id) {
    const published = await get(
      `${base}/submissions/${encodeURIComponent(app.lastPublishedApplicationSubmission.id)}`,
    );
    if (hasWindowsVersion(published, version) && published.status === 'Published') {
      return { action: 'skip', reason: `Windows ${version} is already published.` };
    }
    if (
      published.applicationPackages?.some(
        (pkg) => pkg.fileStatus === 'Uploaded' && newerWindowsVersion(pkg.version, version),
      )
    ) {
      throw new Error('Windows already has a newer published version; refusing a downgrade.');
    }
  }
  if (app.pendingApplicationSubmission?.id) {
    const pending = await get(
      `${base}/submissions/${encodeURIComponent(app.pendingApplicationSubmission.id)}`,
    );
    const sameVersion = hasWindowsVersion(pending, version);
    if (submittedWindowsStates.has(pending.status)) {
      if (sameVersion) {
        return {
          action: 'skip',
          reason: `Windows ${version} is already submitted (${pending.status}).`,
        };
      }
      throw new Error(
        `Another Windows version is already submitted (${pending.status}); wait for it.`,
      );
    }
    if (pending.status === 'PendingCommit' && sameVersion) {
      return { action: 'resume', reason: `Windows ${version} is uploaded; resume its draft.` };
    }
    if (!['PendingCommit', 'None', 'Canceled'].includes(pending.status)) {
      throw new Error(
        `Windows submission is ${pending.status}; resolve it in Partner Center first.`,
      );
    }
  }
  return { action: 'upload', reason: `Windows ${version} needs uploading and submission.` };
}

export function androidVersion(metadata) {
  const element = metadata.elements?.[0];
  if (
    metadata.applicationId !== 'es.spainassist.firma' ||
    metadata.variantName !== 'release' ||
    metadata.elements?.length !== 1 ||
    !Number.isSafeInteger(element?.versionCode) ||
    element.versionCode <= 4 ||
    !/^\d+\.\d+\.\d+$/.test(element.versionName)
  ) {
    throw new Error('Invalid Android release metadata');
  }
  return { code: String(element.versionCode), name: element.versionName };
}

export async function submitPlay({
  token,
  code,
  name,
  track,
  status,
  bundle,
  mapping,
  fetcher = fetch,
}) {
  if (!['draft', 'completed'].includes(status)) throw new Error('Invalid Play release status');
  if (!/^\d+$/.test(code) || !track) throw new Error('Missing Play versionCode or track');
  const base =
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/es.spainassist.firma/edits';
  const call = (url, method = 'GET', body, media = false) =>
    request(
      fetcher,
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': media ? 'application/octet-stream' : 'application/json',
        },
        body: body === undefined ? undefined : media ? body : JSON.stringify(body),
      },
      `Google Play ${method} ${new URL(url).pathname.split('/').at(-1)}`,
    );
  const edit = await call(base, 'POST', {});
  if (!edit.id) throw new Error('Google Play did not return an edit ID');
  const editUrl = `${base}/${encodeURIComponent(edit.id)}`;
  let committed = false;
  try {
    const { tracks = [] } = await call(`${editUrl}/tracks`);
    const releases = tracks.find((item) => item.track === track)?.releases ?? [];
    const existing = releases.find((release) => release.versionCodes?.includes(code));
    // Never undo a rollout or a manual halt. A draft only needs work when promoting it.
    if (existing && ['draft', 'completed', 'inProgress', 'halted'].includes(existing.status)) {
      if (existing.status !== 'draft' || status === 'draft') {
        return `Android ${name} (${code}) is already on ${track} (${existing.status}); skipped.`;
      }
    }
    if (existing && existing.status !== 'draft') {
      throw new Error(`Unknown Play release status: ${existing.status}`);
    }
    if (
      releases.some((release) =>
        release.versionCodes?.some((value) => Number(value) > Number(code)),
      )
    ) {
      throw new Error(`Play track ${track} already has a newer version; refusing a downgrade.`);
    }
    if (releases.some((release) => release !== existing && release.status !== 'completed')) {
      throw new Error(
        `Play track ${track} has another draft or rollout; resolve it in Play Console.`,
      );
    }
    const { bundles = [] } = await call(`${editUrl}/bundles`);
    const reuse = bundles.some((item) => String(item.versionCode) === code);
    if (!reuse) {
      const upload = editUrl.replace('/androidpublisher/v3/', '/upload/androidpublisher/v3/');
      const uploaded = await call(`${upload}/bundles?uploadType=media`, 'POST', bundle, true);
      if (String(uploaded.versionCode) !== code)
        throw new Error('Uploaded bundle versionCode mismatch');
      await call(
        `${upload}/apks/${code}/deobfuscationFiles/proguard?uploadType=media`,
        'POST',
        mapping,
        true,
      );
    }
    // Keep the live release while saving a draft. A completed release replaces the old one.
    // Retain release notes and other metadata when promoting an existing draft.
    const release = {
      ...existing,
      name: existing?.name ?? name,
      versionCodes: existing?.versionCodes ?? [code],
      status,
    };
    await call(`${editUrl}/tracks/${encodeURIComponent(track)}`, 'PUT', {
      track,
      releases: status === 'draft' ? [...releases, release] : [release],
    });
    try {
      await call(`${editUrl}:commit?changesNotSentForReview=${status === 'draft'}`, 'POST');
    } catch (error) {
      // Some apps/tracks reject this optional flag, including internal draft releases.
      // Retry only that explicit rejection, keeping the same edit and draft/completed status.
      if (
        error.cause?.status !== 400 ||
        !error.message.includes('The query parameter changesNotSentForReview must not be set')
      ) {
        throw error;
      }
      console.log('Google Play requires omitting changesNotSentForReview; retrying the same edit.');
      await call(`${editUrl}:commit`, 'POST');
    }
    committed = true;
    return `Android ${name} (${code}): ${reuse ? 'reused the existing bundle' : 'uploaded bundle and mapping'}; saved to ${track} (${status}).`;
  } finally {
    // Skipped/failed edits must not linger. A lost commit response is safe to retry: the next
    // run reads the committed track before uploading. Cleanup must not mask the original error.
    if (!committed) await call(editUrl, 'DELETE').catch(() => {});
  }
}

async function record(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}

async function main() {
  if (process.argv[2] === 'windows') {
    const { TENANT_ID, CLIENT_ID, CLIENT_SECRET, PRODUCT_ID, MSIX_VERSION } = process.env;
    if (![TENANT_ID, CLIENT_ID, CLIENT_SECRET, PRODUCT_ID, MSIX_VERSION].every(Boolean)) {
      throw new Error('Missing Partner Center configuration or MSIX version');
    }
    const auth = await request(
      fetch,
      `https://login.microsoftonline.com/${encodeURIComponent(TENANT_ID)}/oauth2/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          resource: 'https://manage.devcenter.microsoft.com',
        }),
      },
      'Authenticate to Partner Center',
    );
    if (!auth.access_token) throw new Error('Partner Center authentication returned no token');
    const result = await checkMicrosoft({
      token: auth.access_token,
      productId: PRODUCT_ID,
      version: MSIX_VERSION,
    });
    await appendFile(process.env.GITHUB_OUTPUT, `action=${result.action}\n`);
    await record(result.reason);
  } else if (process.argv[2] === 'android') {
    const { PLAY_ACCESS_TOKEN, PLAY_TRACK, PLAY_RELEASE_STATUS, ANDROID_BUNDLE_DIR } = process.env;
    if (![PLAY_ACCESS_TOKEN, PLAY_TRACK, PLAY_RELEASE_STATUS, ANDROID_BUNDLE_DIR].every(Boolean)) {
      throw new Error('Missing Google Play configuration or artifact directory');
    }
    const metadata = JSON.parse(await readFile(join(ANDROID_BUNDLE_DIR, 'version.json'), 'utf8'));
    const { code, name } = androidVersion(metadata);
    const bundles = (await readdir(ANDROID_BUNDLE_DIR)).filter((file) => file.endsWith('.aab'));
    if (bundles.length !== 1 || bundles[0] !== `SpainAssist-${name}.aab`) {
      throw new Error('Expected one Android bundle matching the release metadata');
    }
    await record(
      await submitPlay({
        token: PLAY_ACCESS_TOKEN,
        code,
        name,
        track: PLAY_TRACK,
        status: PLAY_RELEASE_STATUS,
        bundle: await openAsBlob(join(ANDROID_BUNDLE_DIR, bundles[0])),
        mapping: await openAsBlob(join(ANDROID_BUNDLE_DIR, 'mapping.txt')),
      }),
    );
    if (PLAY_RELEASE_STATUS === 'draft') {
      await record(
        'The draft is saved in Play Console. Complete the app setup and send it for review there.',
      );
    }
  } else {
    throw new Error('Usage: node scripts/store-submissions.mjs windows|android');
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
