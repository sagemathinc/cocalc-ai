export type AppTemplateKind = "service" | "static";
export type AppTemplateServiceOpenMode = "proxy" | "port";
export type AppTemplateStaticIntegrationMode = "cocalc-public-viewer";
export type AppTemplateStaticViewerCacheMode =
  | "live-editing"
  | "balanced"
  | "published";
import builtinCatalog from "./builtin-template-catalog";

export interface AppTemplateDetectV1 {
  commands?: string[];
}

export interface AppTemplateInstallRecipeMatchV1 {
  os_family?: string[];
  distro?: string[];
}

export interface AppTemplateInstallRecipeV1 {
  id: string;
  match?: AppTemplateInstallRecipeMatchV1;
  commands: string[];
  notes?: string;
}

export interface AppTemplateInstallV1 {
  strategy: "curated" | "agent" | "none";
  command?: string;
  hint?: string;
  agent_prompt?: string;
  recipes?: AppTemplateInstallRecipeV1[];
}

export interface AppTemplatePresetV1 {
  id: string;
  title: string;
  kind: AppTemplateKind;
  command?: string;
  service_open_mode?: AppTemplateServiceOpenMode;
  preferred_port?: string;
  health_path?: string;
  static_root_relative?: string;
  static_index?: string;
  static_cache_control?: string;
  static_refresh_command?: string;
  static_refresh_stale_after?: string;
  static_refresh_timeout?: string;
  static_refresh_on_hit?: boolean;
  static_integration_mode?: AppTemplateStaticIntegrationMode;
  static_integration_file_types?: string[];
  static_integration_manifest?: string;
  static_integration_auto_refresh_s?: number;
  static_integration_cache_mode?: AppTemplateStaticViewerCacheMode;
  note?: string;
}

export interface AppTemplateThemeV1 {
  icon?: string;
  accent_color?: string;
  surface_color?: string;
  hero_image?: string;
}

export interface AppTemplateCatalogEntryV1 {
  id: string;
  title: string;
  short_label?: string;
  category: string;
  priority: number;
  theme?: AppTemplateThemeV1;
  homepage?: string;
  description?: string;
  detect?: AppTemplateDetectV1;
  install?: AppTemplateInstallV1;
  preset: AppTemplatePresetV1;
  verify?: {
    commands?: string[];
  };
  agent_prompt_seed?: string;
}

export interface AppTemplateCatalogV1 {
  version: 1;
  kind: "cocalc-app-template-catalog";
  source: string;
  published_at: string;
  templates: AppTemplateCatalogEntryV1[];
}

export interface AppTemplateCatalogSourceV1 {
  source: string;
  catalog: AppTemplateCatalogV1;
}

export function sortAppTemplateCatalogEntries<
  T extends { priority?: number; title?: string },
>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const byPriority = Number(b.priority ?? 0) - Number(a.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    return `${a.title ?? ""}`.localeCompare(`${b.title ?? ""}`);
  });
}

export function builtinAppTemplateCatalog(): AppTemplateCatalogV1 {
  return builtinCatalog;
}

export function isAppTemplateCatalogV1(
  value: unknown,
): value is AppTemplateCatalogV1 {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const catalog = value as Record<string, unknown>;
  return (
    catalog.version === 1 &&
    catalog.kind === "cocalc-app-template-catalog" &&
    Array.isArray(catalog.templates)
  );
}

export function mergeAppTemplateCatalogs(
  catalogs: Array<AppTemplateCatalogV1 | undefined | null>,
): AppTemplateCatalogEntryV1[] {
  const merged = new Map<string, AppTemplateCatalogEntryV1>();
  for (const catalog of catalogs) {
    if (!catalog) continue;
    for (const template of catalog.templates ?? []) {
      if (!template?.id) continue;
      merged.set(template.id, template);
    }
  }
  return sortAppTemplateCatalogEntries(Array.from(merged.values()));
}
