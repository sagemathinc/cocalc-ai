/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import {
  exec,
  project_api,
} from "@cocalc/frontend/frame-editors/generic/client";
import { getSummaryHomeDirectory, summarizeTexFiles } from "./file-summaries";

jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  exec: jest.fn(),
  project_api: jest.fn(),
}));

it("runs Python directly without a shared temporary script", async () => {
  jest
    .mocked(exec)
    .mockResolvedValueOnce({
      exit_code: 0,
      stdout: '{"/project/chapter.tex":"A chapter"}',
      stderr: "",
    });
  expect(
    await summarizeTexFiles(
      ["/project/chapter.tex"],
      "project-1",
      "/project/main.tex",
      "/home/user",
    ),
  ).toEqual({ "/project/chapter.tex": "A chapter" });
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec).toHaveBeenCalledWith(
    expect.objectContaining({
      command: "python3",
      args: ["-c", expect.any(String), "/home/user", "/project/chapter.tex"],
    }),
  );
});

it("shares the home lookup and retries a failed lookup", async () => {
  const getHomeDirectory = jest
    .fn()
    .mockRejectedValueOnce(Error("offline"))
    .mockResolvedValue("/home/user");
  jest.mocked(project_api).mockResolvedValue({ getHomeDirectory } as any);
  const first = getSummaryHomeDirectory("home-test");
  expect(getSummaryHomeDirectory("home-test")).toBe(first);
  await expect(first).rejects.toThrow("offline");
  await expect(getSummaryHomeDirectory("home-test")).resolves.toBe(
    "/home/user",
  );
  await expect(getSummaryHomeDirectory("home-test")).resolves.toBe(
    "/home/user",
  );
  expect(getHomeDirectory).toHaveBeenCalledTimes(2);
});
