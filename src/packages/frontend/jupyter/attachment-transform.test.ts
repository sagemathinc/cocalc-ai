/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";

import { attachmentTransform } from "./attachment-transform";
import { URL_REJECTED } from "@cocalc/frontend/lib/url-transform";

describe("attachmentTransform", () => {
  const cell = fromJS({
    id: "c1",
    attachments: {
      "diagram.png": { type: "base64", value: "AAAA" },
      "photo.jpg": { type: "base64", value: "BBBB" },
      "weird.bin": { type: "something-else", value: "CCCC" },
    },
  });

  it("resolves attachment: URLs to data URIs", () => {
    expect(attachmentTransform(cell, "attachment:diagram.png")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("normalizes jpg to jpeg", () => {
    expect(attachmentTransform(cell, "attachment:photo.jpg")).toBe(
      "data:image/jpeg;base64,BBBB",
    );
  });

  it("returns empty string for unknown attachment encodings", () => {
    expect(attachmentTransform(cell, "attachment:weird.bin")).toBe(
      URL_REJECTED,
    );
    expect(attachmentTransform(cell, "attachment:missing.png")).toBe(
      URL_REJECTED,
    );
  });

  it("leaves non-attachment URLs alone", () => {
    expect(attachmentTransform(cell, "https://example.com/x.png")).toBe(
      undefined,
    );
    expect(attachmentTransform(cell, undefined)).toBe(undefined);
  });
});
