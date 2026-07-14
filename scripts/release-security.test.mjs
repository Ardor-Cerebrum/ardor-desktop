import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const signingEnvironmentKeys = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_PRIVATE_KEY",
  "TAURI_PRIVATE_KEY_PATH",
  "TAURI_PRIVATE_KEY_PASSWORD",
];

test("the UI child process never inherits updater signing secrets", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "ardor-ui-env-"));
  const binDir = join(fixtureDir, "bin");
  const uiDir = join(fixtureDir, "solutions-ui");

  try {
    mkdirSync(binDir);
    mkdirSync(uiDir);
    writeFileSync(join(uiDir, "package.json"), "{}\n");

    const probePath = join(binDir, "bun");
    writeFileSync(
      probePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  command: process.argv.slice(2),
  cwd: process.cwd(),
  leakedSigningVariables: ${JSON.stringify(signingEnvironmentKeys)}.filter((key) => Boolean(process.env[key])),
}));
`,
    );
    chmodSync(probePath, 0o755);

    const stdout = execFileSync(
      process.execPath,
      [join(repoDir, "scripts/run-ui.mjs"), "stage1", "build"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ARDOR_SOLUTIONS_UI_DIR: uiDir,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          TAURI_SIGNING_PRIVATE_KEY: "regression-probe-private-key",
          TAURI_SIGNING_PRIVATE_KEY_PATH: "/regression/probe/signing-private-key",
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "regression-probe-password",
          TAURI_PRIVATE_KEY: "legacy-regression-probe-private-key",
          TAURI_PRIVATE_KEY_PATH: "/legacy/regression/probe/private-key",
          TAURI_PRIVATE_KEY_PASSWORD: "legacy-regression-probe-password",
          VITE_API_URL: "https://api.example.test",
          VITE_ARTIFACT_API_URL: "https://artifact.example.test",
          VITE_AUTH0_DOMAIN: "auth.example.test",
          VITE_AUTH0_CLIENT_ID: "test-client",
        },
      },
    );

    assert.deepEqual(JSON.parse(stdout), {
      command: ["run", "build:tauri"],
      cwd: realpathSync(uiDir),
      leakedSigningVariables: [],
    });
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test("the Tauri wrapper binds packaging to the configured UI directory", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "ardor-tauri-ui-path-"));
  const binDir = join(fixtureDir, "bin");
  const uiDir = join(fixtureDir, "solutions-ui-worktree");

  try {
    mkdirSync(binDir);
    mkdirSync(uiDir);
    mkdirSync(join(uiDir, "dist"));
    writeFileSync(join(uiDir, "dist/index.html"), "<!doctype html>\n");

    const probePath = join(binDir, "bunx");
    writeFileSync(
      probePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  command: process.argv.slice(2),
  solutionsUiDir: process.env.ARDOR_SOLUTIONS_UI_DIR,
}));
`,
    );
    chmodSync(probePath, 0o755);

    const stdout = execFileSync(
      process.execPath,
      [
        join(repoDir, "scripts/run-tauri.mjs"),
        "build",
        "stage1",
        "--bundles",
        "nsis",
        "--config",
        "src-tauri/tauri.updater-artifacts.conf.json",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          ARDOR_SOLUTIONS_UI_DIR: relative(repoDir, uiDir),
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    const { command, solutionsUiDir } = JSON.parse(stdout);
    assert.equal(solutionsUiDir, uiDir);
    assert.deepEqual(command.slice(0, 5), [
      "--bun",
      "@tauri-apps/cli@2.11.2",
      "build",
      "--config",
      "src-tauri/tauri.stage1.conf.json",
    ]);
    assert.deepEqual(command.slice(5, 9), [
      "--bundles",
      "nsis",
      "--config",
      "src-tauri/tauri.updater-artifacts.conf.json",
    ]);

    const frontendOverlay = JSON.parse(command.at(-1));
    const expectedFrontendDist = relative(join(repoDir, "src-tauri"), join(uiDir, "dist"))
      .split(sep)
      .join("/");
    assert.equal(command.at(-2), "--config");
    assert.deepEqual(frontendOverlay, {
      build: {
        frontendDist: expectedFrontendDist,
      },
    });
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test("release workflow keeps frontend, signer, and publisher authority separate", () => {
  const workflow = readFileSync(join(repoDir, ".github/workflows/release.yml"), "utf8");
  const workflowTriggers = workflow.slice(0, workflow.indexOf("permissions:"));
  const releaseJob = readJob(workflow, "release");
  const uiJob = readJob(workflow, "build-release-ui");
  const buildJob = readJob(workflow, "build-release-assets");
  const signerJob = readJob(workflow, "sign-update-manifests");
  const publisherJob = readJob(workflow, "upload-release-assets");

  assert.doesNotMatch(workflow, /stage1|Ardor-Dev|latest-stage1/);
  assert.match(workflowTriggers, /push:\s*\n\s+branches: \[main\]/);
  assert.match(workflowTriggers, /workflow_dispatch:/);
  assert.match(
    releaseJob,
    /if: github\.event_name == 'workflow_dispatch' \|\| !startsWith\(github\.event\.head_commit\.message, 'chore\(release\):'\)/,
  );
  assert.match(
    releaseJob,
    /if: github\.event_name != 'workflow_dispatch' \|\| inputs\.noop != true/,
  );

  const releaseSteps = readSteps(releaseJob);
  const desktopTokenStep = releaseSteps.find((step) => step.includes("id: desktop-release-app-token"));
  const uiTokenStep = releaseSteps.find((step) => step.includes("id: solutions-ui-app-token"));
  assert.ok(desktopTokenStep, "release job must mint a desktop-only write token");
  assert.match(desktopTokenStep, /repositories: ardor-desktop/);
  assert.match(desktopTokenStep, /permission-contents: write/);
  assert.doesNotMatch(desktopTokenStep, /solutions-ui/);
  assert.ok(uiTokenStep, "release job must mint a solutions-ui read token");
  assert.match(uiTokenStep, /repositories: solutions-ui/);
  assert.match(uiTokenStep, /permission-contents: read/);
  assert.doesNotMatch(uiTokenStep, /repositories: ardor-desktop/);

  const secretSteps = readSteps(buildJob).filter((candidate) =>
    candidate.includes("TAURI_SIGNING_PRIVATE_KEY:"),
  );
  assert.ok(secretSteps.length > 0, "build job must sign updater artifacts");
  for (const step of secretSteps) {
    assert.match(step, /bun run tauri:build:prod/);
    assert.match(step, /tauri\.updater-artifacts\.conf\.json/);
    assert.doesNotMatch(step, /bun run (?:ui:|build:(?:stage1|prod))/);
    assert.doesNotMatch(step, /VITE_[A-Z0-9_]+:/);
  }

  const macBuildStep = secretSteps.find((step) => step.includes("matrix.platform == 'macos'"));
  assert.ok(macBuildStep, "release workflow must contain a macOS signing step");
  assert.match(macBuildStep, /APPLE_SIGNING_IDENTITY: "-"/);
  assert.match(
    buildJob,
    /codesign --verify --deep --strict --verbose=2 src-tauri\/target\/release\/bundle\/macos\/Ardor\.app/,
  );

  assert.doesNotMatch(uiJob, /TAURI_(?:SIGNING_)?PRIVATE_KEY/);
  assert.doesNotMatch(releaseJob, /DESKTOP_SOLUTIONS_UI_REF/);
  assert.match(
    releaseJob,
    /pinned_ref="\$\(node -p .*desktop-ui-requirements\.json.*solutionsUiRef.*\)"/,
  );
  assert.match(
    releaseJob,
    /gh api "repos\/Ardor-Cerebrum\/solutions-ui\/commits\/\$\{pinned_ref\}" --jq \.sha/,
  );
  assert.match(releaseJob, /if \[ "\$resolved_sha" != "\$pinned_ref" \]/);
  assert.match(releaseJob, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(releaseJob, /path: solutions-ui-preflight/);
  assert.match(releaseJob, /node scripts\/verify-desktop-ui-contract\.mjs\s+solutions-ui-preflight/);
  assert.match(releaseJob, /working-directory: solutions-ui-preflight\s+run: bun install --frozen-lockfile/);
  assert.match(releaseJob, /name: Test preflight desktop auth callback boundary/);
  assert.match(releaseJob, /name: Remove preflight checkout\s+run: rm -rf -- solutions-ui-preflight/);
  assert.ok(
    releaseJob.indexOf("Verify desktop UI compatibility before release") < releaseJob.indexOf("Semantic Release"),
    "the desktop/UI contract gate must run before semantic-release publishes a tag",
  );
  assert.ok(
    releaseJob.indexOf("Test preflight desktop auth callback boundary") < releaseJob.indexOf("Semantic Release"),
    "the mounted callback boundary test must run before semantic-release publishes a tag",
  );
  assert.match(uiJob, /SOLUTIONS_UI_REF: \$\{\{ needs\.release\.outputs\.solutions_ui_ref \}\}/);
  assert.match(uiJob, /ref: \$\{\{ env\.SOLUTIONS_UI_REF \}\}/);
  assert.match(
    uiJob,
    /node ardor-desktop\/scripts\/verify-desktop-ui-contract\.mjs solutions-ui/,
  );
  assert.ok(
    uiJob.indexOf("Verify desktop UI compatibility") < uiJob.indexOf("Install UI dependencies"),
    "the desktop/UI contract gate must run before installing UI dependencies",
  );
  assert.match(uiJob, /src\/lib\/auth0-desktop-callback-bridge\.test\.tsx/);
  assert.match(uiJob, /src\/lib\/auth0-desktop-marker-recovery\.integration\.test\.tsx/);
  assert.match(uiJob, /src\/app\.test\.tsx/);
  assert.match(uiJob, /name: release-ui-prod/);
  assert.match(uiJob, /path: solutions-ui\/dist/);
  const uiCheckouts = readSteps(uiJob).filter((step) => step.includes("actions/checkout@"));
  assert.ok(uiCheckouts.length >= 2, "UI job must checkout both repositories");
  for (const checkout of uiCheckouts) {
    assert.match(checkout, /persist-credentials: false/);
  }

  const buildCheckouts = readSteps(buildJob).filter((step) => step.includes("actions/checkout@"));
  assert.equal(buildCheckouts.length, 1, "native build job must checkout only the desktop repository");
  assert.match(buildCheckouts[0], /persist-credentials: false/);
  assert.match(buildJob, /actions\/download-artifact@[0-9a-f]{40}\b/);
  assert.match(buildJob, /name: release-ui-prod/);
  assert.match(buildJob, /path: solutions-ui\/dist/);
  assert.doesNotMatch(
    buildJob,
    /repository: Ardor-Cerebrum\/solutions-ui|SOLUTIONS_UI_REF|bun run ui:|VITE_[A-Z0-9_]+:/,
  );

  assert.match(signerJob, /generate-update-manifest\.mjs prepare/);
  assert.match(signerJob, /generate-update-manifest\.mjs finalize/);
  assert.match(signerJob, /TAURI_SIGNING_PRIVATE_KEY:/);
  assert.match(signerJob, /signed-update-manifests/);
  assert.doesNotMatch(signerJob, /create-github-app-token|GH_TOKEN:|gh release (?:upload|edit)/);

  assert.match(publisherJob, /signed-update-manifests/);
  assert.doesNotMatch(publisherJob, /TAURI_SIGNING_PRIVATE_KEY|generate-update-manifest|actions\/checkout@/);
});

test("released UI sync opens a scoped, auditable pin update PR", () => {
  const workflow = readFileSync(join(repoDir, ".github/workflows/sync-solutions-ui.yml"), "utf8");
  const workflowTriggers = workflow.slice(0, workflow.indexOf("permissions:"));
  const updateJob = readJob(workflow, "update-pin");
  const steps = readSteps(updateJob);
  const desktopTokenStep = steps.find((step) => step.includes("id: desktop-app-token"));
  const uiTokenStep = steps.find((step) => step.includes("id: solutions-ui-app-token"));

  assert.match(workflowTriggers, /repository_dispatch:\s*\n\s+types: \[solutions-ui-released\]/);
  assert.match(workflowTriggers, /workflow_dispatch:/);
  assert.ok(desktopTokenStep, "sync workflow must mint a desktop write token");
  assert.match(desktopTokenStep, /repositories: ardor-desktop/);
  assert.match(desktopTokenStep, /permission-contents: write/);
  assert.match(desktopTokenStep, /permission-pull-requests: write/);
  assert.doesNotMatch(desktopTokenStep, /repositories: solutions-ui/);
  assert.ok(uiTokenStep, "sync workflow must mint a solutions-ui read token");
  assert.match(uiTokenStep, /repositories: solutions-ui/);
  assert.match(uiTokenStep, /permission-contents: read/);
  assert.doesNotMatch(uiTokenStep, /repositories: ardor-desktop/);
  assert.match(updateJob, /ref: main/);
  assert.match(updateJob, /gh api "repos\/Ardor-Cerebrum\/solutions-ui\/commits\/\$\{UI_TAG\}" --jq \.sha/);
  assert.match(updateJob, /if \[ "\$resolved_sha" != "\$UI_SHA" \]/);
  assert.match(updateJob, /if \[ "\$pinned_sha" = "\$UI_SHA" \]/);
  assert.match(updateJob, /gh pr list .*--state open --head "\$branch"/);
  assert.match(updateJob, /git add desktop-ui-requirements\.json/);
  assert.match(updateJob, /git push --set-upstream origin/);
  assert.doesNotMatch(updateJob, /git push[^\n]*\bmain\b/);
  assert.match(updateJob, /gh pr create/);
  assert.match(updateJob, /--base main/);
});

test("bundled UI PR check validates the pinned contract and production desktop build", () => {
  const workflow = readFileSync(join(repoDir, ".github/workflows/bundled-ui.yml"), "utf8");
  const workflowTriggers = workflow.slice(0, workflow.indexOf("permissions:"));
  const verifyJob = readJob(workflow, "verify");

  assert.match(workflowTriggers, /pull_request:/);
  assert.match(workflowTriggers, /desktop-ui-requirements\.json/);
  assert.match(verifyJob, /repositories: solutions-ui/);
  assert.match(verifyJob, /permission-contents: read/);
  assert.match(verifyJob, /ref: \$\{\{ steps\.solutions-ui-ref\.outputs\.sha \}\}/);
  assert.match(verifyJob, /node scripts\/verify-desktop-ui-contract\.mjs solutions-ui/);
  assert.match(verifyJob, /runs-on: macos-26/);
  assert.match(verifyJob, /name: Build production desktop bundle/);
  assert.match(verifyJob, /APPLE_SIGNING_IDENTITY: "-"/);
  assert.match(verifyJob, /bun run build:prod/);
});

test("GitHub Actions dependencies are pinned to immutable commits", () => {
  for (const workflowName of [
    "bundled-ui.yml",
    "ci.yml",
    "pr-title.yml",
    "release.yml",
    "sync-solutions-ui.yml",
  ]) {
    const workflow = readFileSync(join(repoDir, ".github/workflows", workflowName), "utf8");
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s+[^\s@]+@([^\s#]+)/gm)];

    assert.ok(actionReferences.length > 0, `${workflowName} must use at least one action`);
    for (const [, actionRef] of actionReferences) {
      assert.match(actionRef, /^[0-9a-f]{40}$/, `${workflowName} contains a mutable action ref`);
    }
  }
});

test("desktop releases pin the compatible UI callback protocol", () => {
  const requirements = JSON.parse(
    readFileSync(join(repoDir, "desktop-ui-requirements.json"), "utf8"),
  );

  assert.deepEqual(requirements, {
    schemaVersion: 1,
    solutionsUiRef: "61cf17834cbfb44b18aea797fe11e9566e4caf36",
    requirements: {
      desktopAuthCallback: {
        protocolVersion: 1,
        event: "desktop-auth-callback-ready",
        commands: {
          getPendingAuthCallback: "get_pending_auth_callback",
          completeAuthCallback: "complete_auth_callback",
        },
        payloads: {
          getPendingAuthCallbackResult: {
            nullable: true,
            fields: {
              id: "number",
              callbackUrl: "string",
            },
          },
          completeAuthCallbackArguments: {
            callbackId: "number",
          },
          completeAuthCallbackResult: "boolean",
        },
        lifecycle: {
          delivery: "retained-until-acknowledged-or-expired",
          readyEvent: "wake-up-only",
          acknowledgeAfter: "auth0-code-exchange-attempt-or-authenticated-reconciliation",
          expiresAfterSeconds: 600,
          expiryPhase: "expired",
        },
      },
    },
  });
});

test("release trust-boundary files have redundant code owners", () => {
  const codeowners = readFileSync(join(repoDir, ".github/CODEOWNERS"), "utf8");
  const rules = codeowners
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.match(rule, /(?:^|\s)@constantinef(?:\s|$)/);
    assert.match(rule, /(?:^|\s)@mandrianova(?:\s|$)/);
  }
  assert.ok(rules.some((rule) => rule.startsWith("/.github/ ")));
});

test("the updater artifact overlay disables nested frontend builds", () => {
  const overlay = JSON.parse(
    readFileSync(join(repoDir, "src-tauri/tauri.updater-artifacts.conf.json"), "utf8"),
  );
  assert.equal(overlay.build?.beforeBuildCommand, "");
  assert.equal(overlay.bundle?.createUpdaterArtifacts, true);
});

test("the updater config contains a canonical minisign public key", () => {
  const config = JSON.parse(readFileSync(join(repoDir, "src-tauri/tauri.conf.json"), "utf8"));
  const encodedPublicKey = config.plugins?.updater?.pubkey;

  assert.equal(typeof encodedPublicKey, "string");
  const publicKey = Buffer.from(encodedPublicKey, "base64").toString("utf8");
  assert.match(
    publicKey,
    /^untrusted comment: minisign public key: [0-9A-F]{16}\nRW[A-Za-z0-9+/]+={0,2}\n$/,
  );
  assert.equal(Buffer.from(publicKey).toString("base64"), encodedPublicKey);
});

test("WebView capabilities cannot invoke the updater plugin directly", () => {
  const capabilities = JSON.parse(
    readFileSync(join(repoDir, "src-tauri/capabilities/default.json"), "utf8"),
  );
  assert.ok(capabilities.permissions.includes("process:allow-restart"));
  assert.ok(capabilities.permissions.every((permission) => !permission.startsWith("updater:")));
});

test("native updater requests have finite check and download timeouts", () => {
  const nativeSource = readFileSync(join(repoDir, "src-tauri/src/lib.rs"), "utf8");
  assert.match(
    nativeSource,
    /\.updater_builder\(\)\s*\.timeout\(UPDATE_CHECK_TIMEOUT\)\s*\.build\(\)/,
  );
  assert.match(nativeSource, /update\.timeout = Some\(UPDATE_DOWNLOAD_TIMEOUT\)/);
});

function readJob(workflow, jobName) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `workflow job ${jobName} is missing`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function readSteps(job) {
  return job.split(/(?=^      - name: )/m).slice(1);
}
