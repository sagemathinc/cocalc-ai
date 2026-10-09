/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { hasBlobImageReference } from "./blob-image-reference";

const PATTERN = /(?:<img\b[^>]*\bsrc=|!\[[^\]]*\]\()[^\n]*\/blobs\//i;

describe("hasBlobImageReference", () => {
  it("agrees with the image reference pattern", () => {
    const pieces = [
      "<img",
      "<IMG",
      "<imgx",
      " src=",
      "SRC=",
      "xsrc=",
      "src=",
      ">",
      "![",
      "]",
      "](",
      "(",
      "/blobs/",
      "/BLOBS/",
      "/blobs",
      "\n",
      " ",
      "a",
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 30000; i++) {
      let text = "";
      const n = Math.floor(random() * 10);
      for (let j = 0; j < n; j++) {
        text += pieces[Math.floor(random() * pieces.length)];
      }
      expect([text, hasBlobImageReference(text)]).toEqual([
        text,
        PATTERN.test(text),
      ]);
    }
  });

  it("checks every src= of an img tag, across lines", () => {
    expect(hasBlobImageReference('<img\nsrc="x"\nsrc="/blobs/a.png">')).toBe(
      true,
    );
    expect(hasBlobImageReference('<img src="x">\n/blobs/a.png')).toBe(false);
    expect(hasBlobImageReference("![a\nb](/blobs/a.png)")).toBe(true);
  });

  it("is linear on long prompts", () => {
    const started = Date.now();
    expect(hasBlobImageReference("![".repeat(500_000))).toBe(false);
    expect(hasBlobImageReference("<img ".repeat(200_000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
