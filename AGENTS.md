# Ardor Desktop Agent Guidelines

## Repository Role

`ardor-desktop` owns the Electron shell around Ardor's web UI: the main process, sandboxed preload bridge, native browser and artifact surfaces, authentication callback, local persistence, packaging, and signed update flows. The React renderer remains in the sibling private `solutions-ui` repository.

This root `AGENTS.md` is the canonical repository-wide instruction file. Add a nested `AGENTS.md` only when a subtree needs genuinely narrower rules, and do not duplicate this baseline there. Keep permanent engineering policy here and conditional multi-step procedures in `.agents/skills/`.

## Start Here

- [`README.md`](README.md) — repository boundary, local layout, build, run, and distribution overview.
- [`docs/build-channels.md`](docs/build-channels.md) — stage1/prod isolation, packaging, release assets, updater trust, Auth0, and recovery paths.
- [`SECURITY.md`](SECURITY.md) — supported versions and private vulnerability reporting.
- [`VERSION.md`](VERSION.md) — Conventional Commit and semantic-release behavior.
- [`desktop-ui-requirements.json`](desktop-ui-requirements.json) — immutable `solutions-ui` revision and required renderer bridge capabilities used by release CI.
- [`env/solutions-ui-release-trigger.md`](env/solutions-ui-release-trigger.md) — compatibility pointer for the historical UI release-trigger instructions.

Use the repository skills when their workflows apply:

- [`update-solutions-ui-pin`](.agents/skills/update-solutions-ui-pin/SKILL.md) — update and verify the embedded `solutions-ui` revision or bridge capability contract.
- [`recover-electron-release`](.agents/skills/recover-electron-release/SKILL.md) — diagnose and, when explicitly authorized, resume a failed release or rebuild the rolling signed update feeds.

## Project Structure

```text
./
├── .github/workflows/             # CI, release, feed recovery, and PR-title enforcement
├── .agents/skills/                # Conditional agent workflows
├── assets/icons/{stage1,prod}/    # Channel-specific application and dock icons
├── docs/                          # Maintained build, release, updater, and environment documentation
├── electron/
│   ├── auth/                      # Auth0 authorization, callback, logout, CORS, and runtime config
│   ├── browser/                   # Browser/artifact surfaces, profiles, sessions, policy, and automation
│   ├── bridge-contract.ts         # Allowed IPC channels and shared main/preload data contracts
│   ├── main.ts                    # Electron main-process composition root and IPC handlers
│   ├── preload.ts                 # The only renderer-facing native bridge
│   ├── forge.config.mjs           # Packaging, makers, resources, identity, and signing configuration
│   └── fuse-config.mjs            # Hardened Electron fuse contract
├── env/                           # Channel environment templates and stage1 defaults
├── patches/                       # Bun patches for intentionally pinned dependencies
├── scripts/                       # Build, package, release, audit, and contract verification helpers
├── desktop-ui-requirements.json   # Pinned renderer revision and bridge requirements
├── package.json                   # Bun scripts and exact Electron/Forge toolchain
└── tsconfig.electron.json         # Strict Electron TypeScript boundary
```

## Development Commands

- `bun install` — install dependencies for local work.
- `bun run electron:dev` — build the main/preload bundles and start Electron. It loads `../solutions-ui/dist`; build that UI first when needed.
- `bun run ui:dev` — run the sibling `solutions-ui` development server with the stage1 desktop environment.
- `bun run electron:type-check` — type-check non-test Electron TypeScript.
- `bun test electron/auth/*.test.ts electron/browser/*.test.ts electron/updater.test.ts` — run the main Electron behavior suite.
- `bun run test:electron-shell-contract` — verify the renderer/native shell and Windows app-ID contract.
- `bun run test:electron-package` — verify packaging helpers and a packaged application when `ARDOR_ELECTRON_PACKAGE_DIR` is set.
- `bun run test:release-assets` — verify stage-build, release-asset, fuse, and workflow contracts.
- `bun run test:dependency-audit && bun run audit:dependencies` — test and run the dependency audit.
- `bun run verify:ui-contract` — verify the sibling `solutions-ui` bridge against the pinned desktop requirements.
- `bun run build:stage1` — create the normal local smoke package.
- `bun run build:prod` — create a production-channel package after configuring `env/prod.env` as documented.

Use `bun run build:windows:stage1` for a Windows x64 smoke installer. Do not substitute a prod build when stage1 is sufficient. Local development uses `bun install`; keep CI-only install flags in workflows unless the local workflow genuinely needs them.

## Ownership And Runtime Boundaries

- `electron/main.ts` owns privileged Electron APIs, native windows/views, protocol serving, auth callback state, update orchestration, persistence, and IPC registration.
- `electron/preload.ts` exposes only the frozen, typed `window.ardorDesktop` API. Never expose raw `ipcRenderer`, Node globals, filesystem primitives, shell execution, Electron objects, or a generic invoke function to the renderer.
- `electron/bridge-contract.ts` is the allowlist and shared contract between main and preload. A channel change must update the contract, main handler, preload surface, tests, `desktop-ui-requirements.json` when capability compatibility changes, and the matching `solutions-ui` types/consumer.
- `solutions-ui` owns renderer layout, state, and web fallbacks. Do not move React UI into this repository or Electron privilege into the UI merely to avoid a coordinated contract change.
- The packaged renderer is immutable static output selected by `ARDOR_SOLUTIONS_UI_DIR` locally and by `desktop-ui-requirements.json` in release CI. Validate the same output that is packaged.
- Keep `stage1` and `prod` identities, bundle IDs, endpoints, Auth0 clients, icons, and update behavior isolated. `stage1` is a build channel/environment, not a Git branch.

## Type And Data Model Rules

- Treat every IPC argument, runtime-config value, persisted file, URL, CDP result, environment variable, and GitHub workflow input as untrusted until parsed and bounded.
- Define stable bridge inputs, results, snapshots, and events in `electron/bridge-contract.ts`. Prefer discriminated unions and precise interfaces over magic strings, positional tuples, `any`, or unbounded dictionaries.
- Use `unknown` at an untrusted boundary, then narrow it with a dedicated parser or validator before invoking behavior. `Record<string, unknown>` is appropriate only while a payload is genuinely open-ended, such as an allowed CDP parameter/result, and must remain size- and method-bounded.
- Keep transport models separate from Electron runtime objects. Do not send `BrowserWindow`, `WebContents`, `Session`, errors, buffers, or class instances across IPC; return serializable data contracts.
- Keep allowlists and closed sets canonical. When adding a bridge channel, automation method, storage mode, presentation, or update event, update its single source of truth and exhaustive consumers rather than scattering string checks.
- Return defensive copies or immutable snapshots from stores and controllers so renderer or caller state cannot mutate privileged state by reference.
- Model units and limits in names or nearby constants: bytes, Unix seconds, coordinates, tab counts, timeouts, and version values must not be ambiguous.

## Persistent Data And Migration Rules

The desktop has user-owned persisted state even though it has no SQL database. `browser-profile.json`, encrypted `browser-pane-session.bin`, Chromium partitions, update caches, packaged runtime config, and the `desktop-ui-requirements.json` schema are data models with compatibility obligations.

- Give durable formats an explicit version when their shape can evolve. Parse old data defensively and distinguish absent, invalid, unsupported, and cryptographically locked state when behavior differs.
- Do not silently reinterpret an existing field. Prefer additive reads, write the new canonical form only after successful validation, and keep rollback/old-client coexistence in mind.
- For a format migration, test the previous valid payload, the new payload, malformed and oversized data, unsupported versions, partial fields, and write/read round trips. State whether downgrade is supported or data will be reset.
- Preserve atomic writes, restrictive permissions, encryption boundaries, bounds, and best-effort shutdown flushing. Never replace an encrypted file with plaintext or log its contents to debug a migration.
- Treat changes to `desktop-ui-requirements.json` as release-contract migrations. Keep `schemaVersion`, the immutable 40-character UI SHA, `bridgeGlobal`, and `requiredCapabilities` coherent with both repositories and release workflow snapshots.
- Keep one logical compatibility change per commit where practical. Coordinate destructive cleanup only after every supported released client can read the new form.

## Functions And Module Organization

Apply newspaper style: put the public behavior, primary flow, or executable entrypoint first; orchestration next; and lower-level parsing, normalization, and utility helpers afterward when JavaScript initialization and framework registration order allow it.

- Keep functions focused and typed. Prefer guard clauses so the successful path remains visible.
- Keep privileged side effects in main-process orchestration and isolate pure parsing/policy/model logic so it can be unit-tested without Electron.
- Group related options into typed objects instead of growing positional argument lists. Avoid positional booleans.
- Use named constants for protocols, channels, limits, timeouts, paths, and closed states. Comments explain why a constraint exists, not what the syntax says.
- Do not mechanically reorder a stable module solely to satisfy newspaper style; preserve initialization, event registration, and teardown semantics.

## Electron Security

- Preserve `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, disabled `webviewTag`, the custom `ardor://app` shell origin, and denied unexpected window creation/navigation.
- Every IPC handler must be registered through the typed allowlist and verify the sender is the trusted shell. Validate every argument again in the main process; preload typing is not a security boundary.
- Keep browser navigation public-HTTPS-or-loopback only, deny embedded credentials where the policy requires it, block private/link-local destinations, and keep external opening behind explicit URL validation and confirmation policy.
- Browser automation remains an allowlisted and size-bounded subset of CDP. Review any new method or parameter for arbitrary code execution, origin bypass, local-network access, credential extraction, filesystem access, and unbounded response risk.
- Treat page content, favicons, filenames, selected element data, downloads, auth callbacks, and updater metadata as attacker-controlled. Bound sizes, validate targets, normalize paths/URLs, and avoid HTML/string injection.
- Keep browser profiles and session manifests partitioned, encrypted where required, permission-restricted, and flushed before shutdown without blocking quit forever.
- Do not weaken Electron fuses, updater signature checks, target/size/hash/expiry validation, release provenance, key-finalization gates, or exact dependency pins without a threat-model review and packaged-binary verification.
- Never commit or print private update keys, Auth0 secrets, release-app keys, tokens, cookies, passwords, encrypted profile payloads, or customer browsing data. Public renderer environment values are not secrets, but still require correct channel isolation.

## Packaging, Releases, And Dependencies

- Bun is the repository package manager. Keep `bun.lock` synchronized with intentional `package.json` changes and preserve `patchedDependencies` unless the patch is deliberately replaced and reverified.
- Electron, Forge, fuses, Sparkle, signing, and maker versions are a coupled packaging surface. Review native rebuilds, exact pins, platform/architecture behavior, and packaged output—not only unit tests—when changing them.
- Production releases are semantic-release prereleases produced from `main`. PR titles and commits must follow [`VERSION.md`](VERSION.md).
- macOS and Windows installers are currently OS-unsigned, while update payload authenticity is enforced separately with Ardor-controlled Ed25519 keys. Do not describe ad-hoc signing or unsigned installers as equivalent to signed updater payloads.
- Release workflows, assets, rolling feeds, requirements snapshots, permissions, and recovery inputs are operational interfaces. Keep `cancel-in-progress: false` for release mutation and do not infer publication/recovery authorization from a request to inspect or prepare code.
- Do not hand-edit generated release artifacts under `dist/` or `out/`; change their source scripts/configuration and regenerate them.

## Testing And Verification

- Add focused unit tests beside the affected Electron or script module. Cover success, rejected input, bounds, platform/channel branches, persistence compatibility, and security decisions relevant to the change.
- For IPC changes, verify the shared channel contract, main handler authorization/validation, preload exposure, event unsubscribe behavior, and the corresponding `solutions-ui` consumer.
- For persistence changes, exercise previous and new payloads plus malformed, unavailable-encryption, locked, oversized, and flush/write-failure behavior as applicable.
- For package/update changes, run the relevant helper tests, type-check, dependency audit, fuse verification, and a real packaged-app smoke on every affected platform. A source-level test is not proof that a packaged native binary is correct.
- For workflow changes, run `bun run test:release-assets`, inspect permissions/conditions/concurrency and shell quoting, and use `actionlint` when available.
- Finish documentation-only changes with `git diff --check`. Report exact commands that could not run and why; do not claim platform, signing, release, or updater verification that was not performed.

## Semantic Code Notes

Put durable context at the smallest relevant code, test, configuration, or workflow location using `TAG: explanation` or `TAG(ARD-1234): explanation/removal condition`. An agent reading the affected implementation is much more likely to see it there than in an unrelated Markdown file.

- `TODO` — do later.
- `FIXME` — fix a known problem.
- `HACK` — temporary or non-ideal solution.
- `XXX` — dangerous or suspicious area.
- `NOTE` — important explanation.
- `BUG` — known bug.
- `OPTIMIZE` / `PERF` — optimization needed.
- `REFACTOR` — refactoring required.
- `REVIEW` — needs verification.
- `DEPRECATED` — obsolete code or API.
- `SECURITY` — security concern.
- `QUESTION` — open question.

Explain why the note exists and its impact. Include a removal condition for temporary notes. Prefer `TAG(ARD-1234): ...` for persistent actionable debt or risk, and remove or update notes when the condition changes. Do not bulk-rewrite existing comments solely for normalization or create a separate Markdown file for context that matters only beside one IPC channel, security decision, migration, workaround, or release condition.

## Agent Behavior

- Inspect current source, tests, scripts, workflow, and configuration before making a claim; release docs describe intent but do not prove current workflow or published state.
- Preserve useful documentation, diagrams, security constraints, and compatibility behavior. Move agent-only procedures only when the new canonical location is linked and no information is lost.
- Do not stop after one unsuccessful attempt. Diagnose the failure, try safe in-scope alternatives, and report the exact blocker only when you cannot proceed.
- Keep changes scoped to `ardor-desktop` unless coordinated `solutions-ui` work is explicitly requested. Identify the required cross-repository change without silently editing the sibling checkout.
- A request to inspect, document, or prepare does not authorize publishing a release, refreshing feeds, rotating keys, deleting user data, or changing GitHub secrets/variables.
- If an assumption would materially change a channel, public contract, user data, security boundary, release, signing state, or supported platform and cannot be resolved from source or read-only inspection, ask the user.
