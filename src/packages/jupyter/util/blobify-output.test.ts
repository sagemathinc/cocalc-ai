/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sha1 } from "@cocalc/util/misc";
import { blobifyOutputData } from "./blobify-output";

describe("blobifyOutputData", () => {
  const png = Buffer.from("png-bytes").toString("base64");

  it("moves images, PDFs and isolated HTML to the blob store", () => {
    const saved: { type: string; bytes: Buffer }[] = [];
    const data: any = {
      "image/png": png,
      "application/pdf": png,
      "text/html": "<html><body>doc</body></html>",
      "text/plain": "x",
    };
    blobifyOutputData(data, (bytes, s, type) => {
      saved.push({ type, bytes });
      return s;
    });
    expect(data["image/png"]).toBe(sha1(Buffer.from("png-bytes")));
    expect(saved.find((x) => x.type === "image/png")?.bytes.toString()).toBe(
      "png-bytes",
    );
    expect(data["text/html"]).toBeUndefined();
    expect(typeof data.iframe).toBe("string");
    expect(data["text/plain"]).toBe("x");
  });

  it("leaves inline HTML, already-processed values and failed saves alone", () => {
    const data: any = { "text/html": "<b>x</b>", "image/png": sha1("x") };
    blobifyOutputData(data, (_b, s) => s);
    expect(data["text/html"]).toBe("<b>x</b>");
    const failed: any = { "image/png": png };
    blobifyOutputData(failed, () => undefined);
    expect(failed["image/png"]).toBe(png);
  });
});
