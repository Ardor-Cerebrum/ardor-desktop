import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// SECURITY(ARD-3833): preserve the 2.x/4.x consumer versions. npm bundles its
// own 4.0.4 copy, unaffected by ordinary overrides. Bun applies all three patches;
// a version-only registry advisory is accepted only after these files verify.
// Remove the patches and finding allowance after a verified official fix.
const PATCHED_PARSERS = [
  ["node_modules/picomatch", "cadbeb0490f2d87006a26bc736f95ddf29c591afb2224883e86e0015d86fe5a3"],
  ["node_modules/tinyglobby/node_modules/picomatch", "6a81bb5b2724f19198f69b471a90de2e74cd3289209a0d02fc312750d4cd690f"],
  ["node_modules/npm/node_modules/tinyglobby/node_modules/picomatch", "e72d761ebdfac3a89cd4af8d9d404ab16abb758c358a52f6df38044d07a863d7"],
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
  if (picomatch("+([*a)b")("[aaaab")) {
    throw new Error("picomatch accepts an unsafe repeated extglob with an unclosed class");
  }
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
