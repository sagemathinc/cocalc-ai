#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve } from "path";

const OUTPUT_DIR = resolve(
  process.cwd(),
  process.env.COCALC_OUTPUT || "dist-prod-measure",
);
const STATS_PATH = resolve(OUTPUT_DIR, "chunk-stats.json");

const { chunks, groups } = JSON.parse(readFileSync(STATS_PATH, "utf8"));

const loadAndAppForbidden = [
  "@pierre/diffs/",
  "@pierre/trees/",
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
  "node_modules/.pnpm/katex@",
  "node_modules/.pnpm/slate@",
  "node_modules/.pnpm/slate-react@",
  "frontend/components/markdown.tsx",
  "frontend/markdown/markdown-input/init.ts",
  "frontend/editors/slate/editable-markdown.tsx",
  "frontend/editors/slate/static-markdown.tsx",
  "frontend/editors/stopwatch/stopwatch.tsx",
  "frontend/markdown/component.tsx",
  "frontend/markdown/markdown-input/main.tsx",
  "dropzone/",
];

const appOnlyForbidden = [
  "frontend/hosts/project-host-recommendations.ts",
  "frontend/project/archive-info.ts",
  "frontend/project/use-project-course.ts",
  "frontend/projects/offline-move-confirmation.tsx",
  "node_modules/.pnpm/jquery@",
  "node_modules/.pnpm/jquery-tooltip@",
  "node_modules/.pnpm/jquery.scrollintoview@",
  "node_modules/.pnpm/markdown-it@",
  "node_modules/.pnpm/markdown-it-emoji@",
  "node_modules/.pnpm/timeago@",
];

const initialProjectSurfaceForbidden = [
  "frontend/project/compute-vms.tsx",
  "frontend/project/new/new-file-page.tsx",
  "frontend/project/page/flyouts/agents.tsx",
  "frontend/project/page/flyouts/workspaces.tsx",
];

const signedInStartupRouteForbidden = [
  "@pierre/diffs/",
  "@pierre/trees/",
  "frontend/app/post-surface-banners.tsx",
  "frontend/app/post-surface-modals.tsx",
  "frontend/app/post-surface-right-nav.tsx",
  "frontend/app/automatic-update-notice.tsx",
  "frontend/app/import-public-url-modal.tsx",
  "frontend/app/onboarding-email-prompt.tsx",
  "frontend/app/settings-modal.tsx",
  "frontend/chat/chat-log.tsx",
  "frontend/chat/chatroom.tsx",
  "frontend/chat/codex-activity.tsx",
  "frontend/chat/git-commit-drawer.tsx",
  "frontend/chat/message.tsx",
  "frontend/chat/side-chat.tsx",
  "frontend/conat/browser-session/action-engine.ts",
  "frontend/conat/browser-session/exec-operations.ts",
  "frontend/conat/browser-session/exec-api-declaration.ts",
  "frontend/conat/extensions-runtime.tsx",
  "frontend/conat/browser-session/fs-api.ts",
  "frontend/conat/browser-session/index.ts",
  "frontend/conat/browser-session/project-open-helpers.ts",
  "frontend/hosts/components/host-current-metrics.tsx",
  "frontend/hosts/pick-host.tsx",
  "frontend/hosts/providers/registry.ts",
  "frontend/hosts/select-host-for-project-start.tsx",
  "frontend/notifications/mentions/actions.ts",
  "frontend/notifications/mentions/init.ts",
  "frontend/notifications/news/init.ts",
  "frontend/project/page/flyouts/log.tsx",
  "frontend/project/docs-actions.ts",
  "frontend/project/settings/root-filesystem-image.tsx",
  "frontend/purchases/balance-button.tsx",
];

const projectsStartupForbidden = [
  "conat/dist/sync-doc/install.js",
  "conat/dist/sync-doc/immer-db.js",
  "conat/dist/sync-doc/syncdb.js",
  "conat/dist/sync-doc/syncstring.js",
  "sync/dist/editor/generic/ipywidgets-state.js",
  "sync/dist/editor/generic/sync-doc.js",
  "frontend/project/redux/store.ts",
  "frontend/project/redux/actions.ts",
  "frontend/chat/actions.ts",
  "frontend/frame-editors/base-editor/actions-base.ts",
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

const publicSiteForbidden = ["frontend/components/iconfont.cn/"];

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

const grandfatheredMatches = [
  {
    chunk: "public-viewer-md",
    pattern: "frontend/conat/client.ts",
    reason: "existing public Markdown viewer control-plane dependency",
  },
  {
    chunk: "public",
    pattern: "frontend/components/iconfont.cn/",
    reason: "existing public-site icon bundle",
  },
];

function findGroup(moduleSuffix, request) {
  const matches = groups.filter((group) =>
    group.origins?.some(
      (origin) =>
        origin.module?.endsWith(moduleSuffix) && origin.request === request,
    ),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one chunk group for ${moduleSuffix} -> ${request}; found ${matches.length}`,
    );
  }
  return matches[0];
}

const signedInProjectsStartupChunks = findGroup(
  "frontend/app/route-components.ts",
  "@cocalc/frontend/projects/projects-page",
).chunks;

const signedInStartupChunks = [
  ...signedInProjectsStartupChunks,
  ...findGroup(
    "frontend/app/route-components.ts",
    "@cocalc/frontend/project/page/page",
  ).chunks,
];

const rules = [
  {
    label: "main app chunk",
    chunks: ["app"],
    forbidden: appOnlyForbidden,
  },
  {
    label: "shared/load and main app chunks",
    chunks: ["load", "app", "embed"],
    forbidden: loadAndAppForbidden,
  },
  {
    label: "initial project surface chunks",
    chunks: ["app", "embed"],
    forbidden: initialProjectSurfaceForbidden,
  },
  {
    label: "signed-in startup route chunks",
    chunks: [...new Set(signedInStartupChunks)],
    forbidden: signedInStartupRouteForbidden,
  },
  {
    label: "signed-in Projects startup chunks",
    chunks: ["app", ...signedInProjectsStartupChunks],
    forbidden: projectsStartupForbidden,
  },
  {
    label: "public viewer and public site chunks",
    chunks: [
      "load",
      "public-viewer",
      "public-viewer-md",
      "public-viewer-ipynb",
      "public-viewer-board",
      "public-viewer-slides",
      "public-viewer-chat",
      "public",
    ],
    forbidden: publicViewerForbidden,
  },
  {
    label: "public site chunk",
    chunks: ["load", "public"],
    forbidden: publicSiteForbidden,
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
      "public",
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
let grandfatheredCount = 0;

function ensureChunk(name) {
  const chunk = chunks?.[name];
  if (chunk == null) {
    failed = true;
    console.error(`missing chunk stats for ${name}`);
    return null;
  }
  return chunk;
}

function findImporterPath(chunk, target, maxDepth = 12) {
  const importers = chunk?.importers ?? {};
  const queue = [[target]];
  const visited = new Set([target]);
  let longest = [target];

  while (queue.length > 0) {
    const path = queue.shift();
    if (path.length > longest.length) longest = path;
    const current = path[path.length - 1];
    const incoming = importers[current] ?? [];
    if (incoming.length === 0 || path.length >= maxDepth) {
      return [...path].reverse();
    }
    for (const importer of incoming) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      queue.push([...path, importer]);
    }
  }

  return [...longest].reverse();
}

for (const rule of rules) {
  for (const chunkName of rule.chunks) {
    const chunk = ensureChunk(chunkName);
    if (chunk == null) continue;

    const modules = Array.isArray(chunk.modules) ? chunk.modules : [];
    for (const pattern of rule.forbidden) {
      const match = modules.find((moduleName) => moduleName.includes(pattern));
      if (match != null) {
        const grandfathered = grandfatheredMatches.find(
          (entry) => entry.chunk === chunkName && entry.pattern === pattern,
        );
        if (grandfathered != null) {
          grandfatheredCount += 1;
          continue;
        }
        failed = true;
        console.error(
          `${chunkName}: matched forbidden module pattern "${pattern}" in ${rule.label}`,
        );
        console.error(`  ${match}`);
        const importPath = findImporterPath(chunk, match);
        if (importPath.length > 1) {
          console.error(`  import path: ${importPath.join(" -> ")}`);
        }
      }
    }
  }
}

if (!failed) {
  console.log(
    `checked ${Object.keys(chunks ?? {}).length} named chunks against module guards (${grandfatheredCount} grandfathered matches)`,
  );
}

if (failed) {
  process.exit(1);
}
