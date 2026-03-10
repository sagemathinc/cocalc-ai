import type {
  AppTemplateCatalogEntryV1,
  AppTemplateKind,
  AppTemplateServiceOpenMode,
} from "@cocalc/util/apps/template-catalog";
import {
  builtinAppTemplateCatalog,
  mergeAppTemplateCatalogs,
} from "@cocalc/util/apps/template-catalog";

export type AppServiceOpenMode = AppTemplateServiceOpenMode;

export interface AppServerPreset {
  key: string;
  label: string;
  kind: AppTemplateKind;
  id: string;
  title: string;
  command?: string;
  serviceOpenMode?: AppServiceOpenMode;
  preferredPort?: string;
  healthPath?: string;
  staticRoot?: string;
  staticIndex?: string;
  staticCacheControl?: string;
  staticRefreshCommand?: string;
  staticRefreshStaleAfter?: string;
  staticRefreshTimeout?: string;
  staticRefreshOnHit?: boolean;
  note?: string;
  installCommand?: string;
  installHint?: string;
  installAgentPrompt?: string;
  description?: string;
  homepage?: string;
  category?: string;
  priority?: number;
}

function joinPath(head: string, tail: string): string {
  const h = `${head ?? ""}`.replace(/\/+$/, "");
  const t = `${tail ?? ""}`.replace(/^\/+/, "");
  return `${h}/${t}`;
}

function toPreset(
  template: AppTemplateCatalogEntryV1,
  homeDirectory: string,
): AppServerPreset {
  const preset = template.preset;
  return {
    key: template.id,
    label: template.short_label ?? template.title,
    kind: preset.kind,
    id: preset.id,
    title: preset.title,
    command: preset.command,
    serviceOpenMode: preset.service_open_mode,
    preferredPort: preset.preferred_port,
    healthPath: preset.health_path,
    staticRoot: preset.static_root_relative
      ? joinPath(homeDirectory, preset.static_root_relative)
      : undefined,
    staticIndex: preset.static_index,
    staticCacheControl: preset.static_cache_control,
    staticRefreshCommand: preset.static_refresh_command,
    staticRefreshStaleAfter: preset.static_refresh_stale_after,
    staticRefreshTimeout: preset.static_refresh_timeout,
    staticRefreshOnHit: preset.static_refresh_on_hit,
    note: preset.note,
    installCommand: template.install?.command,
    installHint: template.install?.hint,
    installAgentPrompt: template.install?.agent_prompt,
    description: template.description,
    homepage: template.homepage,
    category: template.category,
    priority: template.priority,
  };
}

export function appServerPresetsFromCatalogEntries(
  entries: AppTemplateCatalogEntryV1[],
  homeDirectory: string,
): AppServerPreset[] {
  return mergeAppTemplateCatalogs([
    {
      version: 1,
      kind: "cocalc-app-template-catalog",
      source: "merged",
      published_at: new Date(0).toISOString(),
      templates: entries,
    },
  ]).map((template) => toPreset(template, homeDirectory));
}

export function builtinAppServerPresets(
  homeDirectory: string,
): AppServerPreset[] {
  return appServerPresetsFromCatalogEntries(
    builtinAppTemplateCatalog().templates,
    homeDirectory,
  );
}
