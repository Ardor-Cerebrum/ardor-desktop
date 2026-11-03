import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateAuditReport,
  readNpmBundle,
  validateNpmBundle,
  validateNpmBundleAuditReport,
  validateNpmReleaseBoundary,
  validateDependencyBoundary,
  validateGlobAbortHandling,
  validateMinimatchPatternLimit,
} from "./audit-dependencies.mjs";

const approvedReport = {
  minimatch: [{ url: "https://github.com/advisories/GHSA-g3hv-75wg-m249" }],
};
const approvedBundleReport = {
  glob: [{ url: "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4" }],
  "ip-address": [{ url: "https://github.com/advisories/GHSA-rxp7-6hxx-x8q5" }],
  minimatch: approvedReport.minimatch,
  undici: [
    "GHSA-4qv8-2p9j-2685", "GHSA-xjj6-f33q-929c", "GHSA-2m5v-pch6-74hx",
    "GHSA-qrxm-fqhp-jwvm", "GHSA-9fm3-97px-rjf6",
  ].map((id) => ({ url: `https://github.com/advisories/${id}` })),
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

test("checks the actual npm bundle and rejects changed inventories before registry submission", async (t) => {
  const bundle = await readNpmBundle(fileURLToPath(new URL("..", import.meta.url)));
  assert.doesNotThrow(() => validateNpmBundle(bundle));
  for (const changed of [null, [], {}, { ...bundle, undici: ["6.29.1"] },
    { ...bundle, "private-package": ["1.0.0"] }]) {
    assert.throws(() => validateNpmBundle(changed), /bundle/);
  }
  const root = mkdtempSync(join(tmpdir(), "npm-bundle-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "node_modules/npm/node_modules/package");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "__proto__", version: "1.0.0" }));
  await assert.rejects(() => readNpmBundle(root), /bundle changed/);
});

test("npm-only advisories cannot become regular dependency exceptions", () => {
  const now = new Date("2026-11-12T23:59:59Z");
  assert.doesNotThrow(() => validateNpmBundleAuditReport(approvedBundleReport, now));
  assert.throws(() => validateAuditReport(approvedBundleReport, now), /finding set changed/);
  assert.throws(() => validateNpmBundleAuditReport(approvedReport, now), /finding set changed/);
  for (const advisories of [[], [...approvedBundleReport.undici, { url: "https://github.com/advisories/GHSA-new" }],
    approvedBundleReport.undici.map(() => approvedBundleReport.undici[0])]) {
    assert.throws(() => validateNpmBundleAuditReport({ ...approvedBundleReport, undici: advisories }, now), /Unexpected|Unapproved/);
  }
  assert.throws(() => validateNpmBundleAuditReport(approvedBundleReport, new Date("2026-11-13T00:00:00Z")), /expired/);
});

test("rejects release changes that invalidate the npm exception", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const config = JSON.parse(readFileSync(new URL("../.releaserc.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateNpmReleaseBoundary(manifest, config));
  for (const changed of [{ ...manifest, private: false }, { ...manifest, workspaces: ["packages/*"] },
    ...["preversion", "version", "postversion"].map((name) => ({ ...manifest, scripts: { [name]: "unexpected" } }))]) {
    assert.throws(() => validateNpmReleaseBoundary(changed, config), /npm/);
  }
  for (const plugin of ["@semantic-release/npm", ["@semantic-release/npm", { npmPublish: true }],
    ["@semantic-release/npm", { npmPublish: false, tarballDir: "dist" }],
    ["@semantic-release/npm", { npmPublish: false, pkgRoot: "other" }]]) {
    assert.throws(() => validateNpmReleaseBoundary(manifest, { plugins: [plugin] }), /npm/);
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

test("installed official CJS/ESM tooling enforces resource budgets", async () => {
  for (const format of ["commonjs", "esm"]) {
    const { GlobWalker } = await import(`../node_modules/glob/dist/${format}/walker.js`);
    assert.doesNotThrow(() => validateGlobAbortHandling(GlobWalker));
    const { Minimatch } = await import(`../node_modules/minimatch/dist/${format}/index.js`);
    assert.doesNotThrow(() => validateMinimatchPatternLimit(Minimatch));
  }
});
