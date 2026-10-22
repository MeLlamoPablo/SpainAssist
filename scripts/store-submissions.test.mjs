import assert from 'node:assert/strict';
import { test } from 'node:test';
import { androidVersion, checkMicrosoft, submitPlay } from './store-submissions.mjs';

// Every request must match a fixture. No store credentials or network connections are used.
function api(t, steps) {
  const queue = [...steps];
  const failures = [];
  t.after(() => {
    assert.deepEqual(failures, []);
    assert.equal(queue.length, 0, 'Unused API fixtures');
  });
  return async (url, options) => {
    try {
      const step = queue.shift();
      assert.ok(step, `Unexpected request: ${url}`);
      assert.equal(options.method ?? 'GET', step.method ?? 'GET');
      assert.ok(url.endsWith(step.path), `Expected ${step.path}, got ${url}`);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      step.check?.(options, url);
      const status = step.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(step.body ?? {}), { status });
    } catch (error) {
      failures.push(error.message);
      throw error;
    }
  };
}

const windowsVersion = '0.3.3.0';
const windowsPackage = { version: windowsVersion, fileStatus: 'Uploaded' };
const windows = (fetcher) =>
  checkMicrosoft({ token: 'test-token', productId: 'product', version: windowsVersion, fetcher });

test('Windows: a published version skips even when another draft exists', async (t) => {
  const result = await windows(
    api(t, [
      {
        path: '/applications/product',
        body: {
          lastPublishedApplicationSubmission: { id: 'published' },
          pendingApplicationSubmission: { id: 'draft' },
        },
      },
      {
        path: '/submissions/published',
        body: { status: 'Published', applicationPackages: [windowsPackage] },
      },
    ]),
  );
  assert.equal(result.action, 'skip');
});

for (const status of [
  'CommitStarted',
  'PreProcessing',
  'Certification',
  'PendingPublication',
  'Publishing',
  'Release',
  'Published',
]) {
  test(`Windows: ${status} counts as already submitted`, async (t) => {
    const result = await windows(
      api(t, [
        {
          path: '/applications/product',
          body: { pendingApplicationSubmission: { id: 'pending' } },
        },
        {
          path: '/submissions/pending',
          body: { status, applicationPackages: [windowsPackage] },
        },
      ]),
    );
    assert.equal(result.action, 'skip');
  });
}

test('Windows: an uploaded draft resumes without replacing its package', async (t) => {
  const result = await windows(
    api(t, [
      { path: '/applications/product', body: { pendingApplicationSubmission: { id: 'draft' } } },
      {
        path: '/submissions/draft',
        body: { status: 'PendingCommit', applicationPackages: [windowsPackage] },
      },
    ]),
  );
  assert.equal(result.action, 'resume');
});

test('Windows: a new version uploads after inspecting the last published version', async (t) => {
  const result = await windows(
    api(t, [
      {
        path: '/applications/product',
        body: { lastPublishedApplicationSubmission: { id: 'old' } },
      },
      {
        path: '/submissions/old',
        body: {
          status: 'Published',
          applicationPackages: [{ ...windowsPackage, version: '0.3.2.0' }],
        },
      },
    ]),
  );
  assert.equal(result.action, 'upload');
});

test('Windows: retrying an older version never uploads over a newer published version', async (t) => {
  await assert.rejects(
    windows(
      api(t, [
        {
          path: '/applications/product',
          body: { lastPublishedApplicationSubmission: { id: 'new' } },
        },
        {
          path: '/submissions/new',
          body: {
            status: 'Published',
            applicationPackages: [{ ...windowsPackage, version: '0.10.0.0' }],
          },
        },
      ]),
    ),
    /refusing a downgrade/,
  );
});

for (const fileStatus of ['PendingUpload', 'PendingDelete']) {
  test(`Windows: a ${fileStatus} package is not an uploaded draft`, async (t) => {
    const result = await windows(
      api(t, [
        { path: '/applications/product', body: { pendingApplicationSubmission: { id: 'draft' } } },
        {
          path: '/submissions/draft',
          body: {
            status: 'PendingCommit',
            applicationPackages: [{ ...windowsPackage, fileStatus }],
          },
        },
      ]),
    );
    assert.equal(result.action, 'upload');
  });
}

test('Windows: another version in certification blocks replacement', async (t) => {
  await assert.rejects(
    windows(
      api(t, [
        {
          path: '/applications/product',
          body: { pendingApplicationSubmission: { id: 'pending' } },
        },
        {
          path: '/submissions/pending',
          body: {
            status: 'Certification',
            applicationPackages: [{ ...windowsPackage, version: '0.3.2.0' }],
          },
        },
      ]),
    ),
    /Another Windows version/,
  );
});

for (const status of [
  'CommitFailed',
  'PreProcessingFailed',
  'CertificationFailed',
  'PublishFailed',
  'ReleaseFailed',
  'UnknownFutureStatus',
]) {
  test(`Windows: ${status} needs attention, not a false success`, async (t) => {
    await assert.rejects(
      windows(
        api(t, [
          {
            path: '/applications/product',
            body: { pendingApplicationSubmission: { id: 'failed' } },
          },
          {
            path: '/submissions/failed',
            body: { status, applicationPackages: [windowsPackage] },
          },
        ]),
      ),
      /resolve it in Partner Center/,
    );
  });
}

test('Windows: a failed lookup fails closed without disclosing the response', async (t) => {
  await assert.rejects(
    windows(
      api(t, [{ path: '/applications/product', status: 503, body: { fileUploadUrl: 'secret' } }]),
    ),
    { message: 'Read Partner Center: HTTP 503' },
  );
});

const playOptions = {
  token: 'test-token',
  code: '303',
  name: '0.3.3',
  track: 'internal',
  status: 'draft',
  bundle: new Blob(['signed-bundle']),
  mapping: new Blob(['mapping']),
};
const release = (status, versionCodes = ['303']) => ({ status, versionCodes });
const insert = { path: '/edits', method: 'POST', body: { id: 'edit' } };
const tracks = (releases = []) => ({
  path: '/edit/tracks',
  body: { tracks: [{ track: 'internal', releases }] },
});
const bundles = (values = []) => ({
  path: '/edit/bundles',
  body: { bundles: values.map((versionCode) => ({ versionCode })) },
});
const cleanup = { path: '/edits/edit', method: 'DELETE', status: 204 };
const commit = (draft = true) => ({
  path: `/edit:commit?changesNotSentForReview=${draft}`,
  method: 'POST',
  body: { id: 'edit' },
});
const update = (expected) => ({
  path: '/edit/tracks/internal',
  method: 'PUT',
  check: ({ body }) =>
    assert.deepEqual(JSON.parse(body), { track: 'internal', releases: expected }),
});
const upload = {
  path: '/edit/bundles?uploadType=media',
  method: 'POST',
  check: ({ body, headers }, url) => {
    assert.ok(new URL(url).pathname.startsWith('/upload/androidpublisher/v3/'));
    assert.equal(body, playOptions.bundle);
    assert.equal(headers['Content-Type'], 'application/octet-stream');
  },
  body: { versionCode: 303 },
};
const mapping = {
  path: '/edit/apks/303/deobfuscationFiles/proguard?uploadType=media',
  method: 'POST',
  check: ({ body }, url) => {
    assert.ok(new URL(url).pathname.startsWith('/upload/androidpublisher/v3/'));
    assert.equal(body, playOptions.mapping);
  },
};

test('Android: read the built versionCode, including an explicit override', () => {
  assert.deepEqual(
    androidVersion({
      applicationId: 'es.spainassist.firma',
      variantName: 'release',
      elements: [{ versionCode: 999, versionName: '0.3.3' }],
    }),
    { code: '999', name: '0.3.3' },
  );
  assert.throws(() => androidVersion({}), /Invalid Android release metadata/);
});

for (const status of ['draft', 'completed', 'inProgress', 'halted']) {
  test(`Android: an existing ${status} version skips all uploads and commits`, async (t) => {
    const result = await submitPlay({
      ...playOptions,
      fetcher: api(t, [insert, tracks([release(status)]), cleanup]),
    });
    assert.match(result, /already on internal.*skipped/);
  });
}

test('Android: a fresh draft uploads bundle and mapping, and keeps the live release', async (t) => {
  const live = release('completed', ['301']);
  const result = await submitPlay({
    ...playOptions,
    fetcher: api(t, [
      insert,
      tracks([live]),
      bundles(),
      upload,
      mapping,
      update([live, { ...release('draft'), name: '0.3.3' }]),
      commit(),
    ]),
  });
  assert.match(result, /uploaded bundle and mapping/);
});

test('Android: a bundle accepted before a failed submission is reused without overwriting its mapping', async (t) => {
  const result = await submitPlay({
    ...playOptions,
    fetcher: api(t, [
      insert,
      tracks(),
      bundles([303]),
      update([{ ...release('draft'), name: '0.3.3' }]),
      commit(),
    ]),
  });
  assert.match(result, /reused the existing bundle/);
});

test('Android: a fresh completed release replaces the previous completed release', async (t) => {
  await submitPlay({
    ...playOptions,
    status: 'completed',
    fetcher: api(t, [
      insert,
      tracks([release('completed', ['301'])]),
      bundles(),
      upload,
      mapping,
      update([{ ...release('completed'), name: '0.3.3' }]),
      commit(false),
    ]),
  });
});

test('Android: Play can require omitting the review flag without re-uploading or changing the draft', async (t) => {
  const result = await submitPlay({
    ...playOptions,
    fetcher: api(t, [
      insert,
      tracks(),
      bundles(),
      upload,
      mapping,
      update([{ ...release('draft'), name: '0.3.3' }]),
      {
        ...commit(),
        status: 400,
        body: {
          error: {
            message:
              'Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set.',
          },
        },
      },
      { path: '/edit:commit', method: 'POST', body: { id: 'edit' } },
    ]),
  });
  assert.match(result, /saved to internal \(draft\)/);
});

test('Android: an unrelated commit rejection is reported with redacted details and is not retried', async (t) => {
  await assert.rejects(
    submitPlay({
      ...playOptions,
      fetcher: api(t, [
        insert,
        tracks(),
        bundles([303]),
        update([{ ...release('draft'), name: '0.3.3' }]),
        {
          ...commit(),
          status: 400,
          body: {
            error: {
              message: 'Invalid app setup\nSee https://example.com/private?token=secret test-token',
              fileUploadUrl: 'never-print-this-field',
            },
          },
        },
        cleanup,
      ]),
    }),
    {
      message:
        'Google Play POST edit:commit: HTTP 400: Invalid app setup See [redacted URL] [redacted]',
    },
  );
});

test('Android: only a bad-request rejection can trigger the review-flag retry', async (t) => {
  await assert.rejects(
    submitPlay({
      ...playOptions,
      fetcher: api(t, [
        insert,
        tracks(),
        bundles([303]),
        update([{ ...release('draft'), name: '0.3.3' }]),
        {
          ...commit(),
          status: 403,
          body: {
            error: { message: 'The query parameter changesNotSentForReview must not be set' },
          },
        },
        cleanup,
      ]),
    }),
    /HTTP 403/,
  );
});

test('Android: a bundle on another track is reused for the requested track', async (t) => {
  await submitPlay({
    ...playOptions,
    fetcher: api(t, [
      insert,
      {
        path: '/edit/tracks',
        body: { tracks: [{ track: 'alpha', releases: [release('completed')] }] },
      },
      bundles([303]),
      update([{ ...release('draft'), name: '0.3.3' }]),
      commit(),
    ]),
  });
});

test('Android: promoting an existing draft preserves its notes and commits for review', async (t) => {
  const draft = {
    ...release('draft'),
    name: 'Release 0.3.3',
    releaseNotes: [{ language: 'es-ES', text: 'Mejoras' }],
  };
  await submitPlay({
    ...playOptions,
    status: 'completed',
    fetcher: api(t, [
      insert,
      tracks([release('completed', ['301']), draft]),
      bundles([303]),
      update([{ ...draft, status: 'completed' }]),
      commit(false),
    ]),
  });
});

test('Android: a newer version blocks an old retry from rolling back the track', async (t) => {
  await assert.rejects(
    submitPlay({
      ...playOptions,
      fetcher: api(t, [insert, tracks([release('completed', ['304'])]), cleanup]),
    }),
    /refusing a downgrade/,
  );
});

test('Android: another draft is preserved and reported instead of overwritten', async (t) => {
  await assert.rejects(
    submitPlay({
      ...playOptions,
      fetcher: api(t, [insert, tracks([release('draft', ['302'])]), cleanup]),
    }),
    /another draft or rollout/,
  );
});

test('Android: a failed lookup stops uploads and deletes its temporary edit', async (t) => {
  await assert.rejects(
    submitPlay({
      ...playOptions,
      fetcher: api(t, [insert, { path: '/edit/tracks', status: 403 }, cleanup]),
    }),
    /HTTP 403/,
  );
});

test('Android: a lost successful commit response is safe to retry', async (t) => {
  const fetcher = api(t, [
    insert,
    tracks(),
    bundles(),
    upload,
    mapping,
    update([{ ...release('draft'), name: '0.3.3' }]),
    { ...commit(), status: 504 },
    { ...cleanup, status: 404 },
    insert,
    tracks([release('draft')]),
    cleanup,
  ]);
  await assert.rejects(submitPlay({ ...playOptions, fetcher }), /HTTP 504/);
  assert.match(await submitPlay({ ...playOptions, fetcher }), /skipped/);
});

test('Android: an unexpected uploaded version never reaches the track', async (t) => {
  await assert.rejects(
    submitPlay({
      ...playOptions,
      fetcher: api(t, [
        insert,
        tracks(),
        bundles(),
        { ...upload, body: { versionCode: 999 } },
        cleanup,
      ]),
    }),
    /versionCode mismatch/,
  );
});
