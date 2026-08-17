import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { deriveEd25519PublicKey } from "../electron/update-signature";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
if (!output || process.argv.length !== 4) {
  throw new Error("Usage: bun scripts/generate-electron-update-key.ts --output <private-key-file>");
}

const privateSeed = randomBytes(32).toString("base64");
const outputPath = resolve(output);
await writeFile(outputPath, `${privateSeed}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(deriveEd25519PublicKey(privateSeed));
