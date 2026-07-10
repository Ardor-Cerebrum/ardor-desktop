import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , mode = "prepare", assetsDir = "release-assets"] = process.argv;

if (mode !== "prepare" && mode !== "finalize") {
  throw new Error("Usage: generate-update-manifest.mjs <prepare|finalize> [assetsDir]");
}

const channels = [
  {
    bundleId: "cloud.ardor.desktop",
    channel: "prod",
    manifest: "latest.json",
    payload: "latest.payload.json",
    prefix: "Ardor",
  },
  {
    bundleId: "cloud.ardor.desktop.stage1",
    channel: "stage1",
    manifest: "latest-stage1.json",
    payload: "latest-stage1.payload.json",
    prefix: "Ardor-Dev",
  },
];

if (mode === "prepare") {
  preparePayloads();
} else {
  finalizeManifests();
}

function preparePayloads() {
  const tag = process.env.RELEASE_TAG;
  if (!tag) {
    throw new Error("RELEASE_TAG is not set");
  }

  const repository = process.env.GITHUB_REPOSITORY ?? "Ardor-Cerebrum/ardor-desktop";
  const version = tag.replace(/^v/, "");
  const pubDate = process.env.RELEASE_PUB_DATE ?? new Date().toISOString();
  const releaseUrl = `https://github.com/${repository}/releases/download/${tag}`;

  for (const { bundleId, channel, payload, prefix } of channels) {
    const assets = {
      "darwin-aarch64": `${prefix}-${tag}-macos-aarch64.app.tar.gz`,
      "windows-x86_64": `${prefix}-${tag}-windows-x64-setup.exe`,
    };

    const platforms = {};
    for (const [platform, asset] of Object.entries(assets)) {
      const assetPath = join(assetsDir, asset);
      const signaturePath = `${assetPath}.sig`;

      if (!existsSync(assetPath)) {
        throw new Error(`Missing updater asset for ${platform}: ${asset}`);
      }

      platforms[platform] = {
        signature: readRequiredSignature(
          signaturePath,
          `updater signature for ${platform}: ${asset}.sig`,
        ),
        url: `${releaseUrl}/${asset}`,
      };
    }

    const payloadPath = join(assetsDir, payload);
    writeFileSync(
      payloadPath,
      JSON.stringify({
        schema: 1,
        channel,
        bundleId,
        version,
        pubDate,
        platforms,
      }),
    );
    console.log(`Wrote ${payloadPath}`);
  }
}

function finalizeManifests() {
  for (const { bundleId, channel, manifest, payload } of channels) {
    const payloadPath = join(assetsDir, payload);
    const signaturePath = `${payloadPath}.sig`;

    if (!existsSync(payloadPath)) {
      throw new Error(`Missing signed update metadata payload: ${payload}`);
    }
    const metadataSignature = readRequiredSignature(
      signaturePath,
      `update metadata signature: ${payload}.sig`,
    );

    const payloadText = readFileSync(payloadPath, "utf8");
    const signed = JSON.parse(payloadText);
    if (payloadText !== JSON.stringify(signed)) {
      throw new Error(`Update metadata payload is not canonical compact JSON: ${payload}`);
    }
    if (signed.schema !== 1 || signed.channel !== channel || signed.bundleId !== bundleId) {
      throw new Error(`Update metadata identity does not match ${channel}: ${payload}`);
    }
    if (
      typeof signed.version !== "string" ||
      typeof signed.pubDate !== "string" ||
      !signed.platforms ||
      typeof signed.platforms !== "object"
    ) {
      throw new Error(`Update metadata payload is incomplete: ${payload}`);
    }

    const manifestPath = join(assetsDir, manifest);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          version: signed.version,
          pub_date: signed.pubDate,
          platforms: signed.platforms,
          ardor: {
            payload: payloadText,
            signature: metadataSignature,
          },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Wrote ${manifestPath}`);
  }
}

function readRequiredSignature(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}`);
  }

  const signature = readFileSync(path, "utf8").trim();
  if (!signature) {
    throw new Error(`Empty ${label}`);
  }

  return signature;
}
