/* CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL. */
import { Buffer } from "buffer";
import { posix } from "path-browserify";
import { randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import type { FilesystemClient } from "@cocalc/conat/files/fs";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import type { ChatAttachment } from "./drafts";
import { rememberMeCookieHeader } from "../auth/site-url";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { openProjectHost } from "../cocalc/site-session";

const MAX_ATTACHMENT_BYTES = 20_000_000;
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface PickedAttachment {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}

function safeName(name: string): string {
  const basename = name.split(/[\\/]/).pop() ?? "";
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "file";
}

function markdownLabel(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function assertSize(size: number | null | undefined): void {
  if (size != null && size > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachments must be smaller than 20 MB.");
  }
}

async function localFile(asset: PickedAttachment): Promise<File> {
  assertSize(asset.size);
  const file = new File(asset.uri);
  if (!file.exists)
    throw new Error("The selected file is no longer available.");
  assertSize(file.size);
  return file;
}

/** Keep native camera HEIC/unknown output readable by the web and mobile image renderers. */
async function normalizedImage(
  asset: PickedAttachment,
): Promise<PickedAttachment> {
  if (RASTER_TYPES.has(asset.mimeType ?? "")) return asset;
  const { manipulateAsync, SaveFormat } =
    await import("expo-image-manipulator");
  const converted = await manipulateAsync(asset.uri, [], {
    compress: 0.85,
    format: SaveFormat.JPEG,
  });
  return {
    uri: converted.uri,
    name: `${safeName(asset.name).replace(/\.[^.]+$/, "")}.jpg`,
    mimeType: "image/jpeg",
  };
}

export async function uploadChatImage({
  profileId,
  projectId,
  asset,
}: {
  profileId: string;
  projectId: string;
  asset: PickedAttachment;
}): Promise<ChatAttachment> {
  assertSize(asset.size);
  const image = await normalizedImage(asset);
  await localFile(image);
  const session = await getActiveSiteSession(profileId);
  const filename = safeName(image.name);
  const body = new FormData();
  body.append("file", {
    uri: image.uri,
    name: filename,
    type: image.mimeType ?? "image/jpeg",
  } as unknown as Blob);
  const uploadBase = session.profile.home_bay_url.replace(/\/+$/, "");
  const response = await fetch(
    `${uploadBase}/blobs?project_id=${encodeURIComponent(projectId)}`,
    {
      method: "POST",
      headers: {
        Cookie: rememberMeCookieHeader(
          session.profile.app_base_path,
          session.credential.remember_me,
        ),
      },
      body,
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Image upload failed (HTTP ${response.status}).`);
  }
  const { uuid } = await response.json();
  if (typeof uuid !== "string" || !/^[a-f\d-]{36}$/i.test(uuid)) {
    throw new Error("The image upload returned an invalid ID.");
  }
  const url = `${session.profile.canonical_app_url.replace(/\/+$/, "")}/blobs/${encodeURIComponent(filename)}?uuid=${uuid}`;
  return {
    kind: "image",
    name: asset.name,
    markdown: `![${markdownLabel(asset.name)}](${url})`,
  };
}

export async function writeProjectAttachment({
  files,
  chatPath,
  asset,
  bytes,
}: {
  files: Pick<FilesystemClient, "mkdir" | "writeFile">;
  chatPath: string;
  asset: PickedAttachment;
  bytes: Uint8Array;
}): Promise<ChatAttachment> {
  assertSize(bytes.byteLength);
  if (!posix.isAbsolute(chatPath)) {
    throw new Error(
      "The agent chat path must be absolute to attach project files.",
    );
  }
  const directory = posix.join(posix.dirname(chatPath), "mobile-uploads");
  const path = posix.join(directory, `${randomUUID()}-${safeName(asset.name)}`);
  await files.mkdir(directory, { recursive: true });
  await files.writeFile(path, Buffer.from(bytes));
  return {
    kind: "file",
    name: asset.name,
    markdown: `[${markdownLabel(asset.name)}](sandbox:${path})`,
  };
}

export async function uploadChatFile({
  profileId,
  projectId,
  chatPath,
  asset,
}: {
  profileId: string;
  projectId: string;
  chatPath: string;
  asset: PickedAttachment;
}): Promise<ChatAttachment> {
  const file = await localFile(asset);
  const session = await getActiveSiteSession(profileId);
  const host = await resolveNamedAgentHost(
    session.hubApi,
    session.profile.account_id,
    projectId,
  );
  const lease = await openProjectHost(session, {
    project_id: projectId,
    host_id: host,
  });
  const files = lease.client.call<FilesystemClient>(`fs.project-${projectId}`, {
    timeout: 60_000,
  });
  return await writeProjectAttachment({
    files,
    chatPath,
    asset,
    bytes: await file.bytes(),
  });
}
