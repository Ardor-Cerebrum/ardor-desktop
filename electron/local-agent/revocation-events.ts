const MAX_EVENT_BYTES = 64 * 1024;

/** Inspect bounded SSE control frames without interpreting assistant output as authority. */
export class CredentialRevocationEvents {
  revocationEndOffset: number | null = null;
  private line: number[] = [];
  private event = "";
  private data: string[] = [];
  private bytes = 0;
  private discarded = false;
  private lineLength = 0;
  private lastByte = 0;

  push(chunk: Uint8Array): boolean {
    this.revocationEndOffset = null;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const byte = chunk[offset];
      if (byte === undefined) continue;
      if (byte !== 10) {
        this.lineLength += 1;
        this.lastByte = byte;
        this.bytes += 1;
        if (this.bytes > MAX_EVENT_BYTES) {
          this.discarded = true;
          this.line = [];
          this.data = [];
        }
        if (!this.discarded) this.line.push(byte);
        continue;
      }
      const line = new TextDecoder().decode(new Uint8Array(this.line)).replace(/\r$/, "");
      // Even an oversized frame must retain its line boundary, so the next
      // independent server control frame is still inspected.
      const blank = this.lineLength === 0 || (this.lineLength === 1 && this.lastByte === 13);
      this.lineLength = 0;
      this.line = [];
      if (blank) {
        const revoked = !this.discarded && (this.event === "" || this.event === "response.failed") &&
          isRevocation(this.data.join("\n"));
        this.event = "";
        this.data = [];
        this.bytes = 0;
        this.discarded = false;
        if (revoked) {
          this.revocationEndOffset = offset + 1;
          return true;
        }
      } else if (!this.discarded) {
        if (line.startsWith("event:")) this.event = line.slice(6).replace(/^ /, "");
        if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return false;
  }
}

function isRevocation(data: string): boolean {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return false; }
  return isRecord(value) && value.type === "response.failed" && isRecord(value.response) &&
    isRecord(value.response.error) && value.response.error.code === "credential_session_revoked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
