/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuidsha1 } from "@cocalc/backend/misc_node";
import {
  BLOB_ATTACHMENT_METADATA_KEY,
  blobUrlScanForTesting,
  embedCoCalcBlobImages,
  externalizeJupyterAttachments,
  MAX_BLOB_URL_LENGTH,
  MAX_JUPYTER_ATTACHMENT_COUNT,
} from "./blob-attachments";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const jpeg = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
const pngUuid = uuidsha1(png);
const jpegUuid = uuidsha1(jpeg);

function notebook(source: string | string[], attachments?: object): any {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: "markdown-1",
        cell_type: "markdown",
        metadata: {},
        source,
        ...(attachments == null ? {} : { attachments }),
      },
    ],
  };
}

describe("portable Jupyter blob attachments", () => {
  it("embeds a CoCalc blob URL without changing the live notebook", async () => {
    const live = notebook([
      "![diagram](/blobs/diagram.png?uuid=",
      `${pngUuid})\n`,
    ]);
    const loadBlob = jest.fn(async () => ({ bytes: png }));

    const saved = await embedCoCalcBlobImages({ ipynb: live, loadBlob });

    expect(live.cells[0].source.join("")).toContain("/blobs/diagram.png");
    expect(saved.cells[0].source.join("")).toBe(
      "![diagram](attachment:diagram.png)\n",
    );
    expect(saved.cells[0].attachments["diagram.png"]).toEqual({
      "image/png": png.toString("base64"),
    });
    expect(
      saved.cells[0].metadata.cocalc[BLOB_ATTACHMENT_METADATA_KEY],
    ).toMatchObject({
      version: 1,
      entries: {
        "diagram.png": {
          primary_mime: "image/png",
          variants: {
            "image/png": { uuid: pngUuid, content_id: pngUuid },
          },
        },
      },
    });
    expect(loadBlob).toHaveBeenCalledTimes(1);
  });

  it("embeds absolute CoCalc blob URLs and reuses repeated references", async () => {
    const live = notebook(
      `![one](https://cocalc.ai/blobs/diagram.png?uuid=${pngUuid})\n` +
        `<img src="https://cocalc.ai/blobs/diagram.png?uuid=${pngUuid}">`,
    );
    const loadBlob = jest.fn(async () => ({ bytes: png }));

    const saved = await embedCoCalcBlobImages({ ipynb: live, loadBlob });

    expect(saved.cells[0].source).toBe(
      "![one](attachment:diagram.png)\n" + '<img src="attachment:diagram.png">',
    );
    expect(Object.keys(saved.cells[0].attachments)).toEqual(["diagram.png"]);
    expect(loadBlob).toHaveBeenCalledTimes(1);
  });

  it("externalizes all safe MIME variants and reuses them on the next save", async () => {
    const original = notebook("![diagram](attachment:diagram)", {
      diagram: {
        "image/png": png.toString("base64"),
        "image/jpeg": jpeg.toString("base64"),
      },
    });
    const blobs = new Map<string, Buffer>();
    const saveBlob = jest.fn(async ({ bytes, content_id, filename }) => {
      blobs.set(content_id, bytes);
      return {
        uuid: content_id,
        url: `/blobs/${filename}?uuid=${content_id}`,
      };
    });
    const loadBlob = jest.fn(async (uuid: string) => {
      const bytes = blobs.get(uuid);
      return bytes == null ? undefined : { bytes };
    });

    const live = await externalizeJupyterAttachments({
      ipynb: original,
      loadBlob,
      saveBlob,
    });
    expect(live.cells[0].source).toContain("/blobs/diagram?uuid=");
    expect(live.cells[0].attachments).toBeUndefined();
    expect(saveBlob).toHaveBeenCalledTimes(2);

    loadBlob.mockClear();
    const savedAgain = await embedCoCalcBlobImages({
      ipynb: live,
      previousIpynb: {
        ...original,
        cells: [
          {
            ...original.cells[0],
            metadata: live.cells[0].metadata,
          },
        ],
      },
      loadBlob,
    });
    expect(savedAgain.cells[0].attachments.diagram).toEqual(
      original.cells[0].attachments.diagram,
    );
    expect(loadBlob).not.toHaveBeenCalled();
  });

  it("reuses valid metadata handles when reopening a saved notebook", async () => {
    const url = `/blobs/diagram.png?uuid=${pngUuid}`;
    const saved = notebook("![diagram](attachment:diagram.png)", {
      "diagram.png": { "image/png": png.toString("base64") },
    });
    saved.cells[0].metadata.cocalc = {
      [BLOB_ATTACHMENT_METADATA_KEY]: {
        version: 1,
        entries: {
          "diagram.png": {
            primary_mime: "image/png",
            variants: {
              "image/png": {
                uuid: pngUuid,
                url,
                content_id: pngUuid,
              },
            },
          },
        },
      },
    };
    const saveBlob = jest.fn();

    const live = await externalizeJupyterAttachments({
      ipynb: saved,
      loadBlob: async () => ({ bytes: png }),
      saveBlob,
    });

    expect(live.cells[0].source).toBe(`![diagram](${url})`);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("does not trust a metadata URL that is not a matching CoCalc blob URL", async () => {
    const saved = notebook("![diagram](attachment:diagram.png)", {
      "diagram.png": { "image/png": png.toString("base64") },
    });
    saved.cells[0].metadata.cocalc = {
      [BLOB_ATTACHMENT_METADATA_KEY]: {
        version: 1,
        entries: {
          "diagram.png": {
            primary_mime: "image/png",
            variants: {
              "image/png": {
                uuid: pngUuid,
                url: `https://example.com/blobs/image.png?uuid=${pngUuid}`,
                content_id: pngUuid,
              },
            },
          },
        },
      },
    };
    const saveBlob = jest.fn(async () => ({
      uuid: pngUuid,
      url: `/blobs/diagram.png?uuid=${pngUuid}`,
    }));

    const live = await externalizeJupyterAttachments({
      ipynb: saved,
      loadBlob: async () => ({ bytes: png }),
      saveBlob,
    });

    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(live.cells[0].source).toBe(
      `![diagram](/blobs/diagram.png?uuid=${pngUuid})`,
    );
  });

  it("preserves unavailable blob URLs while embedding available images", async () => {
    const missing = `/blobs/legacy.png?uuid=${pngUuid}`;
    const available = `/blobs/current.jpg?uuid=${jpegUuid}`;
    const live = notebook(
      `![legacy](${missing})\n![current](${available})\n![legacy again](${missing})`,
    );
    const loadBlob = jest.fn(async (uuid: string) =>
      uuid === jpegUuid ? { bytes: jpeg } : undefined,
    );

    const saved = await embedCoCalcBlobImages({ ipynb: live, loadBlob });

    expect(saved.cells[0].source).toBe(
      `![legacy](${missing})\n![current](attachment:current.jpg)\n![legacy again](${missing})`,
    );
    expect(saved.cells[0].attachments).toEqual({
      "current.jpg": { "image/jpeg": jpeg.toString("base64") },
    });
    expect(loadBlob).toHaveBeenCalledTimes(2);
    expect(live.cells[0].attachments).toBeUndefined();
  });

  it("still propagates blob service errors", async () => {
    const live = notebook(`![image](/blobs/image.png?uuid=${pngUuid})`);

    await expect(
      embedCoCalcBlobImages({
        ipynb: live,
        loadBlob: async () => {
          throw Error("blob service unavailable");
        },
      }),
    ).rejects.toThrow("blob service unavailable");
    expect(live.cells[0].attachments).toBeUndefined();
  });

  it("blocks unsafe native attachment types instead of publishing them", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const external = notebook("![unsafe](attachment:unsafe.svg)", {
      "unsafe.svg": { "image/svg+xml": svg.toString("base64") },
    });

    await expect(
      externalizeJupyterAttachments({
        ipynb: external,
        loadBlob: async () => undefined,
        saveBlob: jest.fn(),
      }),
    ).rejects.toThrow("unsupported MIME type image/svg+xml");
  });

  it("preserves unreferenced native attachments", async () => {
    const original = notebook("no image reference", {
      "unused.png": { "image/png": png.toString("base64") },
    });
    const saveBlob = jest.fn();

    const live = await externalizeJupyterAttachments({
      ipynb: original,
      loadBlob: jest.fn(),
      saveBlob,
    });

    expect(live.cells[0].attachments).toEqual(original.cells[0].attachments);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("preserves a missing native attachment reference", async () => {
    const original = notebook(
      '<img src="attachment:missing.png" alt="missing">',
    );
    const saveBlob = jest.fn();

    const live = await externalizeJupyterAttachments({
      ipynb: original,
      loadBlob: jest.fn(),
      saveBlob,
    });

    expect(live).toEqual(original);
    expect(saveBlob).not.toHaveBeenCalled();

    const saved = await embedCoCalcBlobImages({
      ipynb: live,
      previousIpynb: original,
      loadBlob: jest.fn(),
    });
    expect(saved).toEqual(original);
  });

  it("rejects excessive attachment references before blob I/O", async () => {
    const source = Array.from(
      { length: MAX_JUPYTER_ATTACHMENT_COUNT + 1 },
      (_, index) => `![${index}](attachment:image-${index}.png)`,
    ).join("\n");
    const saveBlob = jest.fn();

    await expect(
      externalizeJupyterAttachments({
        ipynb: notebook(source),
        loadBlob: jest.fn(),
        saveBlob,
      }),
    ).rejects.toThrow("too many image attachments");
    expect(saveBlob).not.toHaveBeenCalled();
  });

  describe("blob URL scan", () => {
    const { blobUrlMatches, GLOBAL_BLOB_URL } = blobUrlScanForTesting;
    const reference = (text: string) =>
      [...text.matchAll(GLOBAL_BLOB_URL)].map((m) => [m.index, m[0]]);
    const linear = (text: string) =>
      blobUrlMatches(text).map((m) => [m.index, m[0]]);

    it("finds exactly what the pattern finds", () => {
      const pieces = [
        "/blobs/a.png?uuid=1",
        "https://cocalc.ai/blobs/b.png?uuid=2",
        "HTTP://Example.COM/x/BLOBS/c",
        "blobs/",
        "/",
        "//",
        "https://",
        "http://h",
        "x",
        "blobs",
        " ",
        "\n",
        "(",
        ")",
        "[",
        "]",
        "<",
        ">",
        '"',
        "'",
        "![i](",
        '<img src="',
        "?uuid=",
        "%20",
      ];
      let seed = 12345;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 3000; i++) {
        let text = "";
        const n = 1 + Math.floor(random() * 12);
        for (let j = 0; j < n; j++) {
          text += pieces[Math.floor(random() * pieces.length)];
        }
        expect(linear(text)).toEqual(reference(text));
      }
    });

    it("scans a large inline base64 image in linear time", () => {
      // 3 MB of base64: about 2 minutes of CPU with the pattern itself.
      const base64 = Buffer.alloc(2_300_000, 7)
        .toString("base64")
        .replace(/c/g, "/");
      const url = `/blobs/diagram.png?uuid=${pngUuid}`;
      const text = `![inline](data:image/png;base64,${base64})\n![blob](${url})\n`;
      const started = Date.now();
      expect(linear(text)).toEqual([[text.indexOf(url), url]]);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("never treats a run longer than any blob URL as one", () => {
      const run = `/${"x".repeat(MAX_BLOB_URL_LENGTH)}blobs/a.png`;
      expect(linear(` ${run} `)).toEqual([]);
      const short = `/${"x".repeat(100)}blobs/a.png`;
      expect(linear(` ${short} `)).toEqual(reference(` ${short} `));
    });

    it("saves a notebook with a large inline image without stalling", async () => {
      const base64 = Buffer.alloc(2_300_000, 9)
        .toString("base64")
        .replace(/c/g, "/");
      const live = notebook(
        `![inline](data:image/png;base64,${base64})\n` +
          `![diagram](/blobs/diagram.png?uuid=${pngUuid})\n`,
      );
      const loadBlob = jest.fn(async () => ({ bytes: png }));
      const started = Date.now();
      const saved = await embedCoCalcBlobImages({ ipynb: live, loadBlob });
      expect(saved.cells[0].source).toContain(
        "![diagram](attachment:diagram.png)",
      );
      expect(saved.cells[0].source).toContain("data:image/png;base64,");
      const reopened = await externalizeJupyterAttachments({
        ipynb: saved,
        loadBlob,
        saveBlob: async ({ content_id, filename }) => ({
          uuid: content_id,
          url: `/blobs/${filename}?uuid=${content_id}`,
        }),
      });
      expect(reopened.cells[0].source).toContain(`/blobs/diagram.png?uuid=`);
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});
