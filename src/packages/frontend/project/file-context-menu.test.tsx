/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { buildFileActionItems } from "./file-context-menu";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/project_actions", () => {
  const action = (defaultMessage: string) => ({
    name: { defaultMessage },
    icon: "copy",
    hideFlyout: false,
  });
  return {
    FILE_ACTIONS: {
      compress: action("Compress"),
      delete: action("Delete"),
      rename: action("Rename"),
      duplicate: action("Duplicate"),
      move: action("Move"),
      copy: action("Copy"),
      publish: action("Publish"),
      download: action("Download"),
    },
  };
});

const intl = {
  formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
} as any;

function menuKeys(isdir: boolean): string[] {
  return buildFileActionItems({
    isdir,
    intl,
    triggerFileAction: jest.fn(),
    fullPath: "share",
  })
    .filter((item: any) => item?.type !== "divider")
    .map((item: any) => item.key);
}

describe("buildFileActionItems", () => {
  it("includes publish for directory context menus", () => {
    expect(menuKeys(true)).toContain("publish");
  });

  it("does not include publish for file context menus", () => {
    expect(menuKeys(false)).not.toContain("publish");
  });
});
