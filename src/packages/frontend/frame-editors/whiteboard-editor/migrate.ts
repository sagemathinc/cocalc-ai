import { parseSyncdbFileUsingPageNumbers } from "./share/util";
import { uuid } from "@cocalc/util/misc";
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  isLegacyDocumentSchemaVersion,
  normalizeLegacyTextElement,
} from "./document-schema";
import type { Element } from "./types";

export function migrateToNewPageNumbers(syncdoc) {
  const contents = syncdoc.to_str();
  const pages = parseSyncdbFileUsingPageNumbers(contents);
  // generate unique new page ids and objects
  const newPages: {
    id: string;
    type: "page";
    z: 0;
    data: { pos: number; schemaVersion: number };
  }[] = [];
  for (let i = 0; i < Math.max(1, pages.length); i++) {
    let id = uuid().slice(0, 8);
    while (contents.includes(id)) {
      // dumb algorithm,  but this conversion is rare.
      id = uuid().slice(0, 8);
    }
    newPages.push({
      id,
      type: "page",
      z: 0,
      data: { pos: i, schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION },
    });
  }
  // update fix existing elements
  for (const page of pages) {
    for (let i = 0; i < page.length; i++) {
      const element = normalizeLegacyTextElement(page[i]);
      element.page =
        newPages[(element.page as unknown as number) - 1]?.id ?? newPages[0].id;
      page[i] = element;
    }
  }
  // write back all the elements and pages, were here Javascript is kind of eloquent:
  const newContents = [newPages, ...pages]
    .flat()
    .map((element) => JSON.stringify(element))
    .join("\n");
  syncdoc.from_str(newContents);
  syncdoc.commit();
}

export function migrateToCurrentDocumentSchema(syncdoc): boolean {
  const contents = syncdoc.to_str();
  const elements: Element[] = [];
  const legacyPageIds = new Set<string>();
  let sawPage = false;

  for (const line of contents.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let element: Element;
    try {
      element = JSON.parse(line);
    } catch (_err) {
      return false;
    }
    elements.push(element);
    if (element.type == "page") {
      sawPage = true;
      if (isLegacyDocumentSchemaVersion(element.data?.schemaVersion)) {
        legacyPageIds.add(element.id);
      }
    }
  }

  if (!sawPage || legacyPageIds.size == 0) {
    return false;
  }

  const migrated = elements.map((element) => {
    if (element.type == "page" && legacyPageIds.has(element.id)) {
      return {
        ...element,
        data: {
          ...element.data,
          schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
        },
      };
    }
    if (
      element.type == "text" &&
      element.page != null &&
      legacyPageIds.has(element.page)
    ) {
      return normalizeLegacyTextElement(element);
    }
    return element;
  });

  syncdoc.from_str(
    migrated.map((element) => JSON.stringify(element)).join("\n"),
  );
  syncdoc.commit();
  return true;
}
