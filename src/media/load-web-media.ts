import fs from "node:fs/promises";
/**
 * Load media from a file path, file:// URL, or http(s) URL.
 * Replaces the former web/media module for local and remote media loading.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mediaKindFromMime } from "./constants.js";
import { fetchRemoteMedia } from "./fetch.js";
import { detectMime } from "./mime.js";

export type LoadWebMediaResult =
  | { kind: "image"; buffer: Buffer; contentType: string; fileName?: string }
  | { kind: "audio"; buffer: Buffer; contentType: string; fileName?: string }
  | { kind: "video"; buffer: Buffer; contentType: string; fileName?: string }
  | { kind: "document"; buffer: Buffer; contentType: string; fileName?: string };

function resolveFilePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return trimmed.replace(/^file:\/\/+/, "");
    }
  }
  return trimmed;
}

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

export async function loadWebMedia(input: string, maxBytes?: number): Promise<LoadWebMediaResult> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("loadWebMedia: empty input");
  }

  if (isHttpUrl(trimmed)) {
    const result = await fetchRemoteMedia({
      url: trimmed,
      maxBytes,
    });
    const kind = mediaKindFromMime(result.contentType);
    return {
      kind: kind === "unknown" ? "document" : kind,
      buffer: result.buffer,
      contentType: result.contentType ?? "application/octet-stream",
      fileName: result.fileName,
    };
  }

  const filePath = resolveFilePath(trimmed);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`loadWebMedia: not a file: ${filePath}`);
  }
  if (maxBytes && stat.size > maxBytes) {
    throw new Error(`loadWebMedia: file size ${stat.size} exceeds maxBytes ${maxBytes}`);
  }
  const buffer = await fs.readFile(filePath);
  const contentType = await detectMime({
    buffer,
    filePath,
  });
  const kind = mediaKindFromMime(contentType ?? undefined);
  const baseKind = kind === "unknown" ? "document" : kind;
  const fileName = path.basename(filePath);

  return {
    kind: baseKind,
    buffer,
    contentType: contentType ?? "application/octet-stream",
    fileName,
  };
}
