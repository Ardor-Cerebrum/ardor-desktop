import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AUDIT_REVIEW_DATE = "2026-10-14";

// SECURITY: Both unpatched symlink findings are limited to Packager's build-time
// Electron ZIP extraction, not user archives or the shipped runtime. Keep the
// exact dependency boundary and existing review deadline below.
// Reviewed 2026-09-14: extract-zip 2.0.1 is still the latest release, neither
// advisory lists a patched version, and @electron/packager still depends on
// ^2.0.0, so the exception is extended by a month rather than resolved.
const APPROVED_ADVISORIES = new Map([
  ["extract-zip", new Set([
    "https://github.com/advisories/GHSA-jmr9-qjv8-65gv",
    "https://github.com/advisories/GHSA-7pqw-9j4j-h8q3",
  ])],
  ["braces", new Set(["https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"])],
  ["http-cache-semantics", new Set(["https://github.com/advisories/GHSA-ch52-4w7c-c8xp"])],
]);

// SECURITY(ARD-3167): Reviewed 2026-10-03; neither advisory has a patched release.
// braces receives repository-controlled build/release globs. HTTP caching is
// disabled in Electron's got downloader and private in make-fetch-happen.
// Keep these exact consumers outside the runtime graph and packaged archive.
// Remove these exceptions when upstream fixes ship; review by AUDIT_REVIEW_DATE.
const REVIEWED_TOOLING = new Map([
  ["braces", {
    entries: [["braces", "braces@3.0.3"]],
    consumers: [["micromatch", "micromatch@4.0.8", "^3.0.3"]],
  }],
  ["http-cache-semantics", {
    entries: [
      ["http-cache-semantics", "http-cache-semantics@4.2.0"],
      ["npm/http-cache-semantics", "http-cache-semantics@4.2.0"],
    ],
    consumers: [
      ["cacheable-request", "cacheable-request@7.0.4", "^4.0.0"],
      ["make-fetch-happen", "make-fetch-happen@10.2.1", "^4.1.0"],
      ["npm/make-fetch-happen", "make-fetch-happen@15.0.6", "^4.1.1"],
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

export function validateDependencyBoundary(packageJson, lockfile) {
  invariant(packageJson && typeof packageJson === "object", "package.json must be an object");
  invariant(typeof lockfile === "string", "bun.lock must be text");
  invariant(packageJson.devDependencies?.["@electron-forge/cli"], "Electron Forge must remain a dev dependency");
  invariant(!packageJson.dependencies?.["@electron-forge/cli"], "Electron Forge must not be a runtime dependency");
  invariant(
    !packageJson.dependencies?.["extract-zip"] && !packageJson.devDependencies?.["extract-zip"],
    "extract-zip must remain transitive",
  );
  invariant(
    /"@electron\/packager": \["@electron\/packager@18\.4\.4"/.test(lockfile),
    "Electron Packager version changed; review the exception",
  );
  invariant(/"extract-zip": \["extract-zip@2\.0\.1"/.test(lockfile), "extract-zip version changed");

  const extractZipReferences = [...lockfile.matchAll(/"extract-zip": "([^"]+)"/g)].map((match) => match[1]);
  invariant(
    JSON.stringify(extractZipReferences) === JSON.stringify(["^2.0.0", "cli.js"]),
    "extract-zip dependency path changed; review the exception",
  );
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
  const reviewedNames = [...APPROVED_ADVISORIES.keys()];
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
  const [packageText, lockfile] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "bun.lock"), "utf8"),
  ]);
  validateAuditReport(runAudit(), now);
  validateDependencyBoundary(JSON.parse(packageText), lockfile);
  console.log(`Dependency audit passed with ${APPROVED_ADVISORIES.size} reviewed build-only exceptions; review before ${AUDIT_REVIEW_DATE}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
