/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PROJECT_IMAGE_BYTES,
  readProjectImage,
} from "./claude-project-tool-bridge";
import type { ProjectJobExecutor } from "./claude-project-jobs";

// Runs the script locally, streaming output like the managed executor.
const localExecute: ProjectJobExecutor = (script, cwd, _signal, options) =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-c", script], { cwd });
    child.stdout.on("data", (d) => options.onOutput("stdout", `${d}`));
    child.stderr.on("data", (d) => options.onOutput("stderr", `${d}`));
    child.on("close", (code) =>
      resolve({ stdout: "", stderr: "", code, cleanupConfirmed: true }),
    );
  });

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b1d5f00000000049454e44ae426082",
  "hex",
);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "read-image-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function read(path: unknown) {
  return readProjectImage(localExecute, { path }, new AbortController().signal);
}

test("returns a PNG as image content, even with shell-hostile path characters", async () => {
  const path = join(dir, "it's a $(plot) `x`;.png");
  await writeFile(path, PNG);
  expect(await read(path)).toEqual({
    path,
    bytes: PNG.length,
    image: { data: PNG.toString("base64"), mimeType: "image/png" },
  });
});

test("detects the type from the bytes, not the extension", async () => {
  const path = join(dir, "photo.png");
  const jpeg = Buffer.concat([
    Buffer.from("ffd8ffe0", "hex"),
    Buffer.alloc(32),
  ]);
  await writeFile(path, jpeg);
  expect(await read(path)).toMatchObject({
    image: { mimeType: "image/jpeg" },
  });
});

test("rejects non-images, oversized files, missing files and bad paths", async () => {
  const svg = join(dir, "plot.svg");
  await writeFile(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  expect((await read(svg)) as any).toEqual({
    error: expect.stringContaining("not a PNG, JPEG, GIF or WebP"),
  });

  const big = join(dir, "big.png");
  await writeFile(
    big,
    Buffer.concat([PNG, Buffer.alloc(MAX_PROJECT_IMAGE_BYTES)]),
  );
  expect((await read(big)) as any).toEqual({
    error: expect.stringContaining("the limit is"),
  });

  expect((await read(join(dir, "missing.png"))) as any).toEqual({
    error: expect.stringContaining("not a readable file"),
  });
  expect((await read("")) as any).toEqual({
    error: "path must be a non-empty file path",
  });
  expect((await read(42)) as any).toEqual({
    error: "path must be a non-empty file path",
  });
});
