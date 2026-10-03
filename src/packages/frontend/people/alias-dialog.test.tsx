/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { AliasDialog } from "./alias-dialog";

const getUsername = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { personalUrls: { getUsername: (...a) => getUsername(...a) } },
    },
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "11111111-1111-4111-8111-111111111111",
}));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));

const props = {
  open: true,
  title: "Weekly",
  onSave: jest.fn(),
  onClose: jest.fn(),
};

it("shows the personal link for a saved alias under the username", async () => {
  getUsername.mockResolvedValue({ username: "alice", redirects: [] });
  render(<AliasDialog {...props} alias="weekly" urlKind="chats" />);
  expect(
    await screen.findByDisplayValue(`${location.origin}/u/alice/chats/weekly`),
  ).toBeInTheDocument();
});

it("falls back to the account id without a username", async () => {
  getUsername.mockResolvedValue({ username: null, redirects: [] });
  render(<AliasDialog {...props} alias="ana" urlKind="people" />);
  expect(
    await screen.findByDisplayValue(
      `${location.origin}/u/11111111-1111-4111-8111-111111111111/people/ana`,
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Only you can open this link.")).toBeInTheDocument();
});

it("has no link until an alias is saved", () => {
  render(<AliasDialog {...props} urlKind="chats" />);
  expect(screen.queryByText("Personal link")).toBeNull();
});

it("explains that project and other aliases are public; people's are private", async () => {
  getUsername.mockResolvedValue({ username: "alice", redirects: [] });
  const { unmount } = render(
    <AliasDialog {...props} alias="research" urlKind="projects" />,
  );
  expect(
    await screen.findByDisplayValue(
      `${location.origin}/u/alice/projects/research`,
    ),
  ).toBeInTheDocument();
  const info = screen.getByRole("button", { name: "About public aliases" });
  fireEvent.click(info);
  expect(
    await screen.findByText(/can find out which project it points to/),
  ).toBeInTheDocument();
  unmount();
  render(<AliasDialog {...props} alias="ana" urlKind="people" />);
  expect(
    screen.queryByRole("button", { name: "About public aliases" }),
  ).toBeNull();
});
