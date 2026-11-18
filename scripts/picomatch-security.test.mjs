import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateInstalledPicomatch, validateRepeatedExtglobs } from "./picomatch-security.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const copies = ["node_modules/picomatch", "node_modules/tinyglobby/node_modules/picomatch", "node_modules/npm/node_modules/tinyglobby/node_modules/picomatch"];

test("all installed copies preserve ordinary matching and bound hostile repeated extglobs", async () => {
  await validateInstalledPicomatch(root);
  for (const directory of copies) {
    const { default: pm } = await import(pathToFileURL(resolve(root, directory, "index.js")));
    for (const [pattern, input, expected] of [
      ["+(ab)", "abab", true], ["+(ab)", "aba", false],
      ["+(a|b)", "abba", true], ["@(*.js|*.ts)", "app.ts", true],
      ["+(\\*)", "***", true], ["+([*])", "***", true],
      ["src/**/*.ts", "src/main.js", false],
    ]) assert.equal(pm(pattern)(input), expected, `${directory}: ${pattern}`);
    for (const options of [{}, { dot: true }, { windows: true }, { bash: true }, { capture: true }]) {
      for (const [pattern, input] of [["a+(*)", "a"], ["a*(*)", "a.b"], ["a+(*)x", "a.x"]]) {
        assert.equal(pm(pattern, options)(input), true, `${directory}: ${pattern}`);
      }
      assert.equal(pm("+( *)", options)("abc"), false);
    }
    const result = spawnSync(process.execPath, ["-e", `
      const pm = require(${JSON.stringify(resolve(root, directory))});
      for (const pattern of ['+(*)x', '+(*a)b', '*(*a)b', '+(a*)b', '+([*a)b']) {
        if (pm(pattern)('a'.repeat(100000) + '!')) process.exit(1);
        if (pm(pattern)('[a'.repeat(10000) + '!')) process.exit(1);
      }
    `], { timeout: 3000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("the regression rejects every pristine parser after reversing its patch", async t => {
  const patches = ["picomatch@2.3.2", "picomatch@4.0.7", "npm@11.21.2"];
  for (const [index, directory] of copies.entries()) {
    const scratch = await mkdtemp(resolve(tmpdir(), "ard3833-baseline-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const packageDirectory = index === 2 ? resolve(scratch, "node_modules/tinyglobby/node_modules/picomatch") : scratch;
    await cp(resolve(root, directory), packageDirectory, { recursive: true });
    const reversed = spawnSync("git", ["apply", "--reverse", resolve(root, `patches/${patches[index]}.patch`)], {
      cwd: scratch, encoding: "utf8", timeout: 3000,
    });
    assert.equal(reversed.status, 0, reversed.stderr);
    const { default: pm } = await import(pathToFileURL(resolve(packageDirectory, "index.js")));
    assert.throws(() => validateRepeatedExtglobs(pm), /unsafe repeated extglob/);
  }
});

test("patch verification rejects either missing or altered installed parser", async t => {
  const scratch = await mkdtemp(resolve(tmpdir(), "ard3833-integrity-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await assert.rejects(validateInstalledPicomatch(scratch), /ENOENT/);
  for (const directory of copies) await cp(resolve(root, directory), resolve(scratch, directory), { recursive: true });
  for (const directory of copies) {
    const path = resolve(scratch, directory, "lib/parse.js");
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("\n// changed\n")]));
    await assert.rejects(validateInstalledPicomatch(scratch), /patch missing or changed/);
    await writeFile(path, original);
  }
});
