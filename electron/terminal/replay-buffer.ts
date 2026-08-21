import {
  isWellFormedString,
  takeUtf8Tail,
  TERMINAL_LIMITS,
  utf8ByteLength,
  type TerminalReplayChunk,
} from "./protocol.js";

export interface TerminalReplaySnapshot {
  readonly bytes: number;
  readonly chunks: readonly TerminalReplayChunk[];
  readonly sequence: number;
  readonly truncated: boolean;
}

export class TerminalReplayBuffer {
  private bytes = 0;
  private readonly chunks: TerminalReplayChunk[] = [];
  private sequence = 0;
  private truncated = false;

  constructor(private readonly maxBytes = TERMINAL_LIMITS.REPLAY_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
  }

  append(sequence: number, data: string): void {
    if (!isWellFormedString(data) || data.length === 0) {
      throw new TypeError("data must be a non-empty well-formed UTF-16 string");
    }
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence <= this.sequence) {
      throw new RangeError("sequence must be a strictly increasing positive safe integer");
    }

    const bytes = utf8ByteLength(data);
    if (bytes > this.maxBytes) {
      const tail = takeUtf8Tail(data, this.maxBytes).value;
      this.chunks.length = 0;
      this.bytes = 0;
      if (tail.length > 0) {
        this.chunks.push({ data: tail, sequence });
        this.bytes = utf8ByteLength(tail);
      }
      this.sequence = sequence;
      this.truncated = true;
      return;
    }

    this.chunks.push({ data, sequence });
    this.bytes += bytes;
    this.sequence = sequence;

    while (this.bytes > this.maxBytes) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.bytes -= utf8ByteLength(removed.data);
      this.truncated = true;
    }
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
    this.truncated = false;
  }

  snapshot(): TerminalReplaySnapshot {
    const chunks = Object.freeze(this.chunks.map((chunk) => Object.freeze({ ...chunk })));
    return Object.freeze({
      bytes: this.bytes,
      chunks,
      sequence: this.sequence,
      truncated: this.truncated,
    });
  }
}
