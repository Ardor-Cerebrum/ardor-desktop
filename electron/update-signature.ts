import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const ED25519_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PRIVATE_KEY_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SignedUpdateEnvelope {
  payload: string;
  signature: string;
}

export function createSignedUpdateEnvelope(payload: Uint8Array, privateSeed: string): SignedUpdateEnvelope {
  const payloadBuffer = Buffer.from(payload);
  const privateKey = decodeFixedBase64(privateSeed, 32, "Ed25519 private seed");
  const key = createPrivateKey({
    format: "der",
    key: Buffer.concat([ED25519_PRIVATE_KEY_PREFIX, privateKey]),
    type: "pkcs8",
  });
  return {
    payload: payloadBuffer.toString("base64"),
    signature: sign(null, payloadBuffer, key).toString("base64"),
  };
}

export function verifySignedUpdateEnvelope(
  value: unknown,
  publicKey: string,
): Uint8Array {
  if (!value || typeof value !== "object") {
    throw new Error("update metadata envelope is invalid");
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
    throw new Error("update metadata envelope is invalid");
  }

  const payload = decodeBase64(envelope.payload, "update metadata payload");
  const signature = decodeFixedBase64(envelope.signature, 64, "update metadata signature");
  const rawPublicKey = decodeFixedBase64(publicKey, 32, "Ed25519 public key");
  const key = createPublicKey({
    format: "der",
    key: Buffer.concat([ED25519_PUBLIC_KEY_PREFIX, rawPublicKey]),
    type: "spki",
  });
  if (!verify(null, payload, key, signature)) {
    throw new Error("update metadata signature is invalid");
  }
  return payload;
}

export function deriveEd25519PublicKey(privateSeed: string): string {
  const seed = decodeFixedBase64(privateSeed, 32, "Ed25519 private seed");
  const privateKey = createPrivateKey({
    format: "der",
    key: Buffer.concat([ED25519_PRIVATE_KEY_PREFIX, seed]),
    type: "pkcs8",
  });
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(publicDer).subarray(-32).toString("base64");
}

function decodeFixedBase64(value: string, length: number, label: string): Buffer {
  const decoded = decodeBase64(value, label);
  if (decoded.byteLength !== length) {
    throw new Error(`${label} must contain exactly ${length} bytes`);
  }
  return decoded;
}

function decodeBase64(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}
