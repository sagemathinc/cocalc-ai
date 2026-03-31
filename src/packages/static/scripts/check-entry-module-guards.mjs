#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve } from "path";

const OUTPUT_DIR = resolve(
  process.cwd(),
  process.env.COCALC_OUTPUT || "dist-prod-measure",
);
const STATS_PATH = resolve(OUTPUT_DIR, "chunk-stats.json");

const { chunks } = JSON.parse(readFileSync(STATS_PATH, "utf8"));

const loadAndAppForbidden = [
  "pdfjs-dist/",
  "@xterm/xterm/",
  "frontend/jupyter/new-notebook",
  "frontend/jupyter/kernelspecs",
  "frontend/jupyter/llm/split-cells",
  "frontend/jupyter/nbviewer/nbviewer.tsx",
  "frontend/jupyter/codemirror-static.tsx",
  "frontend/codemirror/static.js",
  "cheerio/",
  "@uiw/react-textarea-code-editor/",
];

const publicViewerForbidden = [
  "frontend/chat/chatroom.tsx",
  "frontend/project_actions.ts",
  "frontend/project/page/file-tab.tsx",
  "frontend/frame-editors/base-editor/actions-base.ts",
  "frontend/editors/slate/editable-markdown.tsx",
  "frontend/conat/client.ts",
  "dropzone/",
  "pdfjs-dist/",
  "@xterm/xterm/",
  "cheerio/",
  "@uiw/react-textarea-code-editor/",
];

const publicSlateForbidden = [
  "frontend/editors/slate/static-markdown.tsx",
  "frontend/editors/slate/elements/init-ssr.ts",
  "frontend/editors/slate/elements/index.ts",
];

const publicNotebookForbidden = [
  "frontend/jupyter/nbviewer/nbviewer.tsx",
  "frontend/jupyter/cell-list.tsx",
  "frontend/jupyter/browser-actions.ts",
  "frontend/jupyter/codemirror-component.tsx",
];

const rules = [
  {
    label: "shared/load and main app chunks",
    chunks: ["load", "app", "embed"],
    forbidden: loadAndAppForbidden,
  },
  {
    label: "public viewer and public content chunks",
    chunks: [
      "load",
      "public-viewer",
      "public-viewer-md",
      "public-viewer-ipynb",
      "public-viewer-board",
      "public-viewer-slides",
      "public-viewer-chat",
      "public-content",
    ],
    forbidden: publicViewerForbidden,
  },
  {
    label: "viewer-only Slate chunks",
    chunks: [
      "load",
      "public-viewer-md",
      "public-viewer-ipynb",
      "public-viewer-board",
      "public-viewer-slides",
      "public-viewer-chat",
      "public-content",
    ],
    forbidden: publicSlateForbidden,
  },
  {
    label: "public notebook viewer chunks",
    chunks: ["load", "public-viewer-ipynb"],
    forbidden: publicNotebookForbidden,
  },
];

let failed = false;

function ensureChunk(name) {
  const chunk = chunks?.[name];
  if (chunk == null) {
    failed = true;
    console.error(`missing chunk stats for ${name}`);
    return null;
  }
  return chunk;
}

for (const rule of rules) {
  for (const chunkName of rule.chunks) {
    const chunk = ensureChunk(chunkName);
    if (chunk == null) continue;

    const modules = Array.isArray(chunk.modules) ? chunk.modules : [];
    for (const pattern of rule.forbidden) {
      const match = modules.find((moduleName) => moduleName.includes(pattern));
      if (match != null) {
        failed = true;
        console.error(
          `${chunkName}: matched forbidden module pattern "${pattern}" in ${rule.label}`,
        );
        console.error(`  ${match}`);
      }
    }
  }
}

if (!failed) {
  console.log(
    `checked ${Object.keys(chunks ?? {}).length} named chunks against module guards`,
  );
}

if (failed) {
  process.exit(1);
}
