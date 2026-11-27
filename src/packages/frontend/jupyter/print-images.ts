/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PRINT_IMAGE_TIMEOUT_MS = 30_000;

// The name shown for an image that can't be loaded: the last part of its
// path, without the query (e.g. "paste-0.153.png" for
// "/blobs/paste-0.153.png?uuid=...").
function imageName(image: HTMLImageElement): string {
  const src = image.getAttribute("src") ?? "";
  if (src.startsWith("data:")) return "embedded image";
  const path = src.split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name) || "image";
  } catch {
    return name || "image";
  }
}

// An image that can't be loaded (e.g. a pasted image whose stored copy no
// longer exists) is replaced by a visible note, so the printout still has
// everything else and says what is missing, instead of the whole export
// failing.  Nothing is dropped silently.
function replaceWithPlaceholder(image: HTMLImageElement): string {
  const name = imageName(image);
  const note = image.ownerDocument.createElement("span");
  note.className = "cocalc-print-missing-image";
  note.textContent = `[image could not be loaded: ${name}]`;
  note.style.display = "inline-block";
  note.style.border = "1px dashed currentColor";
  note.style.padding = "2px 6px";
  note.style.fontStyle = "italic";
  image.replaceWith(note);
  return name;
}

// Resolves once the image is decoded; false if it can't be loaded.
async function loadImage(
  image: HTMLImageElement,
  cleanup: (() => void)[],
): Promise<boolean> {
  image.loading = "eager";
  try {
    if (typeof image.decode === "function") {
      await image.decode();
    } else if (!image.complete) {
      await new Promise<void>((resolve, reject) => {
        const loaded = () => resolve();
        const failed = () => reject(Error("image failed to load"));
        image.addEventListener("load", loaded);
        image.addEventListener("error", failed);
        cleanup.push(() => {
          image.removeEventListener("load", loaded);
          image.removeEventListener("error", failed);
        });
      });
    }
  } catch {
    return false;
  }
  return !!image.naturalWidth;
}

// A popup's load/readyState is not a guarantee that embedded plots are decoded.
// In particular, printing a freshly document.write'd page can race decoding.
// Returns the names of the images that couldn't be loaded (now placeholders).
export async function waitForPrintImages(doc: Document): Promise<string[]> {
  const cleanup: (() => void)[] = [];
  const missing: string[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        Array.from(doc.images).map(async (image) => {
          if (!(await loadImage(image, cleanup))) {
            missing.push(replaceWithPlaceholder(image));
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
  return missing;
}
