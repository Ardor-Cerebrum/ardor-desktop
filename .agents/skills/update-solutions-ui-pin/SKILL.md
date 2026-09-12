---
name: update-solutions-ui-pin
description: Update Ardor Desktop's immutable solutions-ui revision or renderer bridge capability contract and verify the two repositories remain release-compatible.
---

# Update the solutions-ui pin

Use this workflow when the automated release-pin PR needs investigation or recovery, or when `window.ardorDesktop` capabilities change.

A published semantic `solutions-ui` release dispatches its tag and immutable commit SHA to this repository. [`.github/workflows/sync-solutions-ui.yml`](../../../.github/workflows/sync-solutions-ui.yml) validates that release and creates or refreshes the single `automation/solutions-ui-release` PR. Duplicate and older releases are no-ops. The PR is always reviewed and merged through the normal branch protection flow; the automation does not merge it or publish a desktop release.

## Establish the target

1. Read [`desktop-ui-requirements.json`](../../../desktop-ui-requirements.json), [`README.md`](../../../README.md), and the renderer/native boundary in [`docs/build-channels.md`](../../../docs/build-channels.md#renderernative-boundary).
2. Inspect the target published semantic `solutions-ui` release and confirm its tag resolves to the intended immutable 40-character SHA contained in that repository's `main`. Do not pin a mutable branch name, an unreviewed worktree commit, or a SHA supplied without provenance.
3. Determine whether this is only a renderer revision update or also a bridge contract change. Bridge changes require coordinated edits to `electron/bridge-contract.ts`, the main handler, `electron/preload.ts`, tests, `requiredCapabilities`, and the `solutions-ui` bridge/types/consumer.

## Update

- Change `solutionsUiTag` to the published semantic release tag and `solutionsUiRef` to the exact commit SHA resolved from that tag.
- Keep `schemaVersion`, `bridgeGlobal`, and `requiredCapabilities` unchanged for a UI-only pin update.
- Change `requiredCapabilities` only when the actual top-level preload capability contract changes; do not use it as a feature wishlist.
- Use a focused Conventional Commit. Existing UI-only release pins use `fix(release): bundle solutions-ui vX.Y.Z` when a UI version is known.

For recovery, run **Sync released solutions-ui** manually with the published tag and optional expected SHA. Leaving both inputs blank reconciles the latest published release. The six-hour schedule provides the same recovery path if the source dispatch is missed.

## Verify

With the intended `solutions-ui` checkout next to this repository, run:

```bash
bun install
node scripts/verify-desktop-ui-contract.mjs
bun run test:ui-contract
bun run test:electron-shell-contract
bun run electron:type-check
```

Run relevant `solutions-ui` type checks/tests when its bridge code changed. For a release-bound change, also build the appropriate stage package and confirm it embeds the expected renderer output. Report the desktop SHA, pinned UI SHA, contract checks, and any cross-repository check that could not run.

Do not publish a desktop release merely because the pin was updated; merging the reviewed PR only starts the repository's existing release policy.
