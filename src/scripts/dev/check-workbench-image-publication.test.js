const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

test("installed artifact smoke rejects absent APIs and Markdown-only results", async () => {
  const source = await fs.readFile(
    join(__dirname, "check-workbench-image-publication.js"),
    "utf8",
  );
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "api",
    "process",
    "Buffer",
    source,
  );
  const env = {
    WORKBENCH_IMAGE_ARTIFACT_ID: "image",
    COCALC_CODEX_CHAT_PATH: "test.chat",
    COCALC_CODEX_THREAD_ID: "thread",
  };
  await assert.rejects(run({}, { env }, Buffer), /Installed CLI/);
  await assert.rejects(
    run(
      { artifacts: { open: () => ({ list: async () => [] }) } },
      { env },
      Buffer,
    ),
    /did not publish/,
  );
  await assert.rejects(
    run(
      {
        artifacts: {
          open: () => ({
            list: async () => [{ artifact_id: "image" }],
            read: async () => ({ artifact: { kind: "markdown" } }),
          }),
        },
      },
      { env },
      Buffer,
    ),
    /not a Markdown link/,
  );
});

test("installed artifact smoke verifies real raster bytes, not just a filename", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "workbench-smoke-"));
  try {
    const file = join(dir, "image.png");
    const source = await fs.readFile(
      join(__dirname, "check-workbench-image-publication.js"),
      "utf8",
    );
    const run = new (Object.getPrototypeOf(async function () {}).constructor)(
      "api",
      "process",
      "Buffer",
      source,
    );
    const env = {
      WORKBENCH_IMAGE_ARTIFACT_ID: "image",
      COCALC_CODEX_CHAT_PATH: "test.chat",
      COCALC_CODEX_THREAD_ID: "thread",
    };
    const api = {
      artifacts: {
        open: () => ({
          list: async () => [{ artifact_id: "image" }],
          read: async () => ({
            artifact: { kind: "file", file: { path: file } },
          }),
        }),
      },
    };
    await fs.writeFile(file, "not a picture");
    await assert.rejects(run(api, { env }, Buffer), /raster image bytes/);
    await fs.writeFile(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    assert.equal((await run(api, { env }, Buffer)).ok, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
