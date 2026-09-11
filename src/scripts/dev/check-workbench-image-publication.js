// Run inside the generating agent's project with the installed CLI:
// WORKBENCH_IMAGE_ARTIFACT_ID=<id> <exact CoCalc CLI command> exec --file <this file>
// This intentionally uses the installed API, not imports from a newer checkout.
// Run after an image-generation turn has published its card; it is read-only.
const artifactId = process.env.WORKBENCH_IMAGE_ARTIFACT_ID;
const path = process.env.COCALC_CODEX_CHAT_PATH;
const threadId = process.env.COCALC_CODEX_THREAD_ID;
if (!artifactId || !path || !threadId) {
  throw Error(
    "Set WORKBENCH_IMAGE_ARTIFACT_ID and the originating CoCalc chat/thread context.",
  );
}
if (!api.artifacts?.open)
  throw Error(
    "Installed CLI has no artifact API. Upgrade the tools used by this project.",
  );
const doc = api.artifacts.open({ path, threadId });
const listed = await doc.list();
if (!listed.some((item) => item.artifact_id === artifactId))
  throw Error("Image generation did not publish a discoverable artifact card.");
const { artifact } = await doc.read(artifactId);
if (artifact.kind !== "file" || !artifact.file?.path)
  throw Error("Expected an image file artifact, not a Markdown link.");
const fs = await import("node:fs/promises");
const bytes = await fs.readFile(artifact.file.path);
const png = bytes
  .subarray(0, 8)
  .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
const webp =
  bytes.toString("ascii", 0, 4) === "RIFF" &&
  bytes.toString("ascii", 8, 12) === "WEBP";
if (!png && !jpeg && !webp)
  throw Error("Published file is missing supported raster image bytes.");
if (bytes.length > 10 * 1024 * 1024)
  throw Error("Published image exceeds the workbench preview limit.");
return {
  ok: true,
  artifact_id: artifactId,
  thread_id: threadId,
  path: artifact.file.path,
  bytes: bytes.length,
};
