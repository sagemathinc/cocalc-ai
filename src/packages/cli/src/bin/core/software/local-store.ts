import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  SoftwareArtifactFile,
  SoftwareArtifactManifest,
  SoftwareBuildComponent,
  SoftwareListRow,
} from "./types";

export const DEFAULT_SOFTWARE_LOCAL_STORE = "/tmp/cocalc-software";

export function resolveSoftwareLocalStore({
  option,
  env,
}: {
  option?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return resolve(
    option || env?.COCALC_SOFTWARE_LOCAL_STORE || DEFAULT_SOFTWARE_LOCAL_STORE,
  );
}

export function artifactDir({
  localStore,
  component,
  artifactId,
}: {
  localStore: string;
  component: SoftwareBuildComponent;
  artifactId: string;
}): string {
  return join(localStore, component, artifactId);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise());
  });
  return hash.digest("hex");
}

function contentTypeForName(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".tar.xz")) return "application/x-xz";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz"))
    return "application/gzip";
  if (name.endsWith(".sh")) return "text/x-shellscript";
  return "application/octet-stream";
}

export async function copyArtifactFile({
  source,
  destinationFilesDir,
  name,
}: {
  source: string;
  destinationFilesDir: string;
  name?: string;
}): Promise<SoftwareArtifactFile> {
  const resolvedSource = resolve(source);
  const fileName = name?.trim() || basename(resolvedSource);
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error("artifact file name must be a plain file name");
  }
  await mkdir(destinationFilesDir, { recursive: true });
  const target = join(destinationFilesDir, fileName);
  await copyFile(resolvedSource, target);
  const fileStat = await stat(target);
  return {
    name: fileName,
    path: `files/${fileName}`,
    content_type: contentTypeForName(fileName),
    size_bytes: fileStat.size,
    sha256: await sha256File(target),
  };
}

export async function writeLocalManifest({
  localStore,
  manifest,
}: {
  localStore: string;
  manifest: SoftwareArtifactManifest;
}): Promise<string> {
  const dir = artifactDir({
    localStore,
    component: manifest.component,
    artifactId: manifest.artifact_id,
  });
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export async function readLocalManifest(
  path: string,
): Promise<SoftwareArtifactManifest> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function listLocalManifests({
  localStore,
  component,
}: {
  localStore: string;
  component: SoftwareBuildComponent;
}): Promise<Array<{ manifest: SoftwareArtifactManifest; path: string }>> {
  const componentDir = join(localStore, component);
  let entries: string[];
  try {
    entries = await readdir(componentDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const manifests: Array<{ manifest: SoftwareArtifactManifest; path: string }> =
    [];
  for (const entry of entries) {
    const path = join(componentDir, entry, "manifest.json");
    try {
      const manifest = await readLocalManifest(path);
      if (manifest.component === component) {
        manifests.push({ manifest, path });
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw err;
      }
    }
  }
  manifests.sort((a, b) =>
    b.manifest.created_at.localeCompare(a.manifest.created_at),
  );
  return manifests;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)} PB`;
}

export function manifestToListRow({
  manifest,
  path,
}: {
  manifest: SoftwareArtifactManifest;
  path: string;
}): SoftwareListRow {
  const size = manifest.files.reduce(
    (total, file) => total + file.size_bytes,
    0,
  );
  return {
    source: "local",
    tag: manifest.tag,
    artifact_id: manifest.artifact_id,
    git: manifest.source.git_short,
    dirty: manifest.source.git_dirty,
    size: formatSize(size),
    created: manifest.created_at,
    local: path,
  };
}
