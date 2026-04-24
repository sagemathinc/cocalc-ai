/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";

import { fallbackKernelSpec } from "../redux/store";

describe("fallbackKernelSpec", () => {
  it("preserves python3 notebook metadata when kernel discovery is not loaded", () => {
    expect(
      fallbackKernelSpec("python3", Map({ name: "python" })),
    ).toStrictEqual({
      name: "python3",
      display_name: "Python 3",
      language: "python",
    });
  });

  it("does not emit a kernelspec for no-kernel notebooks", () => {
    expect(fallbackKernelSpec("")).toBeUndefined();
    expect(fallbackKernelSpec(undefined)).toBeUndefined();
  });
});
