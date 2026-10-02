/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { NewArtifactDialog } from "./new-artifact-dialog";

const createLibraryArtifact = jest.fn(async () => ({}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const { fromJS } = require("immutable");
  const projects = fromJS({
    p1: { title: "Thesis", last_active: { me: "2026-09-01" } },
    p2: { title: "Course", last_active: { me: "2026-09-20" } },
  });
  return {
    useTypedRedux: (store: string, field: string) =>
      store === "projects"
        ? projects
        : field === "account_id"
          ? "me"
          : undefined,
  };
});
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("./library-create", () => ({
  createLibraryArtifact: (...a) => createLibraryArtifact(...a),
}));

it("pick a kind, fill the form, add it to the most recent project's Library", async () => {
  const user = userEvent.setup();
  const onCreated = jest.fn();
  const onClose = jest.fn();
  render(<NewArtifactDialog open onClose={onClose} onCreated={onCreated} />);
  expect(
    screen.getByRole("listitem", { name: "GitHub pull request" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("listitem", { name: "Decision list" }));
  await user.type(
    screen.getByRole("textbox", { name: "Items" }),
    "Ship it{Enter}Docs",
  );
  await user.click(screen.getByRole("button", { name: "Add artifact" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(createLibraryArtifact).toHaveBeenCalledWith({
    project_id: "p2",
    content: expect.objectContaining({
      title: "Decisions",
      actions: [
        expect.objectContaining({ title: "Ship it" }),
        expect.objectContaining({ title: "Docs" }),
      ],
    }),
  });
  expect(onCreated).toHaveBeenCalled();
});

it("explains what is missing instead of creating", async () => {
  createLibraryArtifact.mockClear();
  const user = userEvent.setup();
  render(<NewArtifactDialog open onClose={jest.fn()} />);
  await user.click(screen.getByRole("listitem", { name: "Document" }));
  await user.click(screen.getByRole("button", { name: "Add artifact" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("title");
  expect(createLibraryArtifact).not.toHaveBeenCalled();
});
