import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SEMANTIC_RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const IMMUTABLE_SHA = /^[0-9a-f]{40}$/;

export function classifyPinCandidate({
  currentSha,
  candidateSha,
  currentComparison,
  pendingSha,
  pendingBaseComparison,
  pendingComparison,
}) {
  assertImmutableSha(currentSha);
  assertImmutableSha(candidateSha);
  if (pendingSha) {
    assertImmutableSha(pendingSha);
    if (!["ahead", "behind", "identical", "diverged"].includes(pendingBaseComparison)) {
      throw new Error(
        `unexpected comparison status for pending pin against current pin: ${pendingBaseComparison ?? "missing"}`,
      );
    }
    if (pendingBaseComparison !== "ahead") {
      return "superseded";
    }
  }

  if (candidateSha === currentSha) {
    return "current";
  }
  if (candidateSha === pendingSha) {
    return "pending";
  }
  if (currentComparison === "behind") {
    return "stale";
  }
  if (currentComparison !== "ahead") {
    throw new Error(`unexpected comparison status against current pin: ${currentComparison ?? "missing"}`);
  }
  if (!pendingSha) {
    return "create";
  }
  if (pendingComparison === "behind") {
    return "stale";
  }
  if (pendingComparison !== "ahead") {
    throw new Error(`unexpected comparison status against pending pin: ${pendingComparison ?? "missing"}`);
  }
  return "update";
}

export function updateRequirements(requirements, tag, sha) {
  if (requirements?.schemaVersion !== 2 && requirements?.schemaVersion !== 3) {
    throw new Error("desktop UI requirements schemaVersion must be 2 or 3");
  }
  assertSemanticReleaseTag(tag);
  assertImmutableSha(sha);

  const { schemaVersion: _schemaVersion, solutionsUiTag: _tag, solutionsUiRef: _sha, ...rest } = requirements;
  return {
    schemaVersion: 3,
    solutionsUiTag: tag,
    solutionsUiRef: sha,
    ...rest,
  };
}

export function assertPinOnlyUpdate(currentRequirements, requestedRequirements, tag, sha) {
  const expected = updateRequirements(currentRequirements, tag, sha);
  if (!isDeepStrictEqual(expected, requestedRequirements)) {
    throw new Error("generated pin PR changes fields outside the verified tag and SHA update");
  }
}

function assertSemanticReleaseTag(tag) {
  if (!SEMANTIC_RELEASE_TAG.test(tag)) {
    throw new Error("desktop UI requirements must record a semantic solutions-ui release tag");
  }
}

function assertImmutableSha(sha) {
  if (!IMMUTABLE_SHA.test(sha)) {
    throw new Error("solutions-ui pin must be a lowercase 40-character commit SHA");
  }
}

function run() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "classify") {
    const [
      currentSha,
      candidateSha,
      currentComparison,
      pendingSha,
      pendingBaseComparison,
      pendingComparison,
    ] = args;
    process.stdout.write(
      classifyPinCandidate({
        currentSha,
        candidateSha,
        currentComparison,
        pendingSha: pendingSha || undefined,
        pendingBaseComparison: pendingBaseComparison || undefined,
        pendingComparison: pendingComparison || undefined,
      }),
    );
    return;
  }
  if (command === "write") {
    const [path, tag, sha] = args;
    if (!path) {
      throw new Error("requirements path is required");
    }
    const requirements = JSON.parse(readFileSync(path, "utf8"));
    const updated = updateRequirements(requirements, tag, sha);
    writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const [currentPath, requestedPath, tag, sha] = args;
    if (!currentPath || !requestedPath) {
      throw new Error("current and requested requirements paths are required");
    }
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    const requested = JSON.parse(readFileSync(requestedPath, "utf8"));
    assertPinOnlyUpdate(current, requested, tag, sha);
    return;
  }
  throw new Error(`unknown solutions-ui pin policy command: ${command ?? "missing"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
