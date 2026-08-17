#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const KiB = 1024;
const output = resolve(
  process.cwd(),
  process.env.COCALC_OUTPUT || "dist-prod-measure",
);
const { chunks, groups } = JSON.parse(
  readFileSync(resolve(output, "chunk-stats.json"), "utf8"),
);

function findNamedGroup(name) {
  const matches = groups.filter((group) => group.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `expected one '${name}' chunk group; found ${matches.length}`,
    );
  }
  return matches[0].chunks;
}

function uniqueAssets(chunkNames) {
  const assets = new Map();
  for (const name of new Set(chunkNames)) {
    const chunk = chunks[name];
    if (!chunk) throw new Error(`missing ultralite chunk '${name}'`);
    for (const asset of chunk.assets ?? []) assets.set(asset.file, asset);
  }
  return [...assets.values()];
}

function assetSummary(chunkNames) {
  const assets = uniqueAssets(chunkNames);
  return {
    requests: assets.length,
    rawBytes: assets.reduce((sum, asset) => sum + asset.rawBytes, 0),
    gzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    brotliBytes: assets.reduce((sum, asset) => sum + asset.brotliBytes, 0),
  };
}

const initial = findNamedGroup("ultralite");
if (!initial?.length) throw new Error("missing initial ultralite chunk group");
const projects = findNamedGroup("ultralite-projects");
const workspace = findNamedGroup("ultralite-workspace");
const files = findNamedGroup("ultralite-files");
const recent = findNamedGroup("ultralite-recent");
const code = findNamedGroup("ultralite-code");
const notebookExecute = findNamedGroup("ultralite-notebook-execute");
const notebookMarkdown = findNamedGroup("ultralite-notebook-markdown");
const notebooks = findNamedGroup("ultralite-notebooks");
const chat = findNamedGroup("ultralite-chat");
const vms = findNamedGroup("ultralite-vms");
const apps = findNamedGroup("ultralite-apps");
const cli = findNamedGroup("ultralite-cli");
const terminal = findNamedGroup("ultralite-terminal");
const notifications = findNamedGroup("ultralite-notifications");
const settings = findNamedGroup("ultralite-settings");
const codeMirror = findNamedGroup("ultralite-codemirror");
const katexComponent = findNamedGroup("ultralite-katex-component");
const katex = findNamedGroup("ultralite-katex");
const prismLanguages = [
  "bash",
  "c",
  "cpp",
  "css",
  "go",
  "javascript",
  "json",
  "latex",
  "markdown",
  "markup",
  "python",
  "r",
  "rust",
  "sql",
  "typescript",
  "yaml",
].map((language) => ({
  language,
  chunks: findNamedGroup(`ultralite-prism-${language}`),
}));
const codeMirrorLanguages = [
  "bash",
  "cpp",
  "css",
  "go",
  "html",
  "javascript",
  "json",
  "latex",
  "markdown",
  "python",
  "r",
  "rust",
  "sql",
  "yaml",
].map((language) => ({
  language,
  chunks: findNamedGroup(`ultralite-cm-${language}`),
}));

function largestOptionalGroup(groups) {
  return groups.reduce(
    (largest, group) => {
      const bytes = assetSummary(group.chunks).brotliBytes;
      return bytes > largest.bytes ? { ...group, bytes } : largest;
    },
    { language: "none", chunks: [], bytes: 0 },
  );
}

const largestCodeMirrorLanguage = largestOptionalGroup(codeMirrorLanguages);
const largestPrismLanguage = largestOptionalGroup(prismLanguages);
function containsModule(chunkName, patterns) {
  return (chunks[chunkName]?.modules ?? []).some((moduleName) =>
    patterns.some((pattern) => moduleName.includes(pattern)),
  );
}

const codeMirrorPatterns = [
  "node_modules/.pnpm/@codemirror+",
  "essential-frontend/dist/codemirror-languages.js",
];
const markdownDependencyPatterns = [
  "essential-frontend/dist/notebook-markdown.js",
  "node_modules/.pnpm/entities@",
  "node_modules/.pnpm/linkify-it@",
  "node_modules/.pnpm/markdown-it@",
  "node_modules/.pnpm/mdurl@",
  "node_modules/.pnpm/punycode.js@",
  "node_modules/.pnpm/uc.micro@",
];

// Rspack reports nested lazy chunks as descendants of the code-view group.
// Model what the browser actually requests for each conditional surface: a
// source preview does not fetch either CM6 or markdown-it, while a non-Markdown
// editor does not fetch markdown-it.
const markdownCode = code.filter(
  (chunkName) => !containsModule(chunkName, codeMirrorPatterns),
);
const readOnlyCode = markdownCode.filter(
  (chunkName) => !containsModule(chunkName, markdownDependencyPatterns),
);
const textEditorCode = code.filter(
  (chunkName) => !containsModule(chunkName, markdownDependencyPatterns),
);
const baseFiles = files.filter(
  (chunkName) => !containsModule(chunkName, markdownDependencyPatterns),
);
const notebookMarkdownRoute = [
  ...notebookMarkdown,
  ...files.filter((chunkName) =>
    containsModule(chunkName, markdownDependencyPatterns),
  ),
];
console.log(
  `ultralite editor largest language: ${largestCodeMirrorLanguage.language} (${(largestCodeMirrorLanguage.bytes / KiB).toFixed(1)} KiB Brotli)`,
);
console.log(
  `ultralite read-only largest language: ${largestPrismLanguage.language} (${(largestPrismLanguage.bytes / KiB).toFixed(1)} KiB Brotli)`,
);

const surfaces = [
  { label: "shell", chunks: initial, max: 75 * KiB },
  { label: "projects", chunks: [...initial, ...projects], max: 400 * KiB },
  {
    label: "files and read-only Jupyter",
    chunks: [...initial, ...workspace, ...baseFiles],
    max: 425 * KiB,
  },
  {
    label: "read-only Jupyter with Markdown",
    chunks: [...initial, ...workspace, ...baseFiles, ...notebookMarkdownRoute],
    max: 500 * KiB,
  },
  {
    label: "recent files",
    chunks: [...initial, ...workspace, ...recent],
    max: 425 * KiB,
  },
  {
    label: "syntax-highlighted code",
    // A browser requests only the grammar for the displayed file. Count the
    // largest parser rather than summing mutually exclusive language chunks.
    chunks: [
      ...initial,
      ...workspace,
      ...baseFiles,
      ...readOnlyCode,
      ...largestPrismLanguage.chunks,
    ],
    max: 450 * KiB,
  },
  {
    label: "rendered Markdown",
    chunks: [...initial, ...workspace, ...baseFiles, ...markdownCode],
    max: 500 * KiB,
  },
  {
    label: "rendered Markdown with mathematics",
    chunks: [
      ...initial,
      ...workspace,
      ...baseFiles,
      ...markdownCode,
      ...katexComponent,
      ...katex,
    ],
    max: 650 * KiB,
  },
  {
    label: "text and code editor",
    // Only the parser for the selected file is requested. Count the largest
    // parser instead of summing mutually exclusive language chunks.
    chunks: [
      ...initial,
      ...workspace,
      ...baseFiles,
      ...textEditorCode,
      ...largestPrismLanguage.chunks,
      ...codeMirror,
      ...largestCodeMirrorLanguage.chunks,
    ],
    max: 650 * KiB,
  },
  {
    label: "Markdown editor",
    chunks: [
      ...initial,
      ...workspace,
      ...baseFiles,
      ...code,
      ...codeMirror,
      ...largestCodeMirrorLanguage.chunks,
    ],
    max: 700 * KiB,
  },
  {
    label: "executable Jupyter",
    // Notebook cells use the same lazy parser selection as the file editor.
    chunks: [
      ...initial,
      ...workspace,
      ...baseFiles,
      ...notebookExecute,
      ...largestCodeMirrorLanguage.chunks,
    ],
    max: 650 * KiB,
  },
  {
    label: "executable Jupyter with Markdown",
    chunks: [
      ...initial,
      ...workspace,
      ...baseFiles,
      ...notebookExecute,
      ...notebookMarkdownRoute,
      ...largestCodeMirrorLanguage.chunks,
    ],
    max: 700 * KiB,
  },
  {
    label: "Jupyter notebook index",
    chunks: [...initial, ...workspace, ...notebooks],
    max: 450 * KiB,
  },
  {
    label: "Codex chat",
    chunks: [...initial, ...workspace, ...chat],
    max: 550 * KiB,
  },
  {
    label: "Codex chat with mathematics",
    chunks: [...initial, ...workspace, ...chat, ...katexComponent, ...katex],
    max: 700 * KiB,
  },
  {
    label: "VMs",
    chunks: [...initial, ...workspace, ...vms],
    max: 450 * KiB,
  },
  {
    label: "app servers",
    chunks: [...initial, ...workspace, ...apps],
    max: 475 * KiB,
  },
  {
    label: "CLI discovery",
    chunks: [...initial, ...workspace, ...cli],
    max: 425 * KiB,
  },
  {
    label: "terminal",
    chunks: [...initial, ...workspace, ...terminal],
    max: 500 * KiB,
  },
  {
    label: "notifications",
    chunks: [...initial, ...notifications],
    max: 475 * KiB,
  },
  {
    label: "minimal project settings",
    chunks: [...initial, ...workspace, ...settings],
    max: 425 * KiB,
  },
];

const forbidden = [
  "node_modules/.pnpm/antd@",
  "node_modules/.pnpm/@ant-design/",
  "node_modules/.pnpm/jquery@",
  "node_modules/.pnpm/redux@",
  "node_modules/.pnpm/immutable@",
  "node_modules/.pnpm/slate@",
  "node_modules/.pnpm/codemirror@",
  "node_modules/.pnpm/monaco-editor@",
  "node_modules/.pnpm/ace-builds@",
  "node_modules/.pnpm/prosemirror-",
  "node_modules/.pnpm/@jupyterlab/",
];

let failed = false;
const report = [];
for (const surface of surfaces) {
  const summary = assetSummary(surface.chunks);
  const bytes = summary.brotliBytes;
  report.push({ label: surface.label, limitBytes: surface.max, ...summary });
  console.log(
    `ultralite ${surface.label}: raw=${(summary.rawBytes / KiB).toFixed(1)} KiB gzip=${(summary.gzipBytes / KiB).toFixed(1)} KiB brotli=${(bytes / KiB).toFixed(1)} KiB requests=${summary.requests} limit=${(surface.max / KiB).toFixed(0)} KiB`,
  );
  if (bytes > surface.max) {
    failed = true;
    console.error(
      `ultralite ${surface.label} exceeds its Brotli budget by ${((bytes - surface.max) / KiB).toFixed(1)} KiB`,
    );
  }
  for (const chunkName of new Set(surface.chunks)) {
    for (const moduleName of Object.keys(chunks[chunkName]?.importers ?? {})) {
      const match = moduleName.startsWith("frontend/")
        ? "frontend/"
        : forbidden.find((pattern) => moduleName.includes(pattern));
      if (match) {
        failed = true;
        console.error(
          `ultralite ${surface.label} includes forbidden module '${moduleName}' via '${match}'`,
        );
      }
    }
  }
}

writeFileSync(
  resolve(output, "ultralite-budget-report.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), surfaces: report }, null, 2)}\n`,
);

if (failed) process.exit(1);
