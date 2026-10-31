import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateAuditReport,
  validateBundledNpmUndici,
  validateDependencyBoundary,
  validateGlobAbortHandling,
  validateMinimatchPatternLimit,
} from "./audit-dependencies.mjs";

const approvedReport = {
  minimatch: [{ url: "https://github.com/advisories/GHSA-g3hv-75wg-m249" }],
};
const packageJson = {
  devDependencies: { "@electron-forge/cli": "8.0.1" },
  dependencies: {},
};
// Exercise the reviewed boundary against the real graph instead of duplicating
// every pinned tooling version in a synthetic lockfile.
const lockfile = readFileSync(new URL("../bun.lock", import.meta.url), "utf8");

test("accepts only the reviewed build-only finding and dependency graph", () => {
  assert.doesNotThrow(() => validateAuditReport(approvedReport, new Date("2026-11-12T23:59:59Z")));
  assert.doesNotThrow(() => validateDependencyBoundary(packageJson, lockfile));
});

test("rejects changed findings and an expired exception", () => {
  assert.throws(() => validateAuditReport({}, new Date("2026-08-14T00:00:00Z")), /finding set changed/);
  assert.throws(
    () =>
      validateAuditReport(
        { ...approvedReport, minimatch: [{ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] },
        new Date("2026-08-14T00:00:00Z"),
      ),
    /Unapproved/,
  );
  assert.throws(
    () => validateAuditReport(approvedReport, new Date("2026-11-13T00:00:00Z")),
    /exception expired/,
  );
});

test("rejects an unpatched installed npm bundle despite a patched lockfile", () => {
  assert.doesNotThrow(() => validateDependencyBoundary(packageJson, lockfile));
  assert.doesNotThrow(() => validateBundledNpmUndici({ name: "undici", version: "6.29.1" }));
  for (const bundle of [null, [], {}, { name: "undici", version: "6.29.0" },
    { name: "undici", version: "7.30.1" }, { name: "other", version: "6.29.1" }]) {
    assert.throws(() => validateBundledNpmUndici(bundle), /installed undici bundle/);
  }
});

test("rejects additional packages, missing findings, and duplicate advisories", () => {
  const now = new Date("2026-09-10T00:00:00Z");
  assert.throws(() => validateAuditReport({ ...approvedReport, "js-yaml": [] }, now), /finding set changed/);
  assert.throws(() => validateAuditReport({ ...approvedReport, minimatch: [] }, now), /Unexpected/);
  assert.throws(() => validateAuditReport({ ...approvedReport, minimatch: Array(2).fill(approvedReport.minimatch[0]) }, now), /Unexpected/);
});

test("rejects changes to reviewed tooling versions, copies, and incoming edges", () => {
  for (const changed of [
    lockfile.replace("braces@3.0.3", "braces@3.0.4"),
    lockfile.replace("glob@14.0.2", "glob@14.0.3"),
    lockfile.replace('"minimatch": ["minimatch@11.0.3"', '"minimatch": ["minimatch@11.0.4"'),
    lockfile.replace('"glob": "^13.0.0"', '"glob": "*"'),
    lockfile.replace("http-cache-semantics@4.3.0", "http-cache-semantics@4.3.1"),
    lockfile.replace("micromatch@4.0.8", "micromatch@4.0.9"),
    lockfile.replace('"npm": ["npm@11.21.1"', '"npm": ["npm@11.21.2"'),
    lockfile.replace("@semantic-release/npm@13.2.0", "@semantic-release/npm@13.2.1"),
    lockfile.replace("postcss-selector-parser@7.1.7", "postcss-selector-parser@7.1.8"),
    lockfile.replace("@npmcli/query@5.0.0", "@npmcli/query@5.0.1"),
    `${lockfile}\n"postcss-selector-parser": ["postcss-selector-parser@7.1.4", "", {}],`,
    lockfile.replace('"http-cache-semantics": "^4.1.1"', '"http-cache-semantics": "*"'),
    `${lockfile}\n"other/braces": ["braces@3.0.3", "", {}],`,
    `${lockfile}\n"other": ["other@1.0.0", "", { "dependencies": { "braces": "^3.0.3" } }],`,
  ]) {
    assert.throws(() => validateDependencyBoundary(packageJson, changed), /review|changed/);
  }
});

test("rejects direct and transitive runtime paths to reviewed tooling", () => {
  for (const name of ["braces", "http-cache-semantics", "postcss-selector-parser", "glob", "minimatch"]) {
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

test("rejects the bundled npm parser entering the runtime graph", () => {
  for (const field of ["dependencies", "optionalDependencies"]) {
    assert.throws(
      () => validateDependencyBoundary(
        { ...packageJson, dependencies: { runtime: "1.0.0" } },
        `${lockfile}\n"runtime": ["runtime@1.0.0", "", { "${field}": { "@semantic-release/npm": "*" } }],`,
      ),
      /runtime dependency graph/,
    );
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

test("installed official and npm-bundled CJS/ESM tooling enforces resource budgets", async () => {
  for (const packagePath of ["node_modules", "node_modules/npm/node_modules"]) {
    for (const format of ["commonjs", "esm"]) {
      const { GlobWalker } = await import(`../${packagePath}/glob/dist/${format}/walker.js`);
      assert.doesNotThrow(() => validateGlobAbortHandling(GlobWalker));
      const { Minimatch } = await import(`../${packagePath}/minimatch/dist/${format}/index.js`);
      assert.doesNotThrow(() => validateMinimatchPatternLimit(Minimatch));
    }
  }
});
