import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "generate-update-manifest.mjs");
const tag = "v1.2.3";
const repository = "example/ardor-desktop";
const pubDate = "2026-07-10T00:00:00.000Z";
const channels = [
  {
    bundleId: "cloud.ardor.desktop",
    channel: "prod",
    manifest: "latest.json",
    metadataSignature: "prod-metadata-signature",
    payload: "latest.payload.json",
    prefix: "Ardor",
    signature: "prod-artifact-signature",
  },
  {
    bundleId: "cloud.ardor.desktop.stage1",
    channel: "stage1",
    manifest: "latest-stage1.json",
    metadataSignature: "stage1-metadata-signature",
    payload: "latest-stage1.payload.json",
    prefix: "Ardor-Dev",
    signature: "stage1-artifact-signature",
  },
];

function createSignedAssets(assetsDir) {
  for (const { prefix, signature } of channels) {
    for (const asset of [
      `${prefix}-${tag}-macos-aarch64.app.tar.gz`,
      `${prefix}-${tag}-windows-x64-setup.exe`,
    ]) {
      writeFileSync(join(assetsDir, asset), "artifact");
      writeFileSync(join(assetsDir, `${asset}.sig`), `${signature}\n`);
    }
  }
}

function runGenerator(mode, assetsDir) {
  return spawnSync(process.execPath, [script, mode], {
    cwd: dirname(assetsDir),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      RELEASE_PUB_DATE: pubDate,
      RELEASE_TAG: tag,
    },
  });
}

function prepareAndAddMetadataSignatures(assetsDir) {
  const prepare = runGenerator("prepare", assetsDir);
  assert.equal(prepare.status, 0, prepare.stderr);

  for (const { metadataSignature, payload } of channels) {
    writeFileSync(join(assetsDir, `${payload}.sig`), `${metadataSignature}\n`);
  }
}

function withTemporaryAssets(callback) {
  const rootDir = mkdtempSync(join(tmpdir(), "ardor-updater-manifest-"));
  const assetsDir = join(rootDir, "release-assets");
  mkdirSync(assetsDir);

  try {
    return callback(assetsDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("rejects a caller-provided assets directory", () => {
  const result = spawnSync(process.execPath, [script, "prepare", "outside-release-assets"], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: generate-update-manifest\.mjs <prepare\|finalize>/);
});

test("builds canonical signed payloads and Tauri-compatible manifests", () => {
  withTemporaryAssets((assetsDir) => {
    createSignedAssets(assetsDir);
    prepareAndAddMetadataSignatures(assetsDir);

    const finalize = runGenerator("finalize", assetsDir);
    assert.equal(finalize.status, 0, finalize.stderr);

    for (const {
      bundleId,
      channel,
      manifest,
      metadataSignature,
      payload,
      prefix,
      signature,
    } of channels) {
      const payloadText = readFileSync(join(assetsDir, payload), "utf8");
      const signed = JSON.parse(payloadText);
      const body = JSON.parse(readFileSync(join(assetsDir, manifest), "utf8"));
      const releaseUrl = `https://github.com/${repository}/releases/download/${tag}`;

      assert.equal(payloadText, JSON.stringify(signed));
      assert.deepEqual(signed, {
        schema: 1,
        channel,
        bundleId,
        version: "1.2.3",
        pubDate,
        platforms: {
          "darwin-aarch64": {
            signature,
            url: `${releaseUrl}/${prefix}-${tag}-macos-aarch64.app.tar.gz`,
          },
          "windows-x86_64": {
            signature,
            url: `${releaseUrl}/${prefix}-${tag}-windows-x64-setup.exe`,
          },
        },
      });
      assert.equal(body.ardor.payload, payloadText);
      assert.equal(body.ardor.signature, metadataSignature);
      assert.equal(body.version, signed.version);
      assert.equal(body.pub_date, signed.pubDate);
      assert.deepEqual(body.platforms, signed.platforms);
    }
  });
});

test("prepare fails when an updater artifact or artifact signature is missing", () => {
  withTemporaryAssets((assetsDir) => {
    createSignedAssets(assetsDir);
    rmSync(join(assetsDir, `Ardor-${tag}-macos-aarch64.app.tar.gz`));

    const missingAsset = runGenerator("prepare", assetsDir);
    assert.notEqual(missingAsset.status, 0);
    assert.match(missingAsset.stderr, /Missing updater asset for darwin-aarch64/);
  });

  withTemporaryAssets((assetsDir) => {
    createSignedAssets(assetsDir);
    rmSync(join(assetsDir, `Ardor-${tag}-macos-aarch64.app.tar.gz.sig`));

    const missingSignature = runGenerator("prepare", assetsDir);
    assert.notEqual(missingSignature.status, 0);
    assert.match(missingSignature.stderr, /Missing updater signature for darwin-aarch64/);
  });

  withTemporaryAssets((assetsDir) => {
    createSignedAssets(assetsDir);
    writeFileSync(join(assetsDir, `Ardor-${tag}-macos-aarch64.app.tar.gz.sig`), "\n");

    const emptySignature = runGenerator("prepare", assetsDir);
    assert.notEqual(emptySignature.status, 0);
    assert.match(emptySignature.stderr, /Empty updater signature for darwin-aarch64/);
  });
});

test("finalize fails without a metadata signature", () => {
  withTemporaryAssets((assetsDir) => {
    createSignedAssets(assetsDir);
    const prepare = runGenerator("prepare", assetsDir);
    assert.equal(prepare.status, 0, prepare.stderr);

    const finalize = runGenerator("finalize", assetsDir);
    assert.notEqual(finalize.status, 0);
    assert.match(finalize.stderr, /Missing update metadata signature/);
  });

  withTemporaryAssets((assetsDir) => {
    createSignedAssets(assetsDir);
    prepareAndAddMetadataSignatures(assetsDir);
    writeFileSync(join(assetsDir, "latest.payload.json.sig"), "\n");

    const finalize = runGenerator("finalize", assetsDir);
    assert.notEqual(finalize.status, 0);
    assert.match(finalize.stderr, /Empty update metadata signature/);
  });
});

test("finalize rejects a payload whose channel identity was changed", () => {
  withTemporaryAssets((assetsDir) => {
    createSignedAssets(assetsDir);
    prepareAndAddMetadataSignatures(assetsDir);
    const payloadPath = join(assetsDir, "latest.payload.json");
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    payload.channel = "stage1";
    writeFileSync(payloadPath, JSON.stringify(payload));

    const finalize = runGenerator("finalize", assetsDir);
    assert.notEqual(finalize.status, 0);
    assert.match(finalize.stderr, /Update metadata identity does not match prod/);
  });
});
