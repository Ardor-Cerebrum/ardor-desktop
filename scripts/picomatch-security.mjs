import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// SECURITY(ARD-3833): preserve the 2.x/4.x consumer versions. npm bundles its
// own 4.0.4 copy, unaffected by ordinary overrides. Bun applies all three patches;
// a version-only registry advisory is accepted only after these files verify.
// Remove the patches and finding allowance after a verified official fix.
const PATCHED_PARSERS = [
  ["node_modules/picomatch", "ee5a8de45f0a2cd6e7753804827d61f50831c04b03959d04ff55b85e482a587d"],
  ["node_modules/tinyglobby/node_modules/picomatch", "55ab56e0ff40e9bd5d7a15180ffb9d791a267dd56b1fd0b38ac23aa00dab9199"],
  ["node_modules/npm/node_modules/tinyglobby/node_modules/picomatch", "d10ae773f978c2130cd565e5e69b9316edc11900bc4bdb4f93bceaf928d83d9f"],
];

export async function validateInstalledPicomatch(root) {
  for (const [directory, expectedHash] of PATCHED_PARSERS) {
    const source = await readFile(resolve(root, directory, "lib/parse.js"));
    if (createHash("sha256").update(source).digest("hex") !== expectedHash) {
      throw new Error(`picomatch security patch missing or changed: ${directory}`);
    }
    const { default: picomatch } = await import(pathToFileURL(resolve(root, directory, "index.js")));
    validateRepeatedExtglobs(picomatch);
  }
}

// Check semantics before evaluating long input: an unpatched parser fails this
// small probe immediately, without executing its exponentially growing regex.
export function validateRepeatedExtglobs(picomatch) {
  for (const pattern of ["+(*a)b", "*(*a)b", "+(a*)b"]) {
    const matcher = picomatch(pattern);
    if (!matcher(pattern) || matcher("aaaab")) {
      throw new Error(`picomatch accepts an unsafe repeated extglob: ${pattern}`);
    }
  }
  for (const [pattern, input] of [["+(*)x", "aaaax"], ["+(ab)", "abab"], ["src/**/*.ts", "src/app/main.ts"], ["*.{js,ts}", "app.ts"]]) {
    if (!picomatch(pattern)(input)) throw new Error(`picomatch changed ordinary matching: ${pattern}`);
  }
}
