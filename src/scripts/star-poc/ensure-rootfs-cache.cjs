#!/usr/bin/env node

const { join } = require("node:path");

function requireProjectRunner(module) {
  try {
    return require(`@cocalc/project-runner/run/${module}`);
  } catch (err) {
    if (err?.code !== "MODULE_NOT_FOUND") {
      throw err;
    }
    return require(join(
      process.cwd(),
      "packages",
      "project-runner",
      "dist",
      "run",
      `${module}.js`,
    ));
  }
}

const rootfsBase = requireProjectRunner("rootfs-base");
const rootfsNormalize = requireProjectRunner("rootfs-normalize");

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
