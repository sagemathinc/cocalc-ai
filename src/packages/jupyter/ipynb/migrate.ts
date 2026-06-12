/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { legacyEscapedMathDelimitersToText } from "@cocalc/util/misc";

export const CURRENT_COCALC_NOTEBOOK_SCHEMA_VERSION = 1;

function isObject(value: unknown): value is { [key: string]: any } {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isLegacySchemaVersion(version: unknown): boolean {
  return typeof version !== "number" || version < 1;
}

function isCocalcComOriginNotebook(ipynb: any): boolean {
  return isObject(ipynb?.metadata?.kernelspec?.metadata?.cocalc);
}

function migrateSource(source: any): { source: any; changed: boolean } {
  if (typeof source === "string") {
    const migrated = legacyEscapedMathDelimitersToText(source);
    return { source: migrated, changed: migrated !== source };
  }
  if (Array.isArray(source)) {
    let changed = false;
    const migrated = source.map((part) => {
      if (typeof part !== "string") {
        return part;
      }
      const next = legacyEscapedMathDelimitersToText(part);
      if (next !== part) {
        changed = true;
      }
      return next;
    });
    return { source: changed ? migrated : source, changed };
  }
  return { source, changed: false };
}

export function migrateLegacyCocalcMarkdownNotebook(ipynb: any): boolean {
  if (!isCocalcComOriginNotebook(ipynb)) {
    return false;
  }
  if (!isObject(ipynb.metadata)) {
    ipynb.metadata = {};
  }
  if (!isObject(ipynb.metadata.cocalc)) {
    ipynb.metadata.cocalc = {};
  }
  if (!isLegacySchemaVersion(ipynb.metadata.cocalc.schemaVersion)) {
    return false;
  }

  if (Array.isArray(ipynb.cells)) {
    for (const cell of ipynb.cells) {
      if (cell?.cell_type !== "markdown") {
        continue;
      }
      const migrated = migrateSource(cell.source);
      if (migrated.changed) {
        cell.source = migrated.source;
      }
    }
  }

  ipynb.metadata.cocalc.schemaVersion = CURRENT_COCALC_NOTEBOOK_SCHEMA_VERSION;
  return true;
}
