/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PassThrough } from "node:stream";
import { forwardUploadChunkStream } from "./upload";

describe("project-host upload streaming", () => {
  it("contains an aborted chunk stream", async () => {
    const chunkStream = new PassThrough();
    const totalStream = new PassThrough();
    const onError = jest.fn();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    forwardUploadChunkStream({
      chunkStream,
      totalStream,
      onError,
      onDone: finish,
    });
    chunkStream.destroy(new Error("Premature close"));
    await done;

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Premature close" }),
    );
    expect(totalStream.destroyed).toBe(true);
  });
});
