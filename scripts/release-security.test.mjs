import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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

    const probePath = join(binDir, "bun");
    writeFileSync(
      probePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  command: process.argv.slice(2),
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
      leakedSigningVariables: [],
    });
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test("release workflow keeps frontend, signer, and publisher authority separate", () => {
  const workflow = readFileSync(join(repoDir, ".github/workflows/release.yml"), "utf8");
  const uiJob = readJob(workflow, "build-release-ui");
  const buildJob = readJob(workflow, "build-release-assets");
  const signerJob = readJob(workflow, "sign-update-manifests");
  const publisherJob = readJob(workflow, "upload-release-assets");

  const secretSteps = readSteps(buildJob).filter((candidate) =>
    candidate.includes("TAURI_SIGNING_PRIVATE_KEY:"),
  );
  assert.ok(secretSteps.length > 0, "build job must sign updater artifacts");
  for (const step of secretSteps) {
    assert.match(step, /bun run tauri:build:(?:stage1|prod)/);
    assert.match(step, /tauri\.updater-artifacts\.conf\.json/);
    assert.doesNotMatch(step, /bun run (?:ui:|build:(?:stage1|prod))/);
    assert.doesNotMatch(step, /VITE_[A-Z0-9_]+:/);
  }

  assert.doesNotMatch(uiJob, /TAURI_(?:SIGNING_)?PRIVATE_KEY/);
  assert.match(uiJob, /name: release-ui-\$\{\{ matrix\.channel \}\}/);
  const uiCheckouts = readSteps(uiJob).filter((step) => step.includes("actions/checkout@"));
  assert.ok(uiCheckouts.length >= 2, "UI job must checkout both repositories");
  for (const checkout of uiCheckouts) {
    assert.match(checkout, /persist-credentials: false/);
  }

  const buildCheckouts = readSteps(buildJob).filter((step) => step.includes("actions/checkout@"));
  assert.equal(buildCheckouts.length, 1, "native build job must checkout only the desktop repository");
  assert.match(buildCheckouts[0], /persist-credentials: false/);
  assert.match(buildJob, /actions\/download-artifact@v4/);
  assert.match(buildJob, /name: release-ui-\$\{\{ matrix\.channel \}\}/);
  assert.doesNotMatch(buildJob, /repository: Ardor-Cerebrum\/solutions-ui|bun run ui:|VITE_[A-Z0-9_]+:/);

  assert.match(signerJob, /generate-update-manifest\.mjs prepare/);
  assert.match(signerJob, /generate-update-manifest\.mjs finalize/);
  assert.match(signerJob, /TAURI_SIGNING_PRIVATE_KEY:/);
  assert.match(signerJob, /signed-update-manifests/);
  assert.doesNotMatch(signerJob, /create-github-app-token|GH_TOKEN:|gh release (?:upload|edit)/);

  assert.match(publisherJob, /signed-update-manifests/);
  assert.doesNotMatch(publisherJob, /TAURI_SIGNING_PRIVATE_KEY|generate-update-manifest|actions\/checkout@/);
});

test("the updater artifact overlay disables nested frontend builds", () => {
  const overlay = JSON.parse(
    readFileSync(join(repoDir, "src-tauri/tauri.updater-artifacts.conf.json"), "utf8"),
  );
  assert.equal(overlay.build?.beforeBuildCommand, "");
  assert.equal(overlay.bundle?.createUpdaterArtifacts, true);
});

test("WebView capabilities cannot invoke the updater plugin directly", () => {
  const capabilities = JSON.parse(
    readFileSync(join(repoDir, "src-tauri/capabilities/default.json"), "utf8"),
  );
  assert.ok(capabilities.permissions.includes("process:allow-restart"));
  assert.ok(capabilities.permissions.every((permission) => !permission.startsWith("updater:")));
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
