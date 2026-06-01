#!/usr/bin/env node

const rootfsBase = require("@cocalc/project-runner/run/rootfs-base");
const rootfsNormalize = require("@cocalc/project-runner/run/rootfs-normalize");

async function main() {
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
