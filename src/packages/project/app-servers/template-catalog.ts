import type { AppTemplateCatalogEntry } from "@cocalc/conat/project/api/apps";
import {
  type AppTemplateCatalogEntryV1,
  builtinAppTemplateCatalog,
  isAppTemplateCatalogV1,
  mergeAppTemplateCatalogs,
} from "@cocalc/util/apps/template-catalog";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

const REMOTE_CATALOG_URL =
  `${process.env.COCALC_APP_TEMPLATE_CATALOG_URL ?? ""}`.trim() ||
  "https://software.cocalc.ai/software/cocalc/apps/templates/catalog-v1.json";
const REMOTE_CATALOG_TTL_MS = 5 * 60 * 1000;
const REMOTE_CATALOG_TIMEOUT_MS = 5_000;
const PROJECT_LOCAL_CATALOG_DIR = join(
  homedir(),
  ".local/share/cocalc/app-templates",
);

let remoteCatalogCache:
  | {
      at: number;
      catalog?: ReturnType<typeof builtinAppTemplateCatalog>;
    }
  | undefined;

async function fetchRemoteCatalog() {
  if (remoteCatalogCache && Date.now() - remoteCatalogCache.at < REMOTE_CATALOG_TTL_MS) {
    return remoteCatalogCache.catalog;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_CATALOG_TIMEOUT_MS);
  try {
    const response = await fetch(REMOTE_CATALOG_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });
    if (!response.ok) {
      remoteCatalogCache = { at: Date.now(), catalog: undefined };
      return;
    }
    const json = await response.json();
    const catalog = isAppTemplateCatalogV1(json) ? json : undefined;
    remoteCatalogCache = { at: Date.now(), catalog };
    return catalog;
  } catch {
    remoteCatalogCache = { at: Date.now(), catalog: undefined };
    return;
  } finally {
    clearTimeout(timer);
  }
}

function isTemplateEntry(value: unknown): value is AppTemplateCatalogEntryV1 {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const preset = entry.preset;
  return (
    typeof entry.id === "string" &&
    preset != null &&
    typeof preset === "object" &&
    !Array.isArray(preset)
  );
}

async function loadProjectLocalTemplateEntries(): Promise<AppTemplateCatalogEntry[]> {
  let names: string[];
  try {
    names = (await readdir(PROJECT_LOCAL_CATALOG_DIR))
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const entries: AppTemplateCatalogEntry[] = [];
  for (const name of names) {
    const path = join(PROJECT_LOCAL_CATALOG_DIR, name);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (isAppTemplateCatalogV1(parsed)) {
        for (const template of parsed.templates) {
          entries.push({
            ...template,
            template_source: parsed.source || name,
            template_scope: "project-local",
            source_path: path,
          });
        }
        continue;
      }
      if (isTemplateEntry(parsed)) {
        entries.push({
          ...parsed,
          template_source: name,
          template_scope: "project-local",
          source_path: path,
        });
      }
    } catch {
      // ignore malformed local template files for now
    }
  }
  return entries;
}

export async function listAppTemplates(): Promise<AppTemplateCatalogEntry[]> {
  const remoteCatalog = await fetchRemoteCatalog();
  const builtinCatalog = builtinAppTemplateCatalog();
  const builtin = builtinCatalog.templates.map((template) => ({
    ...template,
    template_source: "builtin",
    template_scope: "builtin" as const,
  }));
  const remote = (remoteCatalog?.templates ?? []).map((template) => ({
    ...template,
    template_source: remoteCatalog?.source || REMOTE_CATALOG_URL,
    template_scope: "remote" as const,
  }));
  const projectLocal = await loadProjectLocalTemplateEntries();
  return mergeAppTemplateCatalogs([
    {
      version: 1,
      kind: "cocalc-app-template-catalog",
      source: "builtin",
      published_at: builtinCatalog.published_at,
      templates: builtin,
    },
    remote.length
      ? {
          version: 1,
          kind: "cocalc-app-template-catalog",
          source: remoteCatalog?.source || REMOTE_CATALOG_URL,
          published_at: remoteCatalog?.published_at || new Date(0).toISOString(),
          templates: remote,
        }
      : undefined,
    projectLocal.length
      ? {
          version: 1,
          kind: "cocalc-app-template-catalog",
          source: "project-local",
          published_at: new Date(0).toISOString(),
          templates: projectLocal,
        }
      : undefined,
  ]) as AppTemplateCatalogEntry[];
}
