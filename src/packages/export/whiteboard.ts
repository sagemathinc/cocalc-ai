import type { ExportBundle, ExportFile } from "./bundle";
import {
  type ExportAssetIndexEntry,
  buildRelativeBlobReplacementMap,
  collectReferencedAssets,
  extractBlobReferences,
  rewriteBlobRefs,
} from "./blob-assets";
import {
  defaultExportRootDir,
  normalizeString,
  readJsonlRows,
  stringifyJsonlRows,
} from "./jsonl";
import { normalizeExportManifest } from "./manifest";

export interface WhiteboardExportOptions {
  documentPath: string;
  kind: "board" | "slides";
  includeBlobs?: boolean;
  blobBaseUrl?: string;
  blobBearerToken?: string;
  exportedAt?: string;
}

interface WhiteboardRow {
  id: string;
  type: string;
  page?: string;
  str?: string;
  x?: number;
  y?: number;
  z?: number;
  invisible?: boolean;
  data?: { pos?: number; aspectRatio?: string } & Record<string, unknown>;
}

interface WhiteboardPageIndexEntry {
  page_id: string;
  position: number;
  title?: string;
  element_count: number;
  invisible_element_count: number;
  content_path: string;
  elements_path: string;
  notes_path?: string;
  asset_refs?: ExportAssetIndexEntry[];
}

interface WhiteboardDocumentData {
  path: string;
  kind: "board" | "slides";
  page_count: number;
  element_count: number;
  invisible_element_count: number;
  asset_refs?: ExportAssetIndexEntry[];
  presentation?: {
    aspect_ratio: string;
  };
}

export async function collectWhiteboardExport(
  options: WhiteboardExportOptions,
): Promise<ExportBundle> {
  const rows = (await readJsonlRows(options.documentPath)).filter(
    isWhiteboardRow,
  );
  const pageRows = rows.filter((row) => row.type === "page").sort(comparePages);
  const pageIds = pageRows.map((row) => row.id);
  const firstPageId = pageIds[0];
  const pageState = new Map<
    string,
    { visible: WhiteboardRow[]; invisible: WhiteboardRow[] }
  >();
  for (const pageId of pageIds) {
    pageState.set(pageId, { visible: [], invisible: [] });
  }
  for (const row of rows) {
    if (row.type === "page") continue;
    const pageId = normalizeString(row.page) ?? firstPageId;
    if (!pageId) continue;
    if (!pageState.has(pageId)) {
      pageState.set(pageId, { visible: [], invisible: [] });
    }
    if (row.invisible === true) {
      pageState.get(pageId)!.invisible.push(normalizeWhiteboardRow(row));
    } else {
      pageState.get(pageId)!.visible.push(normalizeWhiteboardRow(row));
    }
  }

  const assetResult = options.includeBlobs
    ? await collectReferencedAssets({
        contents: rows.map((row) => row.str),
        blobBaseUrl: normalizeString(options.blobBaseUrl),
        blobBearerToken: normalizeString(options.blobBearerToken),
      })
    : undefined;
  const assetIndex = assetResult?.index ?? [];
  const rawReplacements = buildRelativeBlobReplacementMap(
    "document.jsonl",
    assetIndex,
  );

  const files: ExportFile[] = [];
  files.push({
    path: "README.md",
    content: renderWhiteboardExportReadme(
      options.kind,
      options.includeBlobs === true,
    ),
  });
  const pageIndex: WhiteboardPageIndexEntry[] = [];
  const documentSections: string[] = [
    options.kind === "slides" ? "# Slides Export" : "# Whiteboard Export",
    "",
  ];

  for (let index = 0; index < pageRows.length; index += 1) {
    const page = pageRows[index];
    const ordinal = `${index + 1}`.padStart(4, "0");
    const dir = `pages/${ordinal}-${page.id}`;
    const visible = [...(pageState.get(page.id)?.visible ?? [])].sort(
      compareElements,
    );
    const invisible = [...(pageState.get(page.id)?.invisible ?? [])].sort(
      compareElements,
    );
    const pageAssetRefs = collectPageAssetRefs(
      visible,
      invisible,
      assetResult?.byOriginalRef,
    );
    const contentPath = `${dir}/content.md`;
    const elementsPath = `${dir}/elements.jsonl`;
    const notesPath =
      options.kind === "slides" ? `${dir}/speaker-notes.md` : undefined;
    const contentReplacements = buildRelativeBlobReplacementMap(
      contentPath,
      pageAssetRefs,
    );
    const elementsReplacements = buildRelativeBlobReplacementMap(
      elementsPath,
      pageAssetRefs,
    );
    const notesReplacements = notesPath
      ? buildRelativeBlobReplacementMap(notesPath, pageAssetRefs)
      : new Map<string, string>();

    const pageContent = renderElementMarkdown(visible, contentReplacements);
    const notesContent = renderSpeakerNotes(invisible, notesReplacements);
    const title = derivePageTitle(pageContent);

    files.push({
      path: `${dir}/page.json`,
      content: `${JSON.stringify(
        {
          page_id: page.id,
          position: typeof page.data?.pos === "number" ? page.data.pos : index,
          title,
          element_count: visible.length,
          invisible_element_count: invisible.length,
          asset_refs: pageAssetRefs.length ? pageAssetRefs : undefined,
          ...(notesPath ? { notes_path: notesPath } : {}),
        },
        null,
        2,
      )}\n`,
    });
    files.push({
      path: elementsPath,
      content: stringifyJsonlRows(
        visible.map((row) => ({
          ...row,
          str: rewriteMaybeBlobRefs(row.str, elementsReplacements),
        })),
      ),
    });
    files.push({ path: contentPath, content: pageContent });
    if (notesPath) {
      files.push({ path: notesPath, content: notesContent });
    }
    pageIndex.push({
      page_id: page.id,
      position: typeof page.data?.pos === "number" ? page.data.pos : index,
      title,
      element_count: visible.length,
      invisible_element_count: invisible.length,
      content_path: contentPath,
      elements_path: elementsPath,
      notes_path: notesPath,
      asset_refs: pageAssetRefs.length ? pageAssetRefs : undefined,
    });

    documentSections.push(
      `## Page ${index + 1}${title ? `: ${title}` : ""}`,
      "",
      pageContent.trim() || "(empty)",
      "",
    );
    if (notesPath && notesContent.trim()) {
      documentSections.push("### Speaker Notes", "", notesContent.trim(), "");
    }
    documentSections.push("---", "");
  }

  files.push({
    path: "document.jsonl",
    content: stringifyJsonlRows(
      rows.map((row) => ({
        ...row,
        str: rewriteMaybeBlobRefs(row.str, rawReplacements),
      })),
    ),
  });
  files.push({
    path: "pages/index.json",
    content: `${JSON.stringify(pageIndex, null, 2)}\n`,
  });
  files.push({
    path: "document.md",
    content: `${documentSections.join("\n").trim()}\n`,
  });

  const documentData: WhiteboardDocumentData = {
    path: options.documentPath,
    kind: options.kind,
    page_count: pageRows.length,
    element_count: rows.filter(
      (row) => row.type !== "page" && row.invisible !== true,
    ).length,
    invisible_element_count: rows.filter((row) => row.invisible === true)
      .length,
    asset_refs: assetIndex.length ? assetIndex : undefined,
    presentation:
      options.kind === "slides"
        ? {
            aspect_ratio: findSlidesAspectRatio(rows) ?? "16:9",
          }
        : undefined,
  };
  files.push({
    path: "document.json",
    content: `${JSON.stringify(documentData, null, 2)}\n`,
  });
  if (assetIndex.length) {
    files.push({
      path: "assets/index.json",
      content: `${JSON.stringify(assetIndex, null, 2)}\n`,
    });
  }

  return {
    manifest: normalizeExportManifest({
      format: "cocalc-export",
      version: 1,
      kind: options.kind,
      exported_at: options.exportedAt ?? new Date().toISOString(),
      entrypoints: {
        human_overview: "README.md",
        machine_index: "pages/index.json",
        canonical_data: ["document.jsonl", "pages/<page>/elements.jsonl"],
        derived_views:
          options.kind === "slides"
            ? [
                "document.md",
                "pages/<page>/content.md",
                "pages/<page>/speaker-notes.md",
              ]
            : ["document.md", "pages/<page>/content.md"],
        assets_index: assetIndex.length ? "assets/index.json" : undefined,
      },
      agent_hints: {
        local_first: true,
        reconstruction_source: "document.jsonl",
        derived_files_are_optional: true,
      },
      source: { path: options.documentPath },
      page_count: pageRows.length,
      element_count: documentData.element_count,
      asset_count: assetIndex.length,
    }),
    rootDir: defaultExportRootDir(options.documentPath, options.kind),
    files,
    assets: assetResult?.assets,
  };
}

function renderWhiteboardExportReadme(
  kind: "board" | "slides",
  includeBlobs: boolean,
): string {
  const label = kind === "slides" ? "Slides" : "Whiteboard";
  const notesLine =
    kind === "slides"
      ? "- Slides also include per-page `speaker-notes.md` files.\n"
      : "";
  return `# ${label} Export

This archive is designed for both people and agents.

Start here:

- Read \`manifest.json\` for top-level metadata and entrypoints.
- Read \`document.json\` for document-level counts and metadata.
- Use \`pages/index.json\` to discover pages and their exported paths.
- Treat \`document.jsonl\` as the canonical reconstructable document stream.
- Treat \`pages/<page>/elements.jsonl\` as the canonical page-scoped element data.
- Treat \`document.md\` and \`pages/<page>/content.md\` as derived human-readable views.
${notesLine}
Blob references are ${includeBlobs ? "copied into `assets/` and rewritten to local paths." : "left as external references because blobs were not included."}

Recommended agent workflow:

1. Inspect \`document.json\` and \`pages/index.json\`.
2. Work from \`document.jsonl\` / \`elements.jsonl\` for transformation or reconstruction.
3. Use the markdown files for quick reading-order inspection or downstream text-based conversions.
4. If you rebuild the live document later, prefer the canonical JSONL over the derived markdown.
`;
}

function isWhiteboardRow(row: any): row is WhiteboardRow {
  return (
    typeof normalizeString(row?.id) === "string" &&
    typeof normalizeString(row?.type) === "string"
  );
}

function normalizeWhiteboardRow(row: WhiteboardRow): WhiteboardRow {
  return {
    ...row,
    id: normalizeString(row.id) ?? "",
    type: normalizeString(row.type) ?? "",
    page: normalizeString(row.page),
    str: typeof row.str === "string" ? row.str : undefined,
    invisible: row.invisible === true,
  };
}

function comparePages(a: WhiteboardRow, b: WhiteboardRow): number {
  const posA = typeof a.data?.pos === "number" ? a.data.pos : 0;
  const posB = typeof b.data?.pos === "number" ? b.data.pos : 0;
  if (posA !== posB) return posA - posB;
  return a.id.localeCompare(b.id);
}

function compareElements(a: WhiteboardRow, b: WhiteboardRow): number {
  const yA = typeof a.y === "number" ? a.y : 0;
  const yB = typeof b.y === "number" ? b.y : 0;
  if (yA !== yB) return yA - yB;
  const xA = typeof a.x === "number" ? a.x : 0;
  const xB = typeof b.x === "number" ? b.x : 0;
  if (xA !== xB) return xA - xB;
  const zA = typeof a.z === "number" ? a.z : 0;
  const zB = typeof b.z === "number" ? b.z : 0;
  if (zA !== zB) return zA - zB;
  return a.id.localeCompare(b.id);
}

function collectPageAssetRefs(
  visible: WhiteboardRow[],
  invisible: WhiteboardRow[],
  byOriginalRef: Map<string, ExportAssetIndexEntry> | undefined,
): ExportAssetIndexEntry[] {
  if (!byOriginalRef) return [];
  const refs = new Map<string, ExportAssetIndexEntry>();
  for (const row of [...visible, ...invisible]) {
    for (const ref of extractBlobReferences(row.str)) {
      const asset = byOriginalRef.get(ref.originalRef);
      if (asset) refs.set(asset.originalRef, asset);
    }
  }
  return Array.from(refs.values()).sort((a, b) =>
    a.originalRef.localeCompare(b.originalRef),
  );
}

function renderElementMarkdown(
  elements: WhiteboardRow[],
  replacements: Map<string, string>,
): string {
  const parts = elements
    .filter((row) => typeof row.str === "string" && row.str.trim())
    .map((row) => {
      const value = rewriteBlobRefs(row.str ?? "", replacements);
      if (row.type === "code") {
        return `\`\`\`\n${value}\n\`\`\``;
      }
      return value;
    })
    .filter((value) => value.trim().length > 0);
  return parts.length ? `${parts.join("\n\n").trim()}\n` : "";
}

function renderSpeakerNotes(
  elements: WhiteboardRow[],
  replacements: Map<string, string>,
): string {
  const note = elements.find((row) => row.type === "speaker_notes");
  const value = note?.str ? rewriteBlobRefs(note.str, replacements) : "";
  return value.trim() ? `${value.trim()}\n` : "";
}

function derivePageTitle(content: string): string | undefined {
  const lines = `${content ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("#")) {
      return line.replace(/^#+\s*/, "").trim() || undefined;
    }
  }
  return lines[0] || undefined;
}

function rewriteMaybeBlobRefs(
  value: string | undefined,
  replacements: Map<string, string>,
): string | undefined {
  const normalized = normalizeString(value);
  return normalized ? rewriteBlobRefs(normalized, replacements) : undefined;
}

function findSlidesAspectRatio(rows: WhiteboardRow[]): string | undefined {
  for (const row of rows) {
    const aspectRatio = normalizeString(row.data?.aspectRatio);
    if (aspectRatio) return aspectRatio;
  }
  return undefined;
}
