import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAuditReport,
  validateDependencyBoundary,
} from "./audit-dependencies.mjs";

const approvedReport = {
  braces: [{ url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm" }],
  "http-cache-semantics": [{ url: "https://github.com/advisories/GHSA-ch52-4w7c-c8xp" }],
  "sprintf-js": [{ url: "https://github.com/advisories/GHSA-hp3w-g68c-fv3c" }],
  "extract-zip": [
    { url: "https://github.com/advisories/GHSA-jmr9-qjv8-65gv" },
    { url: "https://github.com/advisories/GHSA-7pqw-9j4j-h8q3" },
  ],
};
const packageJson = {
  devDependencies: { "@electron-forge/cli": "^7.11.2" },
  overrides: { "postcss-selector-parser": "7.1.6" },
  dependencies: {},
};
const lockfile = `
"micromatch": ["micromatch@4.0.8", "", { "dependencies": { "braces": "^3.0.3" } }],
"braces": ["braces@3.0.3", "", {}],
"global-agent": ["global-agent@3.0.0", "", { "dependencies": { "roarr": "^2.15.3" } }],
"roarr": ["roarr@2.15.4", "", { "dependencies": { "sprintf-js": "^1.1.2" } }],
"sprintf-js": ["sprintf-js@1.1.3", "", {}],
"@semantic-release/npm": ["@semantic-release/npm@13.1.5", "", { "dependencies": { "npm": "^11.6.2" } }],
"npm": ["npm@11.18.0", "", { "dependencies": { "@npmcli/query": "^5.0.0" } }],
"npm/@npmcli/query": ["@npmcli/query@5.0.0", "", { "dependencies": { "postcss-selector-parser": "^7.0.0" } }],
"npm/postcss-selector-parser": ["postcss-selector-parser@7.1.6", "", {}],
"cacheable-request": ["cacheable-request@7.0.4", "", { "dependencies": { "http-cache-semantics": "^4.0.0" } }],
"make-fetch-happen": ["make-fetch-happen@10.2.1", "", { "dependencies": { "http-cache-semantics": "^4.1.0" } }],
"npm/make-fetch-happen": ["make-fetch-happen@15.0.6", "", { "dependencies": { "http-cache-semantics": "^4.1.1" } }],
"http-cache-semantics": ["http-cache-semantics@4.2.0", "", {}],
"npm/http-cache-semantics": ["http-cache-semantics@4.2.0", "", {}],
"@electron/packager": ["@electron/packager@18.4.4", "", { "dependencies": { "extract-zip": "^2.0.0" } }],
"extract-zip": ["extract-zip@2.0.1", "", {}, { "bin": { "extract-zip": "cli.js" } }],
`;

test("accepts only the reviewed build-only findings in either order", () => {
  assert.doesNotThrow(() => validateAuditReport(approvedReport, new Date("2026-11-06T23:59:59Z")));
  assert.doesNotThrow(() => validateAuditReport(
    { ...approvedReport, "extract-zip": [...approvedReport["extract-zip"]].reverse() },
    new Date("2026-11-06T23:59:59Z"),
  ));
  assert.doesNotThrow(() => validateDependencyBoundary(packageJson, lockfile));
});

test("rejects changed findings and an expired exception", () => {
  assert.throws(() => validateAuditReport({}, new Date("2026-08-14T00:00:00Z")), /finding set changed/);
  assert.throws(
    () =>
      validateAuditReport(
        { ...approvedReport, "extract-zip": [approvedReport["extract-zip"][0], { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] },
        new Date("2026-08-14T00:00:00Z"),
      ),
    /Unapproved/,
  );
  assert.throws(
    () => validateAuditReport(approvedReport, new Date("2026-11-07T00:00:00Z")),
    /exception expired/,
  );
});

test("rejects additional packages, missing findings, and duplicate advisories", () => {
  const now = new Date("2026-09-10T00:00:00Z");
  assert.throws(() => validateAuditReport({ ...approvedReport, "js-yaml": [] }, now), /finding set changed/);
  assert.throws(() => validateAuditReport({ ...approvedReport, "extract-zip": approvedReport["extract-zip"].slice(0, 1) }, now), /Unexpected/);
  assert.throws(() => validateAuditReport({ ...approvedReport, "extract-zip": [...approvedReport["extract-zip"], {}] }, now), /Unexpected/);
  assert.throws(() => validateAuditReport({ ...approvedReport, "extract-zip": Array(2).fill(approvedReport["extract-zip"][0]) }, now), /Unapproved/);
});

test("rejects changes to reviewed tooling versions, copies, and incoming edges", () => {
  for (const changed of [
    lockfile.replace("braces@3.0.3", "braces@3.0.4"),
    lockfile.replace("http-cache-semantics@4.2.0", "http-cache-semantics@4.2.1"),
    lockfile.replace("micromatch@4.0.8", "micromatch@4.0.9"),
    lockfile.replace("sprintf-js@1.1.3", "sprintf-js@1.1.4"),
    lockfile.replace("roarr@2.15.4", "roarr@2.15.5"),
    lockfile.replace("global-agent@3.0.0", "global-agent@3.0.1"),
    lockfile.replace("npm@11.18.0", "npm@11.19.0"),
    lockfile.replace("@semantic-release/npm@13.1.5", "@semantic-release/npm@13.1.6"),
    lockfile.replace("postcss-selector-parser@7.1.6", "postcss-selector-parser@7.1.5"),
    lockfile.replace("@npmcli/query@5.0.0", "@npmcli/query@5.0.1"),
    `${lockfile}\n"postcss-selector-parser": ["postcss-selector-parser@7.1.4", "", {}],`,
    lockfile.replace('"^4.1.1"', '"*"'),
    `${lockfile}\n"other/braces": ["braces@3.0.3", "", {}],`,
    `${lockfile}\n"other": ["other@1.0.0", "", { "dependencies": { "braces": "^3.0.3" } }],`,
  ]) {
    assert.throws(() => validateDependencyBoundary(packageJson, changed), /review|changed/);
  }
});

test("rejects direct and transitive runtime paths to reviewed tooling", () => {
  for (const name of ["braces", "http-cache-semantics", "sprintf-js", "postcss-selector-parser"]) {
    assert.throws(() => validateDependencyBoundary({ ...packageJson, dependencies: { [name]: "*" } }, lockfile), /runtime|transitive/);
    assert.throws(() => validateDependencyBoundary({ ...packageJson, devDependencies: { ...packageJson.devDependencies, [name]: "*" } }, lockfile), /transitive/);
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    const runtimeLock = `${lockfile}\n"runtime": ["runtime@1.0.0", "", { "${field}": { "micromatch": "^4.0.8" } }],`;
    assert.throws(() => validateDependencyBoundary({ ...packageJson, dependencies: { runtime: "1.0.0" } }, runtimeLock), /runtime/);
  }
  assert.throws(() => validateDependencyBoundary({ ...packageJson, dependencies: { missing: "1.0.0" } }, lockfile), /resolve/);
  assert.doesNotThrow(() => validateDependencyBoundary({ ...packageJson, dependencies: { safe: "1.0.0" } }, `${lockfile}\n"safe": ["safe@1.0.0", "", {}],`));
});

test("rejects the logger and bundled npm parser entering the runtime graph", () => {
  for (const name of ["global-agent", "@semantic-release/npm"]) {
    for (const field of ["dependencies", "optionalDependencies"]) {
      assert.throws(
        () => validateDependencyBoundary(
          { ...packageJson, dependencies: { runtime: "1.0.0" } },
          `${lockfile}\n"runtime": ["runtime@1.0.0", "", { "${field}": { "${name}": "*" } }],`,
        ),
        /runtime dependency graph/,
      );
    }
  }
});

test("resolves scoped runtime packages without treating a scope as a parent", () => {
  const scopedLock = `${lockfile}
"@probe/runtime": ["@probe/runtime@1.0.0", "", { "dependencies": { "micromatch": "^4.0.8" } }],
"@probe/micromatch": ["safe@1.0.0", "", {}],
`;
  assert.throws(() => validateDependencyBoundary({ ...packageJson, dependencies: { "@probe/runtime": "1.0.0" } }, scopedLock), /runtime/);
});

test("includes required runtime peers and permits uninstalled optional peers", () => {
  const peerLock = `${lockfile}\n"runtime": ["runtime@1.0.0", "", { "peerDependencies": { "micromatch": "^4.0.8" } }],`;
  const runtimePackage = { ...packageJson, dependencies: { runtime: "1.0.0" } };
  assert.throws(() => validateDependencyBoundary(runtimePackage, peerLock), /runtime/);
  assert.doesNotThrow(() => validateDependencyBoundary(runtimePackage, `${lockfile}\n"runtime": ["runtime@1.0.0", "", { "peerDependencies": { "absent": "*" }, "optionalPeers": ["absent"] }],`));
});

test("traces Git dependency metadata and fails closed on unsupported lockfile formatting", () => {
  const gitLock = `${lockfile}\n"runtime": ["runtime@github:owner/runtime#1234567", { "dependencies": { "micromatch": "^4.0.8" } }, "runtime-1234567"],`;
  assert.throws(() => validateDependencyBoundary({ ...packageJson, dependencies: { runtime: "*" } }, gitLock), /runtime/);
  assert.throws(() => validateDependencyBoundary(packageJson, `${lockfile}\n"new-consumer": [\n"new-consumer@1.0.0", "", {}],`), /lockfile/);
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
