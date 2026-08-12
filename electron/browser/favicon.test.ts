import { describe, expect, test } from "bun:test";

import {
  fetchBrowserFavicon,
  selectBrowserFaviconCandidate,
} from "./favicon";

function png(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function dataUrl(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

describe("browser favicon validation", () => {
  test("canonicalizes a validated raster data URL", () => {
    const candidate = `data:image/png;charset=utf-8;base64,${encodeURIComponent(png().toString("base64"))}`;

    expect(selectBrowserFaviconCandidate([candidate])).toEqual({
      kind: "data",
      url: dataUrl("image/png", png()),
    });
  });

  test("rejects unsupported, malformed, animated, and oversized images without throwing", () => {
    const animatedPng = Buffer.concat([
      png(),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("acTL", "latin1"),
    ]);
    const malformedIco = Buffer.alloc(26);
    malformedIco.writeUInt16LE(1, 2);
    malformedIco.writeUInt16LE(1, 4);
    malformedIco[6] = 16;
    malformedIco[7] = 16;
    malformedIco.writeUInt32LE(4, 14);
    malformedIco.writeUInt32LE(22, 18);

    expect(() => selectBrowserFaviconCandidate([dataUrl("image/x-icon", malformedIco)])).not.toThrow();
    expect(
      selectBrowserFaviconCandidate([
        "data:image/svg+xml;base64,PHN2Zy8+",
        "data:image/png;base64,not-base64",
        dataUrl("image/png", animatedPng),
        dataUrl("image/png", png(513, 1)),
        dataUrl("image/x-icon", malformedIco),
      ]),
    ).toBeUndefined();
  });

  test("accepts at most sixteen kibibytes of decoded data URL image bytes", () => {
    const maximum = Buffer.alloc(16 * 1_024);
    png().copy(maximum);
    const overMaximum = Buffer.concat([maximum, Buffer.from([0])]);

    expect(selectBrowserFaviconCandidate([dataUrl("image/png", maximum)])).toEqual({
      kind: "data",
      url: dataUrl("image/png", maximum),
    });
    expect(selectBrowserFaviconCandidate([dataUrl("image/png", overMaximum)])).toBeUndefined();
  });

  test("rejects an ICO whose embedded bitmap has an overflowing unsigned width", () => {
    const icon = Buffer.alloc(34);
    icon.writeUInt16LE(1, 2);
    icon.writeUInt16LE(1, 4);
    icon[6] = 16;
    icon[7] = 16;
    icon.writeUInt32LE(12, 14);
    icon.writeUInt32LE(22, 18);
    icon.writeUInt32LE(0xffff_ffff, 26);
    icon.writeUInt32LE(32, 30);

    expect(selectBrowserFaviconCandidate([dataUrl("image/x-icon", icon)])).toBeUndefined();
  });

  test("does not halve a top-down ICO bitmap height", () => {
    const icon = Buffer.alloc(34);
    icon.writeUInt16LE(1, 2);
    icon.writeUInt16LE(1, 4);
    icon[6] = 16;
    icon[7] = 16;
    icon.writeUInt32LE(12, 14);
    icon.writeUInt32LE(22, 18);
    icon.writeUInt32LE(16, 26);
    icon.writeInt32LE(-1_000, 30);

    expect(selectBrowserFaviconCandidate([dataUrl("image/x-icon", icon)])).toBeUndefined();
  });

  test("takes the first policy-valid candidate and rejects embedded credentials", () => {
    expect(
      selectBrowserFaviconCandidate(
        [
          "https://user:password@example.test/favicon.png",
          "https://example.test/favicon.png",
          dataUrl("image/png", png()),
        ],
        "https://example.test",
      ),
    ).toEqual({ kind: "fetch", url: "https://example.test/favicon.png" });
  });
});

describe("browser favicon fetch", () => {
  test("treats a rejected request as a failed favicon", async () => {
    await expect(
      fetchBrowserFavicon(
        "http://127.0.0.1/favicon.png",
        {} as Electron.Session,
        new AbortController().signal,
        "http://127.0.0.1",
        async () => {
          throw new Error("request failed");
        },
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects credentialed and oversized redirect targets", async () => {
    const origin = "http://127.0.0.1";
    const signal = new AbortController().signal;
    const requests: string[] = [];
    const request = async (url: string) => {
      requests.push(url);
      return {
        kind: "redirect" as const,
        location:
          url.endsWith("credentials")
            ? "http://user:password@127.0.0.1/favicon.png"
            : `${origin}/${"x".repeat(8_192)}`,
      };
    };

    await expect(
      fetchBrowserFavicon(
        `${origin}/credentials`,
        {} as Electron.Session,
        signal,
        origin,
        request,
      ),
    ).resolves.toBeUndefined();
    await expect(
      fetchBrowserFavicon(
        `${origin}/oversized`,
        {} as Electron.Session,
        signal,
        origin,
        request,
      ),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([`${origin}/credentials`, `${origin}/oversized`]);
  });

  test("allows three redirects and rejects a fourth", async () => {
    const origin = "http://127.0.0.1";
    const icon = png();
    const request = async (url: string) => {
      const step = Number(new URL(url).pathname.slice(1));
      return step < 4
        ? { kind: "redirect" as const, location: `${origin}/${step + 1}` }
        : { kind: "bytes" as const, bytes: icon, mediaType: "image/png" };
    };

    await expect(
      fetchBrowserFavicon(
        `${origin}/1`,
        {} as Electron.Session,
        new AbortController().signal,
        origin,
        request,
      ),
    ).resolves.toBe(dataUrl("image/png", icon));

    const tooMany = async (url: string) => ({
      kind: "redirect" as const,
      location: `${origin}/${Number(new URL(url).pathname.slice(1)) + 1}`,
    });
    await expect(
      fetchBrowserFavicon(
        `${origin}/1`,
        {} as Electron.Session,
        new AbortController().signal,
        origin,
        tooMany,
      ),
    ).resolves.toBeUndefined();
  });
});
