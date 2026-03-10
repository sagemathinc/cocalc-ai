import type { AppTemplateCatalogEntry } from "@cocalc/conat/project/api/apps";
import {
  builtinAppTemplateCatalog,
  isAppTemplateCatalogV1,
  mergeAppTemplateCatalogs,
} from "@cocalc/util/apps/template-catalog";

const REMOTE_CATALOG_URL =
  `${process.env.COCALC_APP_TEMPLATE_CATALOG_URL ?? ""}`.trim() ||
  "https://software.cocalc.ai/software/cocalc/apps/templates/catalog-v1.json";
const REMOTE_CATALOG_TTL_MS = 5 * 60 * 1000;
const REMOTE_CATALOG_TIMEOUT_MS = 5_000;

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

export async function listAppTemplates(): Promise<AppTemplateCatalogEntry[]> {
  const remoteCatalog = await fetchRemoteCatalog();
  return mergeAppTemplateCatalogs([builtinAppTemplateCatalog(), remoteCatalog]);
}
