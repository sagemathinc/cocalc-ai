import { readFile } from "./read";
import { fsClient, fsSubject } from "./fs";
import { once } from "events";
import { path_split } from "@cocalc/util/misc";
import { getLogger } from "@cocalc/conat/logger";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import mime from "mime-types";
import { isTemporaryDownloadArchivePath } from "./download-archive";

const DANGEROUS_CONTENT_TYPE = new Set(["image/svg+xml" /*, "text/html"*/]);
export const DOWNLOAD_ERROR_HEADER = "X-CoCalc-Download-Error";

const logger = getLogger("conat:file-download");
export const PROJECT_HOST_FILE_DOWNLOAD_READ_SERVICE = ":project-host";

// assumes request has already been authenticated!
function parseDownloadUrl(url: string): { project_id: string; path: string } {
  const filesMarker = "/files/";
  const i = url.indexOf(filesMarker);
  if (i === -1) {
    throw new Error(`invalid project file download URL: ${url}`);
  }
  const prefix = url.slice(0, i);
  const parts = prefix.split("/").filter(Boolean);
  const project_id =
    parts[0] === "projects" && parts[1] != null ? parts[1] : parts[0];
  if (!project_id) {
    throw new Error(`invalid project id in file download URL: ${url}`);
  }
  let j = url.lastIndexOf("?");
  if (j == -1) {
    j = url.length;
  }
  const decodedPath = decodeURIComponent(url.slice(i + filesMarker.length, j));
  if (decodedPath == "" || decodedPath == "/") {
    return { project_id, path: "/" };
  }
  // Frontend routes encode absolute paths as ".../files/<path-without-leading-slash>".
  // Re-add the leading slash so backend file APIs do not interpret it relative to cwd.
  return {
    project_id,
    path: decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`,
  };
}

function getDownloadQueryOptions(url: string): {
  explicitDownload: boolean;
  deleteAfterDownload: boolean;
  downloadFilename?: string;
} {
  try {
    const parsed = new URL(url, "http://127.0.0.1");
    const downloadFilename = parsed.searchParams.get("downloadFilename");
    return {
      explicitDownload: parsed.searchParams.has("download"),
      deleteAfterDownload:
        parsed.searchParams.get("deleteAfterDownload") == "1",
      downloadFilename: downloadFilename
        ? path_split(downloadFilename).tail
        : undefined,
    };
  } catch {
    return { explicitDownload: false, deleteAfterDownload: false };
  }
}

function encodeDownloadErrorHeader(message: string): string {
  return encodeURIComponent(message);
}

async function cleanupTemporaryDownloadArchive({
  client,
  project_id,
  path,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
}) {
  try {
    await fsClient({
      client,
      subject: fsSubject({ project_id }),
    }).rm(path, { force: true });
  } catch (err) {
    logger.debug("ERROR removing temporary download archive", {
      project_id,
      path,
      err: `${err}`,
    });
  }
}

export async function handleFileDownload({
  req,
  res,
  url,
  allowUnsafe,
  client,
  beforeExplicitDownload,
  onExplicitDownloadComplete,
  readServiceName,
  statSubject,
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
  readServiceName?: string;
  statSubject?: string;
  maxWait?: number;
}) {
  url ??= req.url;
  logger.debug("downloading file from project to browser", url);
  if (!url) {
    res.statusCode = 500;
    res.end("Invalid URL");
    return;
  }
  const { project_id, path } = parseDownloadUrl(url);
  logger.debug("conat: get file", { project_id, path, url });
  const { explicitDownload, deleteAfterDownload, downloadFilename } =
    getDownloadQueryOptions(url);
  const fileName = downloadFilename || path_split(path).tail;
  const contentType = mime.lookup(fileName);
  const cleanupClient =
    req.method !== "HEAD" &&
    explicitDownload &&
    deleteAfterDownload &&
    client != null &&
    isTemporaryDownloadArchivePath(path)
      ? client
      : undefined;
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
      if (cleanupClient) {
        await cleanupTemporaryDownloadArchive({
          client: cleanupClient,
          project_id,
          path,
        });
      }
      return;
    }
  }

  if (req.method === "HEAD" && client != null) {
    try {
      const stat = await fsClient({
        client,
        subject: statSubject ?? fsSubject({ project_id }),
      }).stat(path);
      if (typeof stat.size === "number" && Number.isFinite(stat.size)) {
        res.setHeader("Content-Length", stat.size);
      }
      if (stat.mtime instanceof Date && Number.isFinite(stat.mtime.valueOf())) {
        res.setHeader("Last-Modified", stat.mtime.toUTCString());
      }
      res.statusCode = 200;
      res.end();
      return;
    } catch (err: any) {
      logger.debug("ERROR statting file for HEAD download", {
        project_id,
        path,
        err: `${err}`,
      });
      res.statusCode = err?.code === "ENOENT" ? 404 : 500;
      res.end(
        err?.code === "ENOENT" ? "File not found." : "Error reading file.",
      );
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
      name: readServiceName,
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
  } finally {
    if (cleanupClient) {
      await cleanupTemporaryDownloadArchive({
        client: cleanupClient,
        project_id,
        path,
      });
    }
  }
}
