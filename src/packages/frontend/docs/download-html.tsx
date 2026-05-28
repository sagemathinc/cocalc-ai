/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { renderToStaticMarkup } from "react-dom/server";

import type { DocsAccess, DocsEntryImage } from "@cocalc/docs";
import { listDocsEntries } from "@cocalc/docs";
import { BASE_URL } from "@cocalc/frontend/misc";
import { resource_links_string } from "@cocalc/frontend/misc/resource-links";

import { DocsPrintContent } from "./browser";

const DOCS_HTML_FILENAME = "cocalc-docs.html";

function absoluteUrl(src: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  return `${BASE_URL}${src.startsWith("/") ? "" : "/"}${src}`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(`${reader.result}`);
    reader.readAsDataURL(blob);
  });
}

async function imageToDataUrl(src: string): Promise<string> {
  const response = await fetch(absoluteUrl(src));
  if (!response.ok) {
    throw Error(`unable to fetch ${src}: ${response.statusText}`);
  }
  return await blobToDataUrl(await response.blob());
}

function docsImages(docsAccess?: DocsAccess): DocsEntryImage[] {
  const images: DocsEntryImage[] = [];
  const seen = new Set<string>();
  for (const entry of listDocsEntries(docsAccess)) {
    if (entry.image == null || seen.has(entry.image.src)) continue;
    seen.add(entry.image.src);
    images.push(entry.image);
  }
  return images;
}

async function inlineDocsImages(
  html: string,
  docsAccess?: DocsAccess,
): Promise<string> {
  let result = html;
  for (const image of docsImages(docsAccess)) {
    const dataUrl = await imageToDataUrl(image.src);
    result = result.split(image.src).join(dataUrl);
    if (image.thumbnailSrc != null) {
      result = result.split(image.thumbnailSrc).join(dataUrl);
    }
  }
  return result;
}

export function wrapDocsPrintHtml(
  html: string,
  {
    autoPrint = false,
    includeResourceLinks = true,
  }: { autoPrint?: boolean; includeResourceLinks?: boolean } = {},
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>CoCalc documentation</title>
    <meta charset="utf-8" />
    <meta name="google" content="notranslate" />
    <base href="${BASE_URL}/" />
    ${includeResourceLinks ? resource_links_string(BASE_URL) : ""}
    <style>
      html, body { background: white; }
      body { margin: 0; padding: 24px; }
      @media screen and (max-width: 640px) { body { padding: 12px; } }
      @media print { body { padding: 0; } }
    </style>
  </head>
  <body>
    ${html}
    ${
      autoPrint
        ? `<script>
      window.onload = function() {
        setTimeout(function() { window.print(); }, 50);
      };
    </script>`
        : ""
    }
  </body>
</html>`;
}

export async function createStandaloneDocsHtml({
  docsAccess,
  onBackHref,
}: {
  docsAccess?: DocsAccess;
  onBackHref?: string;
}): Promise<string> {
  const html = renderToStaticMarkup(
    <DocsPrintContent
      docsAccess={docsAccess}
      onBackHref={onBackHref}
      showControls={false}
    />,
  );
  return await inlineDocsImages(
    wrapDocsPrintHtml(html, { includeResourceLinks: false }),
    docsAccess,
  );
}

export async function downloadStandaloneDocsHtml(opts: {
  docsAccess?: DocsAccess;
  onBackHref?: string;
}): Promise<void> {
  const html = await createStandaloneDocsHtml(opts);
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = DOCS_HTML_FILENAME;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
