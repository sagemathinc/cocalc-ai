/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { ExternalChangeActions, validateNewEntryName } from "./file-surface";

test.each(["analysis.py", "data set", "spiral.ipynb"])(
  "accepts the leaf name %s",
  (name) => expect(validateNewEntryName(name)).toBe(name),
);

test.each(["", ".", "..", "nested/file", "nested\\file", "bad\0name"])(
  "rejects the unsafe leaf name %p",
  (name) => expect(() => validateNewEntryName(name)).toThrow(),
);

test("offers explicit accessible actions for an external file change", () => {
  const onMerge = jest.fn();
  const onReload = jest.fn();
  render(
    createElement(ExternalChangeActions, {
      merging: false,
      onMerge,
      onReload,
    }),
  );

  const merge = screen.getByRole("button", { name: "Merge disk changes" });
  const reload = screen.getByRole("button", {
    name: "Discard draft and reload",
  });
  merge.focus();
  expect(merge).toHaveFocus();

  fireEvent.click(merge);
  fireEvent.click(reload);
  expect(onMerge).toHaveBeenCalledTimes(1);
  expect(onReload).toHaveBeenCalledTimes(1);
});
