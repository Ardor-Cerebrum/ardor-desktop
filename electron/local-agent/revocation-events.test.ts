import { describe, expect, test } from "bun:test";
import { CredentialRevocationEvents } from "./revocation-events.js";

const fatal = 'event: response.failed\r\ndata: {"type":"response.failed","response":{"error":{"code":"credential_session_revoked"}}}\r\n\r\n';

describe("credential revocation SSE events", () => {
  test("recognizes a typed data-only revocation from the native event bridge", () => {
    const events = new CredentialRevocationEvents();
    expect(events.push(new TextEncoder().encode('data: {"type":"response.failed","response":{"error":{"code":"credential_session_revoked"}}}\n\n'))).toBe(true);
  });

  test("recognizes a fragmented control event including split CRLF boundaries", () => {
    const events = new CredentialRevocationEvents();
    const bytes = new TextEncoder().encode(fatal);
    for (let index = 0; index < bytes.length - 1; index += 1) {
      expect(events.push(bytes.subarray(index, index + 1))).toBe(false);
    }
    expect(events.push(bytes.subarray(bytes.length - 1))).toBe(true);
  });

  test("assistant text and unrelated provider errors cannot revoke the session", () => {
    const events = new CredentialRevocationEvents();
    for (const data of [
      'data: {"type":"response.output_text.delta","delta":"credential_session_revoked"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"rate_limit"}}}\n\n',
      'event: response.failed\ndata: invalid-json\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.failed","response":{"error":{"code":"credential_session_revoked"}}}\n\n',
    ]) expect(events.push(new TextEncoder().encode(data))).toBe(false);
  });

  test("discards an oversized ordinary frame and still recognizes the next control event", () => {
    const events = new CredentialRevocationEvents();
    expect(events.push(new TextEncoder().encode(`data: ${"x".repeat(100_000)}\n\n`))).toBe(false);
    expect(events.push(new TextEncoder().encode(fatal))).toBe(true);
  });
});
