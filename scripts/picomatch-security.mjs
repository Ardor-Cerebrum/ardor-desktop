import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// SECURITY(ARD-3833): preserve the 2.x/4.x consumer versions. npm bundles its
// own 4.0.4 copy, unaffected by ordinary overrides. Bun applies all three patches;
// a version-only registry advisory is accepted only after these files verify.
// Remove the patches and finding allowance after a verified official fix.
const PATCHED_PARSERS = [
  ["node_modules/picomatch", "b735c739dedc237573adf00131c8c376c48ae0b41c125b8fcad04899a9bae64d"],
  ["node_modules/tinyglobby/node_modules/picomatch", "6e1d8eda3eb17aafeff86cdb11fab2b01fbe1da03fecb150636a9e13064fc5c9"],
  ["node_modules/npm/node_modules/tinyglobby/node_modules/picomatch", "762ce88688b7b99b34c20edaf7e1e90de2e04ac42e62dbc856fae5958d006ded"],
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
