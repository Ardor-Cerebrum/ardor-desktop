import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AUDIT_REVIEW_DATE = "2026-11-13";

// SECURITY: Forge 8 replaces extract-zip and the old Universal minimatch.
// npm still bundles glob 13/minimatch 10/undici 6.29.0; the existing npm patch
// stays unchanged until official npm releases contain the upstream fixes.
// Registry overrides do not replace those bundled files, so retain installed
// CommonJS/ESM behavioral checks. No new patches without explicit approval.
// The remaining minimatch finding also includes build-only v3, which predates
// the affected optimizer. Keep exact dependency paths and the existing deadline.
const APPROVED_ADVISORIES = new Map([
  ["minimatch", new Set(["https://github.com/advisories/GHSA-g3hv-75wg-m249"])],
]);

// SECURITY: Preserve the exact build/release-only consumers even after findings
// disappear from the registry. None of these packages may enter the app archive.
const REVIEWED_TOOLING = new Map([
  ["glob", {
    entries: [
      ["glob", "glob@14.0.2"],
      ["commitizen/glob", "glob@7.2.3"],
      ["npm/glob", "glob@14.0.2"],
      ["rimraf/glob", "glob@7.2.3"],
      ["electron-winstaller/@electron/asar/glob", "glob@7.2.3"],
    ],
    consumers: [
      ["@electron/asar", "@electron/asar@4.3.1", "^13.0.2"],
      ["commitizen", "commitizen@4.3.2", "7.2.3"],
      ["npm", "npm@11.21.1", "^13.0.6"],
      ["rimraf", "rimraf@2.6.3", "^7.1.3"],
      ["electron-winstaller/@electron/asar", "@electron/asar@3.4.1", "^7.1.6"],
      ["npm/@npmcli/map-workspaces", "@npmcli/map-workspaces@5.0.3", "^13.0.0"],
      ["npm/@npmcli/package-json", "@npmcli/package-json@7.0.5", "^13.0.0"],
      ["npm/cacache", "cacache@20.0.4", "^13.0.0"],
    ],
  }],
  ["minimatch", {
    entries: [
      ["minimatch", "minimatch@11.0.3"],
      ["npm/minimatch", "minimatch@11.0.3"],
      ["commitizen/glob/minimatch", "minimatch@3.1.5"],
      ["electron-winstaller/@electron/asar/minimatch", "minimatch@3.1.5"],
      ["rimraf/glob/minimatch", "minimatch@3.1.5"],
    ],
    consumers: [
      ["@electron/asar", "@electron/asar@4.3.1", "^10.0.1"],
      ["glob", "glob@14.0.2", "^11.0.0"],
      ["npm", "npm@11.21.1", "^10.2.5"],
      ["commitizen/glob", "glob@7.2.3", "^3.1.1"],
      ["electron-winstaller/@electron/asar", "@electron/asar@3.4.1", "^3.0.4"],
      ["npm/@npmcli/arborist", "@npmcli/arborist@9.9.3", "^10.0.3"],
      ["npm/@npmcli/map-workspaces", "@npmcli/map-workspaces@5.0.3", "^10.0.3"],
      ["npm/@tufjs/models", "@tufjs/models@4.1.0", "^10.1.1"],
      ["npm/glob", "glob@14.0.2", "^11.0.0"],
      ["npm/ignore-walk", "ignore-walk@8.0.0", "^10.0.3"],
      ["npm/libnpmdiff", "libnpmdiff@8.1.14", "^10.0.3"],
      ["rimraf/glob", "glob@7.2.3", "^3.1.1"],
      ["electron-winstaller/@electron/asar/glob", "glob@7.2.3", "^3.1.1"],
    ],
  }],
  ["braces", {
    entries: [
      ["braces", "braces@3.0.3"],
    ],
    consumers: [
      ["micromatch", "micromatch@4.0.8", "^3.0.3"],
    ],
  }],
  ["http-cache-semantics", {
    entries: [
      ["npm/http-cache-semantics", "http-cache-semantics@4.3.0"],
    ],
    consumers: [
      ["npm/make-fetch-happen", "make-fetch-happen@15.0.6", "^4.1.1"],
    ],
  }],
  ["npm", {
    entries: [
      ["npm", "npm@11.21.1"],
    ],
    consumers: [
      ["@semantic-release/npm", "@semantic-release/npm@13.2.0", "^11.6.2"],
    ],
  }],
  ["postcss-selector-parser", {
    entries: [
      ["npm/postcss-selector-parser", "postcss-selector-parser@7.1.7"],
    ],
    consumers: [
      ["npm/@npmcli/query", "@npmcli/query@5.0.0", "^7.0.0"],
    ],
  }],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateAuditReport(report, now = new Date()) {
  invariant(now instanceof Date && !Number.isNaN(now.valueOf()), "Invalid audit validation date");
  invariant(
    now.toISOString().slice(0, 10) < AUDIT_REVIEW_DATE,
    `The dependency exception expired on ${AUDIT_REVIEW_DATE}; review upstream before extending it`,
  );
  invariant(report && typeof report === "object" && !Array.isArray(report), "Audit output must be an object");

  const packageNames = Object.keys(report);
  invariant(
    packageNames.length === APPROVED_ADVISORIES.size && packageNames.every((name) => APPROVED_ADVISORIES.has(name)),
    "The dependency audit finding set changed; review the exception",
  );
  for (const [name, approved] of APPROVED_ADVISORIES) {
    const advisories = report[name];
    invariant(Array.isArray(advisories) && advisories.length === approved.size, `Unexpected ${name} advisory set`);
    invariant(
      advisories.every((advisory) => approved.has(advisory?.url)) &&
        new Set(advisories.map((advisory) => advisory.url)).size === approved.size,
      `Unapproved ${name} advisory set`,
    );
  }
}

export function validateGlobAbortHandling(GlobWalker) {
  const message = "Installed glob continues traversal after abort; reapply the reviewed patch";
  for (const method of ["walkCB", "walkCB2", "walkCBSync", "walkCB2Sync"]) {
    const walker = new GlobWalker([], null, { signal: AbortSignal.abort() });
    let callbacks = 0;
    const done = () => {
      callbacks++;
    };
    const processor = { processPatterns() { throw new Error(message); } };
    try {
      if (method === "walkCB2" || method === "walkCB2Sync") {
        walker[method](null, [], processor, done);
      } else {
        walker[method](null, [], done);
      }
    } catch {
      throw new Error(message);
    }
    invariant(callbacks === 1, message);
  }
}

export function validateMinimatchPatternLimit(Minimatch) {
  const matcher = new Minimatch("x", { optimizationLevel: 0, braceExpandMax: 2 });
  const pattern = () => ["**", "..", "a", "b"];
  const expanded = matcher.firstPhasePreProcess([pattern()]);
  invariant(expanded.length === 2, "Installed minimatch no longer preserves ordinary pattern expansion");
  const capped = matcher.firstPhasePreProcess([pattern(), ["x"]]);
  invariant(capped.length === 2, "Installed minimatch has unbounded pattern expansion; reapply the reviewed patch");
  const oversized = matcher.firstPhasePreProcess([pattern(), ["x"], ["y"]]);
  invariant(oversized.length === 3, "Installed minimatch expands an already over-budget pattern set");

  let comparisons = 0;
  matcher.partsMatch = () => {
    comparisons++;
    return false;
  };
  matcher.secondPhasePreProcess(Array.from({ length: 1000 }, () => ["x"]));
  invariant(comparisons > 0, "Installed minimatch disabled ordinary preprocessing");
  const largeSet = Array.from({ length: 1001 }, () => ["x"]);
  matcher.partsMatch = () => {
    throw new Error("Installed minimatch performs quadratic comparisons; reapply the reviewed patch");
  };
  invariant(matcher.secondPhasePreProcess(largeSet) === largeSet, "Installed minimatch changed the bounded preprocessing contract");
}

async function validateInstalledGlobPatches(root) {
  for (const packagePath of ["node_modules", "node_modules/npm/node_modules"]) {
    for (const format of ["commonjs", "esm"]) {
      const { GlobWalker } = await import(pathToFileURL(resolve(root, `${packagePath}/glob/dist/${format}/walker.js`)));
      validateGlobAbortHandling(GlobWalker);
      const { Minimatch } = await import(pathToFileURL(resolve(root, `${packagePath}/minimatch/dist/${format}/index.js`)));
      validateMinimatchPatternLimit(Minimatch);
    }
  }
}

export function validateBundledNpmUndici(packageJson) {
  invariant(
    packageJson && typeof packageJson === "object" && !Array.isArray(packageJson) &&
      packageJson.name === "undici" && packageJson.version === "6.29.1",
    "npm's installed undici bundle does not match the reviewed 6.29.1 patch",
  );
}

export function validateDependencyBoundary(packageJson, lockfile) {
  invariant(packageJson && typeof packageJson === "object", "package.json must be an object");
  invariant(typeof lockfile === "string", "bun.lock must be text");
  invariant(packageJson.devDependencies?.["@electron-forge/cli"], "Electron Forge must remain a dev dependency");
  invariant(!packageJson.dependencies?.["@electron-forge/cli"], "Electron Forge must not be a runtime dependency");
  validateToolingBoundary(packageJson, lockfile);
}

function validateToolingBoundary(packageJson, lockfile) {
  const packages = parseLockfilePackages(lockfile);
  for (const [name, reviewed] of REVIEWED_TOOLING) {
    invariant(
      !packageJson.dependencies?.[name] &&
        !packageJson.devDependencies?.[name] &&
        !packageJson.optionalDependencies?.[name],
      `${name} must remain transitive`,
    );
    const entries = [];
    const consumers = [];
    for (const [key, { identity, metadata }] of packages) {
      if (identity.startsWith(`${name}@`)) entries.push([key, identity]);
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const range = metadata?.[field]?.[name];
        if (!range) continue;
        invariant(field === "dependencies", `${name} dependency kind changed; review the exception`);
        consumers.push([key, identity, range]);
      }
    }
    invariant(JSON.stringify(entries) === JSON.stringify(reviewed.entries), `${name} versions or copies changed; review the exception`);
    invariant(JSON.stringify(consumers) === JSON.stringify(reviewed.consumers), `${name} dependency paths changed; review the exception`);
  }
  validateRuntimeDependencies(packageJson, packages);
}

function validateRuntimeDependencies(packageJson, packages) {
  const runtimeRoots = Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies });
  const pending = runtimeRoots.map((name) => resolveDependency(packages, "", name));
  const reviewedNames = [...APPROVED_ADVISORIES.keys(), ...REVIEWED_TOOLING.keys()];
  const visited = new Set();
  while (pending.length > 0) {
    const key = pending.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    const { identity, metadata } = packages.get(key);
    invariant(
      !reviewedNames.some((name) => identity.startsWith(`${name}@`)),
      `${identity} entered the runtime dependency graph`,
    );
    const requiredPeers = Object.fromEntries(
      Object.entries(metadata?.peerDependencies ?? {})
        .filter(([name]) => !metadata.optionalPeers?.includes(name)),
    );
    const dependencies = { ...requiredPeers, ...metadata?.dependencies, ...metadata?.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      pending.push(resolveDependency(packages, key, name));
    }
  }
}

function parseLockfilePackages(lockfile) {
  // Bun's text lockfile stores each package tuple on one line. Parse the tuples
  // as JSON so scoped/nested package identities and dependency edges stay intact.
  const packages = new Map();
  for (const [, key, tuple] of lockfile.matchAll(/^\s*"([^"]+)": (\[.*\]),?\s*$/gm)) {
    invariant(!packages.has(key), "Duplicate lockfile package; review the exception");
    const [identity, sourceOrMetadata, metadata] = JSON.parse(tuple);
    invariant(typeof identity === "string", "Invalid lockfile package identity");
    packages.set(key, {
      identity,
      metadata: typeof sourceOrMetadata === "object" ? sourceOrMetadata : metadata,
    });
  }
  const tupleCount = [...lockfile.matchAll(/^\s*"[^"]+":\s*\[/gm)].length;
  invariant(packages.size === tupleCount, "Unsupported lockfile package format; review the exception");
  return packages;
}

function resolveDependency(packages, parent, name) {
  const ancestors = parent.match(/(?:@[^/]+\/)?[^/]+/g) ?? [];
  while (ancestors.length > 0) {
    const candidate = `${ancestors.join("/")}/${name}`;
    if (packages.has(candidate)) return candidate;
    ancestors.pop();
  }
  invariant(packages.has(name), `Cannot resolve runtime dependency ${name}; review the exception`);
  return name;
}

function runAudit() {
  const result = spawnSync(process.execPath, ["audit", "--json"], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  invariant(result.status === 0 || result.status === 1, `bun audit failed: ${result.stderr.trim()}`);

  const output = result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const jsonStart = output.indexOf("{");
  invariant(jsonStart >= 0, "bun audit did not return JSON findings");
  return JSON.parse(output.slice(jsonStart));
}

export async function main({ now = new Date() } = {}) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const [packageText, lockfile, bundledUndici] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "bun.lock"), "utf8"),
    readFile(resolve(root, "node_modules/npm/node_modules/undici/package.json"), "utf8"),
  ]);
  validateAuditReport(runAudit(), now);
  validateDependencyBoundary(JSON.parse(packageText), lockfile);
  validateBundledNpmUndici(JSON.parse(bundledUndici));
  await validateInstalledGlobPatches(root);
  console.log(`Dependency audit passed with ${APPROVED_ADVISORIES.size} reviewed build-only exceptions; review before ${AUDIT_REVIEW_DATE}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
