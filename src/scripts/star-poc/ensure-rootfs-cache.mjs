#!/usr/bin/env node

import * as rootfsBase from "@cocalc/project-runner/run/rootfs-base";
import * as rootfsNormalize from "@cocalc/project-runner/run/rootfs-normalize";

const image = `${process.env.STAR_DEFAULT_ROOTFS_IMAGE ?? ""}`.trim();
if (!image) {
  throw new Error("STAR_DEFAULT_ROOTFS_IMAGE must be set");
}

await rootfsBase.extractBaseImage(image);

const rootfsPath = rootfsBase.imageCachePath(image);
const metadataPath = rootfsBase.preflightMetadataFilePath(image);
const metadata = await rootfsNormalize.preflightRootfsInPlace({
  image,
  rootfsPath,
  ownershipSource: "oci-extract",
});
await rootfsNormalize.writeRootfsPreflightMetadata({
  metadataPath,
  metadata,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      image,
      cache_path: rootfsPath,
      inspect_path: rootfsBase.inspectFilePath(image),
      preflight_path: metadataPath,
      repaired: true,
    },
    null,
    2,
  ),
);
