/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TextDecoder } from "util";
import NotebooksSurface, { parseRecentNotebooks } from "./notebooks-surface";

global.TextDecoder = TextDecoder as typeof global.TextDecoder;

const project = {
  host_id: "notebook-host",
  project_id: "af027aca-e308-41c2-b528-a3e73de50996",
  title: "Notebook project",
} as any;

function bytes(value: string): Uint8Array {
  return Buffer.from(value);
}

test("parses, filters, orders, and bounds recent notebooks", () => {
  const records = parseRecentNotebooks(
    [
      "10\told.ipynb",
      "30\tsub/new.ipynb",
      "40\t.hidden/private.ipynb",
      "20\tnot-a-notebook.txt",
      "bad\tbroken.ipynb",
    ].join("\n"),
  );

  expect(records).toEqual([
    {
      modified: 30_000,
      path: "/home/user/sub/new.ipynb",
      relativePath: "sub/new.ipynb",
    },
    {
      modified: 10_000,
      path: "/home/user/old.ipynb",
      relativePath: "old.ipynb",
    },
  ]);
});

test("reuses the session cache until the user explicitly refreshes", async () => {
  const find = jest.fn(async () => ({
    code: 0,
    stderr: bytes(""),
    stdout: bytes("20\tanalysis.ipynb\n"),
  }));
  const session = {
    openProjectFiles: jest.fn(async () => ({ filesystem: { find } })),
  } as any;

  let rendered: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(<NotebooksSurface project={project} session={session} />);
  });
  expect(
    await screen.findByRole("button", {
      name: "Open notebook analysis.ipynb",
    }),
  ).toBeVisible();
  expect(find).toHaveBeenCalledTimes(1);
  expect(find).toHaveBeenCalledWith("/home/user", {
    linux: ["-printf", "%T@\t%P\n"],
    maxSize: 512 * 1024,
    options: [
      "(",
      "-path",
      "*/.*",
      "-prune",
      ")",
      "-o",
      "-type",
      "f",
      "-name",
      "*.ipynb",
    ],
    timeout: 20_000,
  });

  rendered!.unmount();
  await act(async () => {
    render(<NotebooksSurface project={project} session={session} />);
  });
  expect(
    await screen.findByRole("button", {
      name: "Open notebook analysis.ipynb",
    }),
  ).toBeVisible();
  expect(find).toHaveBeenCalledTimes(1);

  fireEvent.click(
    screen.getByRole("button", { name: /refresh notebook list/i }),
  );
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
});
