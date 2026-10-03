/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makePeopleReference } from "@cocalc/util/people-references";

const getConversation = jest.fn();
const getEntry = jest.fn();
const landing = jest.fn();
const requestAccess = jest.fn(async () => ({}));
const setActiveTab = jest.fn();

jest.mock("./register", () => ({ register: () => {} }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ setState: jest.fn(), set_active_tab: setActiveTab }),
  },
}));
jest.mock("@cocalc/frontend/agents/library-navigation", () => ({
  openLibrary: jest.fn(),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        people: { getConversation: (...a) => getConversation(...a) },
        artifactCatalog: { getEntry: (...a) => getEntry(...a) },
        agent: { getIdentity: jest.fn() },
      },
    },
    project_collaborators: {
      get_access_landing_info: (...a) => landing(...a),
      request_access: (...a) => requestAccess(...a),
    },
  },
}));

import { PeopleReferenceLink } from "./people-reference";

const project = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";

beforeEach(() => jest.clearAllMocks());

it("opens an accessible conversation", async () => {
  getConversation.mockResolvedValue({ conversation_id: id });
  render(
    <PeopleReferenceLink
      reference={makePeopleReference("conversation", project, id, "Plan")}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open conversation Plan" }),
  );
  await waitFor(() => expect(setActiveTab).toHaveBeenCalledWith("people"));
});

it("offers to request access when the reader is not in the project", async () => {
  getEntry.mockResolvedValue(null);
  landing.mockResolvedValue({ relationship: "none", title: "Lab" });
  const user = userEvent.setup();
  render(
    <PeopleReferenceLink
      reference={makePeopleReference(
        "artifact",
        project,
        "b".repeat(64),
        "Figure 1",
      )}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Open artifact Figure 1" }),
  );
  await screen.findByText(/"Lab" you are not part of/);
  await user.click(screen.getByRole("button", { name: "Request access" }));
  expect(requestAccess).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: project,
      requested_role: "collaborator",
      source: "reference",
    }),
  );
  await screen.findByText(/Access requested/);
});

it("says unavailable when the target is gone but the project is accessible", async () => {
  getConversation.mockResolvedValue(null);
  landing.mockResolvedValue({ relationship: "collaborator", title: "Lab" });
  render(
    <PeopleReferenceLink
      reference={makePeopleReference("conversation", project, id, "Old")}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open conversation Old" }),
  );
  await screen.findByText(/unavailable or was removed/);
});
