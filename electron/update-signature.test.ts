import { describe, expect, test } from "bun:test";

import {
  createSignedUpdateEnvelope,
  deriveEd25519PublicKey,
  verifySignedUpdateEnvelope,
} from "./update-signature";

const PRIVATE_SEED = Buffer.alloc(32, 7).toString("base64");

describe("desktop update signatures", () => {
  test("round-trips an Ed25519-signed payload", () => {
    const payload = Buffer.from('{"version":"1.2.3"}');
    const envelope = createSignedUpdateEnvelope(payload, PRIVATE_SEED);

    expect(
      Buffer.from(verifySignedUpdateEnvelope(envelope, deriveEd25519PublicKey(PRIVATE_SEED))).toString("utf8"),
    ).toBe(payload.toString("utf8"));
  });

  test("rejects modified payloads and malformed key material", () => {
    const envelope = createSignedUpdateEnvelope(Buffer.from("trusted"), PRIVATE_SEED);
    expect(() =>
      verifySignedUpdateEnvelope(
        { ...envelope, payload: Buffer.from("modified").toString("base64") },
        deriveEd25519PublicKey(PRIVATE_SEED),
      ),
    ).toThrow("signature is invalid");
    expect(() => deriveEd25519PublicKey("bad")).toThrow("valid base64");
  });
});
