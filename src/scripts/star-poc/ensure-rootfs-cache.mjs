#!/usr/bin/env node

import { resolve } from "node:path";

const image = `${process.env.STAR_DEFAULT_ROOTFS_IMAGE ?? ""}`.trim();
if (!image) {
  throw new Error("STAR_DEFAULT_ROOTFS_IMAGE must be set");
}

const srcRoot = process.cwd();
const rootfsBase = await import(
  `${resolve(srcRoot, "packages/project-runner/dist/run/rootfs-base.js")}`
);

await rootfsBase.extractBaseImage(image);

console.log(
  JSON.stringify(
    {
      ok: true,
      image,
      cache_path: rootfsBase.imageCachePath(image),
      inspect_path: rootfsBase.inspectFilePath(image),
      preflight_path: rootfsBase.preflightMetadataFilePath(image),
    },
    null,
    2,
  ),
);
