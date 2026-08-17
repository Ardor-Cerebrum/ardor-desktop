import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { deriveEd25519PublicKey } from "../electron/update-signature";

const privateKeyPath = requiredOption("--private-key-file");
const expectedPublicKey = requiredOption("--public-key");
const privateSeed = (await readFile(resolve(privateKeyPath), "utf8")).trim();
if (deriveEd25519PublicKey(privateSeed) !== expectedPublicKey) {
  throw new Error("Electron update private key does not match its configured public key");
}

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
