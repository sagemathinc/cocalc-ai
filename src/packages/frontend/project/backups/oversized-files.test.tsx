/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getOversizedFiles } from "@cocalc/frontend/project/archive-info";
import { checkOversizedFiles } from "./oversized-files";

jest.mock("@cocalc/frontend/project/archive-info", () => ({
  getOversizedFiles: jest.fn(),
}));

const getOversizedFilesMock = jest.mocked(getOversizedFiles);

const REPORT = {
  max_file_bytes: 10_000_000_000,
  count: 2,
  files: [{ path: "data/sparse.img", size: 1_000_000_000_000 }],
};

function check() {
  return checkOversizedFiles({
    project_id: "11111111-1111-4111-8111-111111111111",
    paths: ["data"],
    title: "Move without these files?",
    okText: "Move and lose these files",
    consequence: "They will be deleted.",
  });
}

describe("checkOversizedFiles", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("proceeds without asking when nothing would be skipped", async () => {
    getOversizedFilesMock.mockResolvedValueOnce({ ...REPORT, count: 0 });
    await expect(check()).resolves.toEqual({
      proceed: true,
      allow_oversized_skip: false,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves the decision to the server when the check fails", async () => {
    getOversizedFilesMock.mockRejectedValueOnce(new Error("host offline"));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(check()).resolves.toEqual({
      proceed: true,
      allow_oversized_skip: false,
    });
  });

  it("requires an explicit confirmation before proceeding", async () => {
    getOversizedFilesMock.mockResolvedValueOnce(REPORT);
    const user = userEvent.setup();
    const result = check();

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Move without these files?");
    expect(dialog).toHaveTextContent("data/sparse.img");
    expect(dialog).toHaveTextContent("and 1 more");
    const ok = screen.getByRole("button", {
      name: "Move and lose these files",
    });
    expect(ok).toBeDisabled();

    const checkbox = screen.getByRole("checkbox", {
      name: /I understand that these files will not be included/,
    });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
    await waitFor(() => expect(ok).toBeEnabled());

    await user.click(ok);
    await expect(result).resolves.toEqual({
      proceed: true,
      allow_oversized_skip: true,
    });
  });

  it("cancels with Escape", async () => {
    getOversizedFilesMock.mockResolvedValueOnce(REPORT);
    const result = check();
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    });
    await expect(result).resolves.toEqual({
      proceed: false,
      allow_oversized_skip: false,
    });
  });
});
