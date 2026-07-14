#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requirementsPath = resolve(process.env.DESKTOP_UI_REQUIREMENTS_PATH ?? resolve(repoDir, "desktop-ui-requirements.json"));
const solutionsUiDir = resolve(process.argv[2] ?? resolve(repoDir, "../solutions-ui"));
const selectedSolutionsUiRef = process.argv[3] ?? process.env.SOLUTIONS_UI_REF;
const contractPath = resolve(solutionsUiDir, "desktop-shell-contract.json");
const LEGACY_MANIFESTLESS_SOLUTIONS_UI_REF = "67b70c55573094e76c9913498c0e92c291eeaec5";

try {
  const requirements = readJson(requirementsPath, "desktop UI requirements");
  verifyRequirements(requirements);

  if (existsSync(contractPath)) {
    const contract = readJson(contractPath, "solutions-ui desktop shell contract");
    verifyContract(requirements, contract);
    console.log(`Verified solutions-ui desktop shell contract at ${contractPath}`);
  } else {
    verifyLegacyPinnedUi(requirements, solutionsUiDir, selectedSolutionsUiRef);
    console.log(`Verified legacy pinned solutions-ui source contract at ${solutionsUiDir}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function readJson(path, label) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Malformed ${label} at ${path}: ${error.message}`);
  }
}

function verifyRequirements(requirements) {
  assertPlainObject(requirements, "desktop UI requirements");
  assertEqual(requirements.schemaVersion, 1, "desktop UI requirements schemaVersion");
  assertString(requirements.solutionsUiRef, "desktop UI requirements solutionsUiRef");
  if (!/^[0-9a-f]{40}$/.test(requirements.solutionsUiRef)) {
    throw new Error("desktop UI requirements solutionsUiRef must be a lowercase 40-character commit SHA");
  }

  readCallback(requirements.requirements, "desktop UI requirements");
}

function verifyContract(requirements, contract) {
  const requiredCallback = readCallback(requirements.requirements, "desktop UI requirements");

  assertPlainObject(contract, "solutions-ui desktop shell contract");
  assertEqual(contract.schemaVersion, requirements.schemaVersion, "schemaVersion");
  const providedCallback = readCallback(contract.capabilities, "solutions-ui desktop shell contract");

  assertEqual(providedCallback.protocolVersion, requiredCallback.protocolVersion, "desktopAuthCallback.protocolVersion");
  assertEqual(providedCallback.event, requiredCallback.event, "desktopAuthCallback.event");
  assertEqual(
    providedCallback.commands.getPendingAuthCallback,
    requiredCallback.commands.getPendingAuthCallback,
    "desktopAuthCallback.commands.getPendingAuthCallback",
  );
  assertEqual(
    providedCallback.commands.completeAuthCallback,
    requiredCallback.commands.completeAuthCallback,
    "desktopAuthCallback.commands.completeAuthCallback",
  );
  assertEqual(
    providedCallback.payloads.getPendingAuthCallbackResult.nullable,
    requiredCallback.payloads.getPendingAuthCallbackResult.nullable,
    "desktopAuthCallback.payloads.getPendingAuthCallbackResult.nullable",
  );
  assertEqual(
    providedCallback.payloads.getPendingAuthCallbackResult.fields.id,
    requiredCallback.payloads.getPendingAuthCallbackResult.fields.id,
    "desktopAuthCallback.payloads.getPendingAuthCallbackResult.fields.id",
  );
  assertEqual(
    providedCallback.payloads.getPendingAuthCallbackResult.fields.callbackUrl,
    requiredCallback.payloads.getPendingAuthCallbackResult.fields.callbackUrl,
    "desktopAuthCallback.payloads.getPendingAuthCallbackResult.fields.callbackUrl",
  );
  assertEqual(
    providedCallback.payloads.completeAuthCallbackArguments.callbackId,
    requiredCallback.payloads.completeAuthCallbackArguments.callbackId,
    "desktopAuthCallback.payloads.completeAuthCallbackArguments.callbackId",
  );
  assertEqual(
    providedCallback.payloads.completeAuthCallbackResult,
    requiredCallback.payloads.completeAuthCallbackResult,
    "desktopAuthCallback.payloads.completeAuthCallbackResult",
  );
  assertEqual(
    providedCallback.lifecycle.delivery,
    requiredCallback.lifecycle.delivery,
    "desktopAuthCallback.lifecycle.delivery",
  );
  assertEqual(
    providedCallback.lifecycle.readyEvent,
    requiredCallback.lifecycle.readyEvent,
    "desktopAuthCallback.lifecycle.readyEvent",
  );
  assertEqual(
    providedCallback.lifecycle.acknowledgeAfter,
    requiredCallback.lifecycle.acknowledgeAfter,
    "desktopAuthCallback.lifecycle.acknowledgeAfter",
  );
  assertEqual(
    providedCallback.lifecycle.expiresAfterSeconds,
    requiredCallback.lifecycle.expiresAfterSeconds,
    "desktopAuthCallback.lifecycle.expiresAfterSeconds",
  );
  assertEqual(
    providedCallback.lifecycle.expiryPhase,
    requiredCallback.lifecycle.expiryPhase,
    "desktopAuthCallback.lifecycle.expiryPhase",
  );
}

function verifyLegacyPinnedUi(requirements, solutionsUiDir, selectedRef) {
  if (
    selectedRef !== LEGACY_MANIFESTLESS_SOLUTIONS_UI_REF ||
    requirements.solutionsUiRef !== LEGACY_MANIFESTLESS_SOLUTIONS_UI_REF
  ) {
    throw new Error(
      `solutions-ui desktop shell contract is missing and legacy source verification is allowed only for emergency ref ${LEGACY_MANIFESTLESS_SOLUTIONS_UI_REF}`,
    );
  }

  const callback = readCallback(requirements.requirements, "desktop UI requirements");
  const bridgePath = resolve(solutionsUiDir, "src/lib/auth0-desktop-callback-bridge.tsx");
  const providerPath = resolve(solutionsUiDir, "src/auth/auth0-provider-with-navigation.tsx");
  const bridge = readSource(bridgePath, "legacy desktop auth callback bridge");
  const provider = readSource(providerPath, "legacy Auth0 provider");

  assertSourceContainsLiteral(bridge, callback.event, bridgePath, "callback-ready event");
  assertSourceContainsLiteral(
    bridge,
    callback.commands.getPendingAuthCallback,
    bridgePath,
    "get-pending callback command",
  );
  assertSourceContainsLiteral(
    bridge,
    callback.commands.completeAuthCallback,
    bridgePath,
    "complete callback command",
  );
  assertSourceContains(
    provider,
    "import { DesktopAuthCallbackBridge }",
    providerPath,
    "DesktopAuthCallbackBridge import",
  );
  assertSourceContains(provider, "<DesktopAuthCallbackBridge />", providerPath, "DesktopAuthCallbackBridge mount");
}

function readSource(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error.message}`);
  }
}

function assertSourceContains(source, expected, path, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label} is missing from ${path}`);
  }
}

function assertSourceContainsLiteral(source, expected, path, label) {
  if (!source.includes(`'${expected}'`) && !source.includes(`"${expected}"`)) {
    throw new Error(`${label} is missing from ${path}`);
  }
}

function readCallback(container, label) {
  assertPlainObject(container, `${label} capability container`);
  const callback = container.desktopAuthCallback;
  assertPlainObject(callback, `${label} desktopAuthCallback`);
  assertInteger(callback.protocolVersion, `${label} desktopAuthCallback.protocolVersion`);
  assertString(callback.event, `${label} desktopAuthCallback.event`);
  assertPlainObject(callback.commands, `${label} desktopAuthCallback.commands`);
  assertString(
    callback.commands.getPendingAuthCallback,
    `${label} desktopAuthCallback.commands.getPendingAuthCallback`,
  );
  assertString(
    callback.commands.completeAuthCallback,
    `${label} desktopAuthCallback.commands.completeAuthCallback`,
  );
  assertPlainObject(callback.payloads, `${label} desktopAuthCallback.payloads`);
  assertPlainObject(
    callback.payloads.getPendingAuthCallbackResult,
    `${label} desktopAuthCallback.payloads.getPendingAuthCallbackResult`,
  );
  assertBoolean(
    callback.payloads.getPendingAuthCallbackResult.nullable,
    `${label} desktopAuthCallback.payloads.getPendingAuthCallbackResult.nullable`,
  );
  assertPlainObject(
    callback.payloads.getPendingAuthCallbackResult.fields,
    `${label} desktopAuthCallback.payloads.getPendingAuthCallbackResult.fields`,
  );
  assertString(
    callback.payloads.getPendingAuthCallbackResult.fields.id,
    `${label} desktopAuthCallback.payloads.getPendingAuthCallbackResult.fields.id`,
  );
  assertString(
    callback.payloads.getPendingAuthCallbackResult.fields.callbackUrl,
    `${label} desktopAuthCallback.payloads.getPendingAuthCallbackResult.fields.callbackUrl`,
  );
  assertPlainObject(
    callback.payloads.completeAuthCallbackArguments,
    `${label} desktopAuthCallback.payloads.completeAuthCallbackArguments`,
  );
  assertString(
    callback.payloads.completeAuthCallbackArguments.callbackId,
    `${label} desktopAuthCallback.payloads.completeAuthCallbackArguments.callbackId`,
  );
  assertString(
    callback.payloads.completeAuthCallbackResult,
    `${label} desktopAuthCallback.payloads.completeAuthCallbackResult`,
  );
  assertPlainObject(callback.lifecycle, `${label} desktopAuthCallback.lifecycle`);
  assertString(callback.lifecycle.delivery, `${label} desktopAuthCallback.lifecycle.delivery`);
  assertString(callback.lifecycle.readyEvent, `${label} desktopAuthCallback.lifecycle.readyEvent`);
  assertString(callback.lifecycle.acknowledgeAfter, `${label} desktopAuthCallback.lifecycle.acknowledgeAfter`);
  assertInteger(
    callback.lifecycle.expiresAfterSeconds,
    `${label} desktopAuthCallback.lifecycle.expiresAfterSeconds`,
  );
  assertString(callback.lifecycle.expiryPhase, `${label} desktopAuthCallback.lifecycle.expiryPhase`);
  return callback;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
