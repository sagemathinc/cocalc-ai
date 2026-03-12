/** @jest-environment jsdom */

import { isDirViaFs } from "./is-dir";

describe("isDirViaFs", () => {
  it("uses fs.stat and returns whether the path is a directory", async () => {
    const stat = jest.fn(async (_path: string) => ({
      isDirectory: () => true,
    }));

    await expect(isDirViaFs({ stat } as any, "docs")).resolves.toBe(true);
    expect(stat).toHaveBeenCalledWith("docs");
  });

  it("returns false when stat fails", async () => {
    const stat = jest.fn(async (_path: string) => {
      throw new Error("ENOENT");
    });

    await expect(isDirViaFs({ stat } as any, "missing")).resolves.toBe(false);
  });
});
