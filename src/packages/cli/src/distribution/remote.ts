/*
 * Downloads from the CLI's origin (distribution Phase A). Only the recorded
 * origin is ever contacted, and redirects are refused, so a CDN is trusted
 * only when it serves that same origin name.
 */

import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import {
  type CliSiteInfo,
  MAX_MANIFEST_BYTES,
  MAX_POINTER_BYTES,
  parseSiteInfo,
} from "@cocalc/util/cli-distribution/schema";
import { sha256 } from "./local";

const DOWNLOAD_TIMEOUT_MS = 600_000;

async function get(
  origin: string,
  path: string,
  timeoutMs: number,
): Promise<Response> {
  const url = `${origin}${path}`;
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "cache-control": "no-cache" },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `${url} redirected elsewhere; the CLI only downloads from ${origin}`,
    );
  }
  if (!response.ok || response.body == null) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response;
}

async function getCapped(
  origin: string,
  path: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const response = await get(origin, path, timeoutMs);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as any) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`${origin}${path} is too large`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function fetchSiteInfo(
  origin: string,
  timeoutMs = 15_000,
): Promise<CliSiteInfo> {
  const bytes = await getCapped(
    origin,
    "/cli/site.json",
    MAX_POINTER_BYTES,
    timeoutMs,
  );
  return parseSiteInfo(bytes.toString("utf8"));
}

export async function fetchManifestText(
  origin: string,
  hash: string,
): Promise<string> {
  const bytes = await getCapped(
    origin,
    `/cli/manifests/${hash}.json`,
    MAX_MANIFEST_BYTES,
    30_000,
  );
  if (sha256(bytes) !== hash) {
    throw new Error(`${origin} served a manifest that does not match ${hash}`);
  }
  return bytes.toString("utf8");
}

// Download one file a manifest lists into `dest`, checking size and sha256.
export function originFileFetcher(origin: string, manifestHash: string) {
  return async (hash: string, dest: string, size: number): Promise<void> => {
    const path = `/cli/files/${manifestHash}/${hash}`;
    const response = await get(origin, path, DOWNLOAD_TIMEOUT_MS);
    const out = await open(dest, "wx", 0o600);
    const digest = createHash("sha256");
    let total = 0;
    try {
      for await (const chunk of response.body as any) {
        total += chunk.length;
        if (total > size) throw new Error(`${origin}${path} is too large`);
        digest.update(chunk);
        await out.write(chunk);
      }
      await out.sync();
    } catch (err) {
      await out.close();
      await unlink(dest).catch(() => {});
      throw err;
    }
    await out.close();
    if (total !== size || digest.digest("hex") !== hash) {
      await unlink(dest).catch(() => {});
      throw new Error(`${origin}${path} does not match its size and sha256`);
    }
  };
}
