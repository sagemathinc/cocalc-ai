import { readFile } from "./read";
import { once } from "events";
import { path_split } from "@cocalc/util/misc";
import { getLogger } from "@cocalc/conat/logger";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import mime from "mime-types";

const DANGEROUS_CONTENT_TYPE = new Set(["image/svg+xml" /*, "text/html"*/]);
export const DOWNLOAD_ERROR_HEADER = "X-CoCalc-Download-Error";

const logger = getLogger("conat:file-download");

// assumes request has already been authenticated!
function extractDownloadPath(url: string): string {
  const i = url.indexOf("files/");
  let j = url.lastIndexOf("?");
  if (j == -1) {
    j = url.length;
  }
  const decodedPath = decodeURIComponent(url.slice(i + "files/".length, j));
  if (decodedPath == "" || decodedPath == "/") {
    return "/";
  }
  // Frontend routes encode absolute paths as ".../files/<path-without-leading-slash>".
  // Re-add the leading slash so backend file APIs do not interpret it relative to cwd.
  return decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`;
}

function hasExplicitDownloadQuery(url: string): boolean {
  try {
    const parsed = new URL(url, "http://127.0.0.1");
    return parsed.searchParams.has("download");
  } catch {
    return false;
  }
}

function encodeDownloadErrorHeader(message: string): string {
  return encodeURIComponent(message);
}

export async function handleFileDownload({
  req,
  res,
  url,
  allowUnsafe,
  client,
  beforeExplicitDownload,
  onExplicitDownloadComplete,
  // allow a long download time (1 hour), since files can be large and
  // networks can be slow.
  maxWait = 1000 * 60 * 60,
}: {
  req;
  res;
  url?: string;
  allowUnsafe?: boolean;
  client?: ConatClient;
  beforeExplicitDownload?: (opts: {
    project_id: string;
    path: string;
    request_path: string;
  }) => Promise<{ allowed: true } | { allowed: false; message: string }>;
  onExplicitDownloadComplete?: (opts: {
    project_id: string;
    path: string;
    request_path: string;
    bytes: number;
    partial: boolean;
  }) => Promise<void>;
  maxWait?: number;
}) {
  url ??= req.url;
  logger.debug("downloading file from project to browser", url);
  if (!url) {
    res.statusCode = 500;
    res.end("Invalid URL");
    return;
  }
  const path = extractDownloadPath(url);
  const project_id = url.split("/").slice(1)[0];
  logger.debug("conat: get file", { project_id, path, url });
  const fileName = path_split(path).tail;
  const contentType = mime.lookup(fileName);
  const explicitDownload = hasExplicitDownloadQuery(url);
  if (
    explicitDownload ||
    (!allowUnsafe && DANGEROUS_CONTENT_TYPE.has(contentType))
  ) {
    const fileNameEncoded = encodeURIComponent(fileName)
      .replace(/['()]/g, escape)
      .replace(/\*/g, "%2A");
    res.setHeader(
      "Content-disposition",
      `attachment; filename*=UTF-8''${fileNameEncoded}`,
    );
  }
  res.setHeader("Content-type", contentType);
  if (explicitDownload) {
    res.setHeader("Cache-Control", "private, no-store");
  }

  if (explicitDownload && beforeExplicitDownload) {
    const allowed = await beforeExplicitDownload({
      project_id,
      path,
      request_path: url,
    });
    if (!allowed.allowed) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        DOWNLOAD_ERROR_HEADER,
        encodeDownloadErrorHeader(allowed.message),
      );
      res.end(allowed.message);
      return;
    }
  }

  let headersSent = false;
  let bytesWritten = 0;
  let partial = false;
  res.on("finish", () => {
    headersSent = true;
  });
  try {
    for await (const chunk of await readFile({
      client,
      project_id,
      path,
      maxWait,
    })) {
      if (res.writableEnded || res.destroyed) {
        partial = true;
        break;
      }
      if (Buffer.isBuffer(chunk)) {
        bytesWritten += chunk.length;
      } else {
        bytesWritten += Buffer.byteLength(chunk);
      }
      if (!res.write(chunk)) {
        await once(res, "drain");
      }
    }
    res.end();
    if (explicitDownload && onExplicitDownloadComplete && bytesWritten > 0) {
      await onExplicitDownloadComplete({
        project_id,
        path,
        request_path: url,
        bytes: bytesWritten,
        partial,
      });
    }
  } catch (err) {
    logger.debug("ERROR streaming file", { project_id, path }, err);
    if (!headersSent) {
      res.statusCode = 500;
      res.end("Error reading file.");
    } else {
      // Data sent, forcibly kill the connection
      res.destroy(err);
    }
  }
}
