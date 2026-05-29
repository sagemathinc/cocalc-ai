/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsActionParameter, DocsEntryImage } from "./types";

export function projectActionParameters(): DocsActionParameter[] {
  return [
    {
      label: "Project",
      name: "projectId",
      placeholder: "Select a project",
      required: true,
      type: "project",
    },
  ];
}

export function projectHostActionParameters(): DocsActionParameter[] {
  return [
    {
      label: "Project host",
      name: "hostId",
      placeholder: "Select a host",
      required: true,
      type: "project-host",
    },
  ];
}

export function docsIcon(src: string, alt: string): DocsEntryImage {
  return {
    alt,
    presentation: "icon",
    src,
    thumbnailSrc: src,
  };
}
