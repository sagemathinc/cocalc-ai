/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { renderHook, waitFor } from "@testing-library/react";
import { List } from "immutable";
import { exec } from "@cocalc/frontend/frame-editors/generic/client";
import { useTexSummaries } from "./use-summarize";

jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  exec: jest.fn(),
}));

it("loads summaries once the home directory becomes available", async () => {
  const files = List(["/project/main.tex", "/project/chapter.tex"]);
  const run = jest.mocked(exec);
  run.mockResolvedValueOnce({ exit_code: 0, stdout: "", stderr: "" });
  run.mockResolvedValueOnce({
    exit_code: 0,
    stdout: JSON.stringify({ "/project/chapter.tex": "A chapter" }),
    stderr: "",
  });
  const { result, rerender } = renderHook(
    ({ homeDir }: { homeDir: string | null }) =>
      useTexSummaries(files, "project-1", "/project/main.tex", homeDir),
    { initialProps: { homeDir: null as string | null } },
  );
  expect(run).not.toHaveBeenCalled();
  rerender({ homeDir: "/home/user" });
  await waitFor(() =>
    expect(result.current.fileSummaries).toEqual({
      "/project/chapter.tex": "A chapter",
    }),
  );
  expect(run).toHaveBeenCalledTimes(2);
  expect(result.current.summariesLoading).toBe(false);
});
