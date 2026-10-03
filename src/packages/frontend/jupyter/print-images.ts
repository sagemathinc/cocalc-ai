/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PRINT_IMAGE_TIMEOUT_MS = 30_000;

// A popup's load/readyState is not a guarantee that embedded plots are decoded.
// In particular, printing a freshly document.write'd page can race decoding.
export async function waitForPrintImages(doc: Document): Promise<void> {
  const cleanup: (() => void)[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        Array.from(doc.images).map(async (image) => {
          image.loading = "eager";
          if (typeof image.decode === "function") {
            await image.decode();
          } else if (!image.complete) {
            await new Promise<void>((resolve, reject) => {
              const loaded = () => resolve();
              const failed = () =>
                reject(Error("Unable to load an image for printing."));
              image.addEventListener("load", loaded);
              image.addEventListener("error", failed);
              cleanup.push(() => {
                image.removeEventListener("load", loaded);
                image.removeEventListener("error", failed);
              });
            });
          }
          if (!image.naturalWidth) {
            throw Error("Unable to load an image for printing.");
          }
        }),
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              Error("Timed out loading images for printing. Please retry."),
            ),
          PRINT_IMAGE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    cleanup.forEach((remove) => remove());
  }
}
