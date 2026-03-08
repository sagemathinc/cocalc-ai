import { basename } from "node:path";

import {
  getSyncDocDescriptor,
  type SyncDocDoctype,
} from "@cocalc/util/syncdoc-doctypes";
import { filename_extension } from "@cocalc/util/misc";

export interface TextDocumentAssociation {
  basename: string;
  extension: string | null;
  doctype: SyncDocDoctype;
  supportsTextApi: boolean;
  label: string;
}

function inferLabel(path: string, ext: string | null): string {
  const base = basename(path);
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return "Dockerfile";
  if (lower === "containerfile") return "Containerfile";
  if (lower === "makefile") return "Makefile";
  if (ext) return ext.toUpperCase();
  return "Text";
}

export function resolveTextDocumentAssociation(path: string): TextDocumentAssociation {
  const base = basename(path);
  const ext = filename_extension(path) || null;
  const descriptor = getSyncDocDescriptor(path);
  return {
    basename: base,
    extension: ext,
    doctype: descriptor.doctype,
    supportsTextApi: descriptor.doctype === "syncstring",
    label: inferLabel(path, ext),
  };
}
