# Retrying store submissions

Checked 2026-10-22. The release jobs consult store state, independently, before uploading.
`scripts/store-submissions.mjs` implements the checks; `node --test scripts/store-submissions.test.mjs`
uses fixture-only HTTP responses. No credential or real store is involved in these tests.

## Microsoft Store

Read the version from the downloaded MSIX's `AppxManifest.xml`, including manual workflow runs
that only supply a release run ID. Authenticate with the existing Partner Center Entra app.
[Get an app](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app) returns separate
last-published and pending submission IDs. Read both as needed with
[get an app submission](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app-submission),
checking `applicationPackages[].version` and `fileStatus=Uploaded`.

- A matching Published submission skips. So does a matching pending submission in CommitStarted,
  PreProcessing, Certification, PendingPublication, Publishing, Release or Published.
- A matching PendingCommit draft resumes the publish-mode update and certification commit,
  without replacing or re-uploading the package.
- A different version undergoing certification blocks the new submission. Failed or unknown
  states fail clearly and require attention in Partner Center; they do not count as success.
- A newer published package blocks an old retry before it can upload or replace any draft.
- An absent version or unfinished package upload follows the existing `msstore publish` path.

The [submission status list](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-status-for-an-app-submission)
defines these states. All workflows share one Microsoft Store concurrency group so tags and
manual retries cannot race over the app's pending submission. Submission JSON may contain
writable `fileUploadUrl` values; errors and summaries never log response bodies.

## Google Play

Read the actual versionCode from AGP's packaged-manifest `output-metadata.json`, saved alongside
the signed AAB as `version.json`. This includes explicit Gradle versionCode overrides without
duplicating the version formula in JavaScript. GitHub OIDC supplies a short-lived access token
with the Android Publisher scope; the job uses the REST API directly.

Create an [edit](https://developers.google.com/android-publisher/api-ref/rest/v3/edits), read its
[tracks](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks), and check
the requested track's release versionCodes before uploading. An existing draft counts as saved
when the requested status is draft. Completed, inProgress and halted releases always skip;
retries must not reverse a rollout or a manual halt. A requested completed status promotes an
existing draft while preserving its notes. Another draft/rollout or a newer version blocks an
update that could overwrite it.

If the code is already in the edit's
[bundle list](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/list),
reuse that bundle when finishing/promoting its release. Do not replace its mapping with one
from a potentially different rebuild. Otherwise
[upload the AAB](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload)
and its [ProGuard mapping](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.deobfuscationfiles/upload).
Save a draft alongside the current live release; a completed release replaces the old one.
[Commit](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit) with
`changesNotSentForReview=true` only for drafts. Delete skipped/failed edits on a best-effort
basis. A response lost after a successful commit is handled by the next run's state check.
Submissions retain their existing per-app concurrency group.

The optional review flag can be rejected for some apps/tracks, including internal drafts.
On HTTP 400 with `The query parameter changesNotSentForReview must not be set`, retry the
same commit once without that parameter. The track's draft/completed status stays unchanged;
the bundle and mapping are not uploaded again. Other errors still fail and clean up the edit.
This follows [Fastlane's commit handling](https://github.com/fastlane/fastlane/blob/master/supply/lib/supply/client.rb).
Google Play errors include only the structured error message, with URLs and the access token
redacted; response bodies and unrelated fields are never logged.

An uploaded bundle that Play no longer exposes in an edit may still have consumed its code;
Play will reject a duplicate upload. The workflow reports that failure and never silently
increments the code. A mapping missing from an already accepted bundle requires manual repair.

## What a retry means

The stores identify versions, not Git commits. Once a version exists, retrying its release
will skip/reuse it even if a new build differs. Ship code changes under a new version. These
checks make re-running a failed job or the whole release safe for already submitted versions;
the GitHub release itself still follows `release.yml`'s existing replace behavior.
