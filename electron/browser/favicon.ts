import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

import type { ClientRequest, ClientRequestConstructorOptions, Session } from "electron";

import { isPublicBrowserUrl } from "./security";

const MAX_FAVICON_URL_LENGTH = 8_192;
const MAX_FAVICON_BYTES = 16 * 1_024;
const MAX_DATA_URL_LENGTH = Math.ceil((MAX_FAVICON_BYTES * 4) / 3) + 64;
const MAX_FAVICON_DIMENSION = 512;
const MAX_REDIRECTS = 3;
const DNS_TIMEOUT_MS = 2_000;

export const FAVICON_FETCH_TIMEOUT_MS = 5_000;

const SUPPORTED_FAVICON_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export type BrowserFaviconCandidate =
  | { kind: "data"; url: string }
  | { kind: "fetch"; url: string };

interface ImageDimensions {
  width: number;
  height: number;
}

interface FaviconBytes {
  bytes: Buffer;
  mediaType: string;
}

export type BrowserFaviconRequestResult =
  | ({ kind: "bytes" } & FaviconBytes)
  | { kind: "redirect"; location: string };

export type BrowserFaviconRequest = (
  url: string,
  browserSession: Session,
  signal: AbortSignal,
) => Promise<BrowserFaviconRequestResult | undefined>;

export type BrowserFaviconRequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;

function readUint16Be(bytes: Buffer, offset: number): number | undefined {
  return offset + 2 <= bytes.length ? bytes.readUInt16BE(offset) : undefined;
}

function readUint16Le(bytes: Buffer, offset: number): number | undefined {
  return offset + 2 <= bytes.length ? bytes.readUInt16LE(offset) : undefined;
}

function readUint32Be(bytes: Buffer, offset: number): number | undefined {
  return offset + 4 <= bytes.length ? bytes.readUInt32BE(offset) : undefined;
}

function readUint32Le(bytes: Buffer, offset: number): number | undefined {
  return offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : undefined;
}

function readPngDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x8950_4e47) return undefined;
  const width = readUint32Be(bytes, 16);
  const height = readUint32Be(bytes, 20);
  if (width === undefined || height === undefined) return undefined;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("latin1", offset + 4, offset + 8);
    if (chunkType === "acTL") return undefined;
    if (chunkType === "IDAT" || chunkType === "IEND") break;
    offset += 12 + chunkLength;
  }
  return { width, height };
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;

    const segmentLength = readUint16Be(bytes, offset);
    if (segmentLength === undefined || segmentLength < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = readUint16Be(bytes, offset + 3);
      const width = readUint16Be(bytes, offset + 5);
      return width !== undefined && height !== undefined ? { width, height } : undefined;
    }
    offset += segmentLength;
  }
  return undefined;
}

function readGifDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 13 || bytes.toString("latin1", 0, 4) !== "GIF8") return undefined;
  const canvasWidth = readUint16Le(bytes, 6);
  const canvasHeight = readUint16Le(bytes, 8);
  const packed = bytes[10];
  if (canvasWidth === undefined || canvasHeight === undefined || packed === undefined) return undefined;

  let offset = 13;
  if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
  let dimensions: ImageDimensions | undefined;
  while (offset < bytes.length) {
    const blockType = bytes[offset];
    if (blockType === 0x2c) {
      if (dimensions) return undefined;
      const left = readUint16Le(bytes, offset + 1);
      const top = readUint16Le(bytes, offset + 3);
      const width = readUint16Le(bytes, offset + 5);
      const height = readUint16Le(bytes, offset + 7);
      const imagePacked = bytes[offset + 9];
      if (
        left === undefined ||
        top === undefined ||
        width === undefined ||
        height === undefined ||
        imagePacked === undefined
      ) {
        return undefined;
      }
      dimensions = {
        width: Math.max(canvasWidth, left + width),
        height: Math.max(canvasHeight, top + height),
      };
      offset += 10;
      if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
      offset += 1;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset];
      offset += 1;
      continue;
    }
    if (blockType === 0x21) {
      offset += 2;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset];
      if (offset >= bytes.length) return dimensions;
      offset += 1;
      continue;
    }
    return blockType === 0x3b ? dimensions : undefined;
  }
  return dimensions;
}

function readWebpDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (
    bytes.length < 30 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return undefined;
  }
  const chunkType = bytes.toString("latin1", 12, 16);
  if (chunkType === "VP8X") {
    if (bytes[20] & 0x02) return undefined;
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  if (chunkType === "VP8 ") {
    const width = readUint16Le(bytes, 26);
    const height = readUint16Le(bytes, 28);
    return width !== undefined && height !== undefined
      ? { width: width & 0x3fff, height: height & 0x3fff }
      : undefined;
  }
  if (chunkType === "VP8L") {
    const bits = readUint32Le(bytes, 21);
    return bits === undefined
      ? undefined
      : { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return undefined;
}

function readBmpDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 26 || bytes.toString("latin1", 0, 2) !== "BM") return undefined;
  const width = readUint32Le(bytes, 18);
  const height = readUint32Le(bytes, 22);
  return width === undefined || height === undefined
    ? undefined
    : { width, height: Math.abs(height | 0) };
}

function readIcoDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 6 || readUint16Le(bytes, 0) !== 0 || readUint16Le(bytes, 2) !== 1) {
    return undefined;
  }
  const imageCount = readUint16Le(bytes, 4);
  if (!imageCount) return undefined;

  let dimension = 0;
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16;
    if (entryOffset + 16 > bytes.length) return undefined;
    const entryWidth = bytes[entryOffset] === 0 ? 256 : bytes[entryOffset];
    const entryHeight = bytes[entryOffset + 1] === 0 ? 256 : bytes[entryOffset + 1];
    dimension = Math.max(dimension, entryWidth, entryHeight);

    const byteLength = readUint32Le(bytes, entryOffset + 8);
    const imageOffset = readUint32Le(bytes, entryOffset + 12);
    if (
      byteLength === undefined ||
      imageOffset === undefined ||
      imageOffset + byteLength > bytes.length ||
      imageOffset + 4 > bytes.length
    ) {
      return undefined;
    }
    if (bytes.readUInt32BE(imageOffset) === 0x8950_4e47) {
      const pngDimensions = readPngDimensions(bytes.subarray(imageOffset, imageOffset + byteLength));
      if (!pngDimensions) return undefined;
      dimension = Math.max(dimension, pngDimensions.width, pngDimensions.height);
    } else {
      if (byteLength < 12 || imageOffset + 12 > bytes.length) return undefined;
      const width = readUint32Le(bytes, imageOffset + 4);
      const height = readUint32Le(bytes, imageOffset + 8);
      if (width === undefined || height === undefined) return undefined;
      const signedHeight = height | 0;
      const imageHeight = signedHeight < 0 ? -signedHeight : signedHeight / 2;
      dimension = Math.max(dimension, width, imageHeight);
    }
  }
  return { width: dimension, height: dimension };
}

function getImageDimensions(bytes: Buffer, mediaType: string): ImageDimensions | undefined {
  switch (mediaType) {
    case "image/png":
      return readPngDimensions(bytes);
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/gif":
      return readGifDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
    case "image/bmp":
      return readBmpDimensions(bytes);
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return readIcoDimensions(bytes);
    default:
      return undefined;
  }
}

function isSupportedFavicon(bytes: Buffer, mediaType: string): boolean {
  const dimensions = getImageDimensions(bytes, mediaType);
  return (
    dimensions !== undefined &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= MAX_FAVICON_DIMENSION &&
    dimensions.height <= MAX_FAVICON_DIMENSION
  );
}

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  if (!normalized) return false;
  const urlHost = isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  return isPublicBrowserUrl(`https://${urlHost}/`);
}

function isAllowedRemoteUrl(url: URL, documentOrigin?: string): boolean {
  if (url.username || url.password) return false;
  return isPublicHostname(url.hostname) || (documentOrigin !== undefined && url.origin === documentOrigin);
}

function parseDataFavicon(value: string): FaviconBytes | undefined {
  const separator = value.indexOf(",");
  if (separator < 0) return undefined;
  const parameters = value.slice(5, separator).toLowerCase().split(";");
  const mediaType = parameters[0]?.trim() ?? "";
  if (!SUPPORTED_FAVICON_MEDIA_TYPES.has(mediaType) || !parameters.some((part) => part.trim() === "base64")) {
    return undefined;
  }
  const bytes = Buffer.from(decodeURIComponent(value.slice(separator + 1)), "base64");
  if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return undefined;
  return { bytes, mediaType };
}

export function selectBrowserFaviconCandidate(
  candidates: readonly string[],
  documentOrigin?: string,
): BrowserFaviconCandidate | undefined {
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol === "https:" || url.protocol === "http:") {
      if (candidate.length <= MAX_FAVICON_URL_LENGTH && isAllowedRemoteUrl(url, documentOrigin)) {
        return { kind: "fetch", url: candidate };
      }
      continue;
    }
    if (url.protocol !== "data:" || candidate.length > MAX_DATA_URL_LENGTH) continue;

    let parsed: FaviconBytes | undefined;
    try {
      parsed = parseDataFavicon(candidate);
    } catch {
      continue;
    }
    if (parsed && isSupportedFavicon(parsed.bytes, parsed.mediaType)) {
      return {
        kind: "data",
        url: `data:${parsed.mediaType};base64,${parsed.bytes.toString("base64")}`,
      };
    }
  }
  return undefined;
}

async function resolveHostname(hostname: string, signal: AbortSignal): Promise<string[] | undefined> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    signal.removeEventListener("abort", cancel);
    return undefined;
  }
  try {
    const [ipv4, ipv6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses = [
      ...(ipv4.status === "fulfilled" ? ipv4.value : []),
      ...(ipv6.status === "fulfilled" ? ipv6.value : []),
    ];
    return addresses.length > 0 && !signal.aborted ? addresses : undefined;
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function isFetchTargetAllowed(url: URL, documentOrigin: string | undefined, signal: AbortSignal) {
  if (!isAllowedRemoteUrl(url, documentOrigin)) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!isPublicHostname(hostname) || isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;

  const addresses = await resolveHostname(hostname, signal);
  return addresses !== undefined && addresses.every((address) => isPublicHostname(address));
}

export function createBrowserFaviconRequest(requestFactory: BrowserFaviconRequestFactory): BrowserFaviconRequest {
  return (url, browserSession, signal) =>
    new Promise((resolve) => {
      let request: ClientRequest;
      try {
        request = requestFactory({ method: "GET", url, session: browserSession, redirect: "manual" });
      } catch {
        resolve(undefined);
        return;
      }

      let settled = false;
      let byteLength = 0;
      const chunks: Buffer[] = [];
      const complete = (result: BrowserFaviconRequestResult | undefined) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (!result || result.kind === "redirect") {
          try {
            request.abort();
          } catch {
            // The request may already have completed.
          }
        }
        resolve(result);
      };
      const abort = () => complete(undefined);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        complete(undefined);
        return;
      }

      request.on("redirect", (_statusCode, _method, redirectUrl) => {
        complete({ kind: "redirect", location: redirectUrl });
      });
      request.on("response", (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          complete(undefined);
          return;
        }
        const contentTypeHeader = response.headers["content-type"];
        const mediaType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (!SUPPORTED_FAVICON_MEDIA_TYPES.has(mediaType)) {
          complete(undefined);
          return;
        }
        const contentLengthHeader = response.headers["content-length"];
        const contentLength = Number(
          Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader,
        );
        if (Number.isFinite(contentLength) && contentLength > MAX_FAVICON_BYTES) {
          complete(undefined);
          return;
        }
        response.on("data", (chunk: Buffer) => {
          byteLength += chunk.length;
          if (byteLength > MAX_FAVICON_BYTES) {
            complete(undefined);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          complete(bytes.length > 0 ? { kind: "bytes", bytes, mediaType } : undefined);
        });
        response.on("error", () => complete(undefined));
      });
      request.on("error", () => complete(undefined));
      request.end();
    });
}

export async function fetchBrowserFavicon(
  initialUrl: string,
  browserSession: Session,
  signal: AbortSignal,
  documentOrigin: string | undefined,
  request: BrowserFaviconRequest,
): Promise<string | undefined> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (currentUrl.length > MAX_FAVICON_URL_LENGTH) return undefined;
    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      return undefined;
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !(await isFetchTargetAllowed(url, documentOrigin, signal))
    ) {
      return undefined;
    }

    let result: BrowserFaviconRequestResult | undefined;
    try {
      result = await request(currentUrl, browserSession, signal);
    } catch {
      return undefined;
    }
    if (!result) return undefined;
    if (result.kind === "redirect") {
      try {
        currentUrl = new URL(result.location, currentUrl).toString();
      } catch {
        return undefined;
      }
      continue;
    }
    return isSupportedFavicon(result.bytes, result.mediaType)
      ? `data:${result.mediaType};base64,${result.bytes.toString("base64")}`
      : undefined;
  }
  return undefined;
}
