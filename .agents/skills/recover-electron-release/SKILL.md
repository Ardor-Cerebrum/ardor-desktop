---
name: recover-electron-release
description: Diagnose a failed Ardor Desktop release or rolling Electron update feed and resume the narrowly matching GitHub Actions recovery path when explicitly authorized.
---

# Recover an Electron release

Use this workflow only after an Electron release or rolling-feed update failed. Read [`docs/build-channels.md`](../../../docs/build-channels.md#github-release-assets), [`.github/workflows/release.yml`](../../../.github/workflows/release.yml), and [`.github/workflows/refresh-electron-update-feed.yml`](../../../.github/workflows/refresh-electron-update-feed.yml) before acting; the current workflows are authoritative.

Workflow dispatch and release/feed changes mutate public GitHub state. Read-only diagnosis is allowed, but obtain explicit authorization for the exact workflow, tag, and repository before dispatching.

## Diagnose

1. Inspect the failed run's jobs, logs, source SHA, event, and inputs. Decide whether failure occurred before semantic-release created a version, while building/uploading the versioned release, or only while advancing `electron-update-feed`.
2. Inspect the tag and GitHub release without changing them. Confirm the tag's commit, containment in `main`, `package.json` version, draft/prerelease state, and existing asset names.
3. Do not delete tags/releases or manually assemble assets to bypass workflow validation. Resolve missing credentials, finalized-key gates, platform failures, or contract failures first.

## Choose the recovery path

- If no tag/version was created, fix the underlying code/configuration and let a normal reviewed merge or an explicitly authorized dry run validate the next release. A blank manual `existing_release_tag` is a dry run, not a release retry.
- If semantic-release created the latest valid tag but its versioned prerelease is absent or still a draft/incomplete, dispatch `Release` from `main` with `existing_release_tag=vX.Y.Z`. The workflow validates provenance, uses the requirements snapshot from that tag, and creates or resumes only the matching draft.
- If the versioned prerelease is already published with exactly the expected four assets but only the rolling feeds failed, dispatch `Refresh Electron update feed` with `release_tag=vX.Y.Z`. It rebuilds signed metadata from immutable published assets and replaces only `macos-arm64.xml` and `windows-x64.json` on the managed feed release.

Never use feed refresh to repair missing or altered versioned assets. Never use release resume for an older/non-latest semantic-release commit or a published non-draft release.

## Verify

Monitor every required job to completion. Then verify, as applicable:

- the versioned release is a published prerelease with exactly the expected macOS DMG/ZIP and Windows Setup/`.nupkg` assets;
- the rolling `electron-update-feed` prerelease contains exactly `macos-arm64.xml` and `windows-x64.json` generated for the selected release;
- the feeds reference the selected immutable assets and their signatures/hashes validate through the workflow;
- a real installed `N -> N+1` update works on each affected platform when the incident or key change warrants it.

Report the workflow run URL, selected tag/SHA, job results, published asset/feed state, smoke evidence, and any remaining limitation. A green notification job alone is not recovery evidence.
