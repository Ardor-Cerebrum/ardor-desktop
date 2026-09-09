import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAuditReport,
  validateDependencyBoundary,
} from "./audit-dependencies.mjs";

const approvedReport = {
  "extract-zip": [
    { url: "https://github.com/advisories/GHSA-jmr9-qjv8-65gv" },
    { url: "https://github.com/advisories/GHSA-7pqw-9j4j-h8q3" },
  ],
};
const packageJson = {
  devDependencies: { "@electron-forge/cli": "^7.11.2" },
  dependencies: {},
};
const lockfile = `
"@electron/packager": ["@electron/packager@18.4.4", "", { "dependencies": { "extract-zip": "^2.0.0" } }],
"extract-zip": ["extract-zip@2.0.1", "", {}, { "bin": { "extract-zip": "cli.js" } }],
`;

test("accepts only the current build-only extract-zip findings in either order", () => {
  assert.doesNotThrow(() => validateAuditReport(approvedReport, new Date("2026-09-13T23:59:59Z")));
  assert.doesNotThrow(() => validateAuditReport(
    { "extract-zip": [...approvedReport["extract-zip"]].reverse() },
    new Date("2026-09-13T23:59:59Z"),
  ));
  assert.doesNotThrow(() => validateDependencyBoundary(packageJson, lockfile));
});

test("rejects changed findings and an expired exception", () => {
  assert.throws(() => validateAuditReport({}, new Date("2026-08-14T00:00:00Z")), /finding set changed/);
  assert.throws(
    () =>
      validateAuditReport(
        { "extract-zip": [approvedReport["extract-zip"][0], { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] },
        new Date("2026-08-14T00:00:00Z"),
      ),
    /Unapproved/,
  );
  assert.throws(
    () => validateAuditReport(approvedReport, new Date("2026-09-14T00:00:00Z")),
    /exception expired/,
  );
});

test("rejects additional packages, missing findings, and duplicate advisories", () => {
  const now = new Date("2026-09-10T00:00:00Z");
  assert.throws(() => validateAuditReport({ ...approvedReport, "js-yaml": [] }, now), /finding set changed/);
  assert.throws(() => validateAuditReport({ "extract-zip": approvedReport["extract-zip"].slice(0, 1) }, now), /Unexpected/);
  assert.throws(() => validateAuditReport({ "extract-zip": [...approvedReport["extract-zip"], {}] }, now), /Unexpected/);
  assert.throws(() => validateAuditReport({ "extract-zip": Array(2).fill(approvedReport["extract-zip"][0]) }, now), /Unapproved/);
});

test("rejects a broadened or runtime dependency path", () => {
  assert.throws(
    () => validateDependencyBoundary({ ...packageJson, dependencies: { "extract-zip": "2.0.1" } }, lockfile),
    /transitive/,
  );
  assert.throws(
    () => validateDependencyBoundary(packageJson, `${lockfile}\n"extract-zip": "*"`),
    /dependency path changed/,
  );
});
