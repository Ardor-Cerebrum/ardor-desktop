import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(repoDir, "scripts/verify-desktop-ui-contract.mjs");
const verifierSource = readFileSync(verifierPath, "utf8");
const requirementsSource = readFileSync(join(repoDir, "desktop-ui-requirements.json"), "utf8");

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
    nativeSidebarBrowser: {
      protocolVersion: 6,
      commands: {
        open: "open_sidebar_browser",
        layout: "layout_sidebar_browser",
        control: "control_sidebar_browser",
        input: "input_sidebar_browser",
        close: "close_sidebar_browser",
      },
      payloads: {
        bounds: { x: "number", y: "number", width: "number", height: "number" },
        overlay: { bounds: "bounds", cornerRadius: "number" },
        openArguments: {
          request: {
            url: "string",
            source: ["artifact", "solution"],
            bounds: "bounds",
            overlays: "overlay[]",
          },
        },
        openResult: { generation: "number", devtoolsEnabled: "boolean" },
        layoutArguments: {
          generation: "number",
          bounds: "bounds",
          visible: "boolean",
          overlays: "overlay[]",
        },
        controlArguments: {
          generation: "number",
          action: [
            "back",
            "find",
            "forward",
            "reload",
            "navigate",
            "openExternal",
            "openDevTools",
            "print",
            "setZoom",
            "stopFind",
          ],
          url: "string?",
          query: "string?",
          forward: "boolean?",
          findNext: "boolean?",
          zoomFactor: "number?",
        },
        inputArguments: {
          generation: "number",
          input: {
            kind: [
              "focus",
              "focusNext",
              "focusPrevious",
              "move",
              "leave",
              "leftDown",
              "leftUp",
              "leftDoubleClick",
              "rightDown",
              "rightUp",
              "rightDoubleClick",
              "middleDown",
              "middleUp",
              "middleDoubleClick",
              "xDown",
              "xUp",
              "xDoubleClick",
              "wheel",
              "horizontalWheel",
            ],
            x: "number",
            y: "number",
            mouseData: "number",
            buttons: "number",
            control: "boolean",
            shift: "boolean",
          },
        },
        inputResult: { accepted: "boolean", cursor: "string" },
        closeArguments: { generation: "number" },
        mutationResult: "boolean",
      },
      lifecycle: {
        ownership: "generation-scoped",
        concurrency: "single-active-view",
        session: "incognito-close-on-teardown",
        staleCommands: "ignored",
        layoutUpdates: "changed-bounds-scale-or-radix-overlays",
        inputDispatch: "serialized-coalesced-move-and-wheel-with-focus-handoff",
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

test("rejects a solutions-ui path outside the current workspace", () => {
  withUiFixture(JSON.stringify(compatibleContract), (uiDir) => {
    const result = runVerifier(uiDir, undefined, undefined, "../outside-workspace");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /solutions-ui directory must be a direct child of the current workspace/);
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

test("rejects an incompatible native sidebar browser generation contract", () => {
  const incompatibleContract = structuredClone(compatibleContract);
  incompatibleContract.capabilities.nativeSidebarBrowser.lifecycle.staleCommands = "close-latest";

  withUiFixture(JSON.stringify(incompatibleContract), (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nativeSidebarBrowser\.lifecycle\.staleCommands mismatch/);
  });
});

function runVerifier(uiDir, selectedRef, requirements, uiDirectoryName = "solutions-ui") {
  const workspaceDir = dirname(uiDir);
  const fixtureRepoDir = join(workspaceDir, "ardor-desktop");
  if (requirements) {
    writeFileSync(join(fixtureRepoDir, "desktop-ui-requirements.json"), `${JSON.stringify(requirements)}\n`);
  }

  const args = [join(fixtureRepoDir, "scripts/verify-desktop-ui-contract.mjs"), uiDirectoryName];
  if (selectedRef) {
    args.push(selectedRef);
  }
  return spawnSync(process.execPath, args, {
    cwd: workspaceDir,
    encoding: "utf8",
    env: process.env,
  });
}

function withUiFixture(contractSource, assertion) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "ardor-ui-contract-"));
  const fixtureRepoDir = join(fixtureDir, "ardor-desktop");
  const uiDir = join(fixtureDir, "solutions-ui");
  mkdirSync(join(fixtureRepoDir, "scripts"), { recursive: true });
  mkdirSync(uiDir);
  writeFileSync(join(fixtureRepoDir, "scripts/verify-desktop-ui-contract.mjs"), verifierSource);
  writeFileSync(join(fixtureRepoDir, "desktop-ui-requirements.json"), requirementsSource);

  try {
    if (contractSource !== undefined) {
      writeFileSync(join(uiDir, "desktop-shell-contract.json"), `${contractSource}\n`);
    }
    assertion(uiDir);
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
}
