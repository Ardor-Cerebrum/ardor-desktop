import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(repoDir, "scripts/verify-desktop-ui-contract.mjs");

const compatibleContract = {
  schemaVersion: 1,
  capabilities: {
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
};

test("accepts a compatible solutions-ui desktop shell contract", () => {
  withUiFixture(JSON.stringify(compatibleContract), (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified solutions-ui desktop shell contract/);
  });
});

test("rejects a missing solutions-ui desktop shell contract", () => {
  withUiFixture(undefined, (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy source verification is allowed only for emergency ref/);
  });
});

test("accepts the manifest-less emergency pin after verifying its source contract", () => {
  withLegacyUiFixture((uiDir) => {
    const result = runVerifier(uiDir, "67b70c55573094e76c9913498c0e92c291eeaec5");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified legacy pinned solutions-ui source contract/);
  });
});

test("rejects a manifest-less override even when compatible source is present", () => {
  withLegacyUiFixture((uiDir) => {
    const result = runVerifier(uiDir, "1111111111111111111111111111111111111111");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy source verification is allowed only for emergency ref/);
  });
});

test("does not move the manifest-less exception when the configured pin changes", () => {
  withLegacyUiFixture((uiDir) => {
    const fixtureDir = dirname(uiDir);
    const requirementsPath = join(fixtureDir, "desktop-ui-requirements.json");
    const requirements = JSON.parse(readFileSync(join(repoDir, "desktop-ui-requirements.json"), "utf8"));
    requirements.solutionsUiRef = "1111111111111111111111111111111111111111";
    writeFileSync(requirementsPath, `${JSON.stringify(requirements)}\n`);

    const result = runVerifier(uiDir, requirements.solutionsUiRef, requirementsPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy source verification is allowed only for emergency ref/);
  });
});

test("rejects the emergency pin when a required command is missing", () => {
  withLegacyUiFixture((uiDir) => {
    writeFileSync(
      join(uiDir, "src/lib/auth0-desktop-callback-bridge.tsx"),
      "const event = 'desktop-auth-callback-ready';\nconst command = 'get_pending_auth_callback';\n",
    );
    const result = runVerifier(uiDir, "67b70c55573094e76c9913498c0e92c291eeaec5");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /complete callback command is missing/);
  });
});

test("rejects the emergency pin when the bridge is not mounted", () => {
  withLegacyUiFixture((uiDir) => {
    writeFileSync(
      join(uiDir, "src/auth/auth0-provider-with-navigation.tsx"),
      "import { DesktopAuthCallbackBridge } from '@/lib/auth0-desktop-callback-bridge.tsx';\n",
    );
    const result = runVerifier(uiDir, "67b70c55573094e76c9913498c0e92c291eeaec5");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DesktopAuthCallbackBridge mount is missing/);
  });
});

test("rejects malformed contract JSON", () => {
  withUiFixture("{not-json\n", (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Malformed solutions-ui desktop shell contract/);
  });
});

test("rejects an incompatible callback protocol", () => {
  const incompatibleContract = structuredClone(compatibleContract);
  incompatibleContract.capabilities.desktopAuthCallback.protocolVersion = 2;

  withUiFixture(JSON.stringify(incompatibleContract), (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /desktopAuthCallback\.protocolVersion mismatch/);
  });
});

test("rejects an incompatible callback command", () => {
  const incompatibleContract = structuredClone(compatibleContract);
  incompatibleContract.capabilities.desktopAuthCallback.commands.completeAuthCallback = "ack_auth_callback";

  withUiFixture(JSON.stringify(incompatibleContract), (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /desktopAuthCallback\.commands\.completeAuthCallback mismatch/);
  });
});

test("rejects an incompatible callback payload", () => {
  const incompatibleContract = structuredClone(compatibleContract);
  incompatibleContract.capabilities.desktopAuthCallback.payloads.getPendingAuthCallbackResult.fields.callbackUrl =
    "url";

  withUiFixture(JSON.stringify(incompatibleContract), (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /desktopAuthCallback\.payloads\.getPendingAuthCallbackResult\.fields\.callbackUrl mismatch/);
  });
});

test("rejects incompatible callback lifecycle semantics", () => {
  const incompatibleContract = structuredClone(compatibleContract);
  incompatibleContract.capabilities.desktopAuthCallback.lifecycle.acknowledgeAfter = "callback-received";

  withUiFixture(JSON.stringify(incompatibleContract), (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /desktopAuthCallback\.lifecycle\.acknowledgeAfter mismatch/);
  });
});

test("rejects an incompatible callback expiry", () => {
  const incompatibleContract = structuredClone(compatibleContract);
  incompatibleContract.capabilities.desktopAuthCallback.lifecycle.expiresAfterSeconds = 300;

  withUiFixture(JSON.stringify(incompatibleContract), (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /desktopAuthCallback\.lifecycle\.expiresAfterSeconds mismatch/);
  });
});

function runVerifier(uiDir, selectedRef, requirementsPath) {
  const args = [verifierPath, uiDir];
  if (selectedRef) {
    args.push(selectedRef);
  }
  return spawnSync(process.execPath, args, {
    cwd: repoDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(requirementsPath ? { DESKTOP_UI_REQUIREMENTS_PATH: requirementsPath } : {}),
    },
  });
}

function withLegacyUiFixture(assertion) {
  withUiFixture(undefined, (uiDir) => {
    mkdirSync(join(uiDir, "src/lib"), { recursive: true });
    mkdirSync(join(uiDir, "src/auth"), { recursive: true });
    writeFileSync(
      join(uiDir, "src/lib/auth0-desktop-callback-bridge.tsx"),
      [
        "const event = 'desktop-auth-callback-ready';",
        "const getPending = 'get_pending_auth_callback';",
        "const complete = 'complete_auth_callback';",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(uiDir, "src/auth/auth0-provider-with-navigation.tsx"),
      [
        "import { DesktopAuthCallbackBridge } from '@/lib/auth0-desktop-callback-bridge.tsx';",
        "const mounted = <DesktopAuthCallbackBridge />;",
        "",
      ].join("\n"),
    );
    assertion(uiDir);
  });
}

function withUiFixture(contractSource, assertion) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "ardor-ui-contract-"));
  const uiDir = join(fixtureDir, "solutions-ui");
  mkdirSync(uiDir);

  try {
    if (contractSource !== undefined) {
      writeFileSync(join(uiDir, "desktop-shell-contract.json"), `${contractSource}\n`);
    }
    assertion(uiDir);
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
}
