import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPinOnlyUpdate,
  classifyPinCandidate,
  updateRequirements,
} from "./solutions-ui-pin-policy.mjs";

const currentSha = "a".repeat(40);
const pendingSha = "b".repeat(40);
const candidateSha = "c".repeat(40);

test("classifies current and pending duplicate releases as no-ops", () => {
  assert.equal(classifyPinCandidate({ currentSha, candidateSha: currentSha }), "current");
  assert.equal(
    classifyPinCandidate({
      currentSha,
      candidateSha: pendingSha,
      currentComparison: "ahead",
      pendingSha,
      pendingBaseComparison: "ahead",
    }),
    "pending",
  );
});

test("supersedes a pending pin that no longer advances desktop main", () => {
  assert.equal(
    classifyPinCandidate({
      currentSha: candidateSha,
      candidateSha,
      pendingSha: currentSha,
      pendingBaseComparison: "behind",
    }),
    "superseded",
  );
  assert.equal(
    classifyPinCandidate({
      currentSha,
      candidateSha,
      currentComparison: "ahead",
      pendingSha: currentSha,
      pendingBaseComparison: "identical",
    }),
    "superseded",
  );
});

test("creates or refreshes the pin PR only for forward updates", () => {
  assert.equal(
    classifyPinCandidate({ currentSha, candidateSha, currentComparison: "ahead" }),
    "create",
  );
  assert.equal(
    classifyPinCandidate({
      currentSha,
      candidateSha,
      currentComparison: "ahead",
      pendingSha,
      pendingBaseComparison: "ahead",
      pendingComparison: "ahead",
    }),
    "update",
  );
});

test("ignores releases older than either the current or pending pin", () => {
  assert.equal(
    classifyPinCandidate({ currentSha, candidateSha, currentComparison: "behind" }),
    "stale",
  );
  assert.equal(
    classifyPinCandidate({
      currentSha,
      candidateSha,
      currentComparison: "ahead",
      pendingSha,
      pendingBaseComparison: "ahead",
      pendingComparison: "behind",
    }),
    "stale",
  );
});

test("rejects malformed, identical-but-different, and diverged candidates", () => {
  assert.throws(
    () => classifyPinCandidate({ currentSha: "main", candidateSha }),
    /lowercase 40-character commit SHA/,
  );
  assert.throws(
    () => classifyPinCandidate({ currentSha, candidateSha, currentComparison: "identical" }),
    /unexpected comparison status/,
  );
  assert.throws(
    () => classifyPinCandidate({ currentSha, candidateSha, currentComparison: "diverged" }),
    /unexpected comparison status/,
  );
});

test("migrates schema 2 requirements and records the release identity", () => {
  const requirements = {
    schemaVersion: 2,
    solutionsUiRef: currentSha,
    bridgeGlobal: "ardorDesktop",
    requiredCapabilities: ["runtime", "auth"],
  };

  assert.deepEqual(updateRequirements(requirements, "v3.121.0", candidateSha), {
    schemaVersion: 3,
    solutionsUiTag: "v3.121.0",
    solutionsUiRef: candidateSha,
    bridgeGlobal: "ardorDesktop",
    requiredCapabilities: ["runtime", "auth"],
  });
  assert.equal(requirements.schemaVersion, 2);
  assert.equal("solutionsUiTag" in requirements, false);
});

test("rejects generated manifests that change the trusted bridge contract", () => {
  const current = {
    schemaVersion: 3,
    solutionsUiTag: "v3.120.1",
    solutionsUiRef: currentSha,
    bridgeGlobal: "ardorDesktop",
    requiredCapabilities: ["runtime", "auth"],
  };
  const expected = updateRequirements(current, "v3.121.0", candidateSha);

  assert.doesNotThrow(() => assertPinOnlyUpdate(current, expected, "v3.121.0", candidateSha));
  assert.throws(
    () =>
      assertPinOnlyUpdate(
        current,
        { ...expected, requiredCapabilities: ["runtime"] },
        "v3.121.0",
        candidateSha,
      ),
    /fields outside the verified tag and SHA update/,
  );
  assert.throws(
    () => assertPinOnlyUpdate(current, { ...expected, extra: true }, "v3.121.0", candidateSha),
    /fields outside the verified tag and SHA update/,
  );
});

test("rejects invalid release tags and unsupported requirements schemas", () => {
  assert.throws(() => updateRequirements({ schemaVersion: 1 }, "v3.121.0", candidateSha), /schemaVersion/);
  assert.throws(
    () => updateRequirements({ schemaVersion: 2 }, "latest", candidateSha),
    /semantic solutions-ui release tag/,
  );
});
