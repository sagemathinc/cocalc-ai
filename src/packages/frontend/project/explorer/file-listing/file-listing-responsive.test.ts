/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { showFileListingDetailColumns } from "./file-listing";

describe("full-page file listing responsive columns", () => {
  it("reserves narrow screens for the filename column", () => {
    expect(showFileListingDetailColumns(320)).toBe(false);
    expect(showFileListingDetailColumns(779)).toBe(false);
  });

  it("shows file details when the listing has sufficient width", () => {
    expect(showFileListingDetailColumns(780)).toBe(true);
    expect(showFileListingDetailColumns(1200)).toBe(true);
  });
});
