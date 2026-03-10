import type { AppTemplateCatalogEntry } from "@cocalc/conat/project/api/apps";
import {
  builtinAppTemplateCatalog,
  mergeAppTemplateCatalogs,
} from "@cocalc/util/apps/template-catalog";

export async function listAppTemplates(): Promise<AppTemplateCatalogEntry[]> {
  return mergeAppTemplateCatalogs([builtinAppTemplateCatalog()]);
}
