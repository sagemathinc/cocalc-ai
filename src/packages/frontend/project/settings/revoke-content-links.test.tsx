/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const revokeMock = jest.fn();
const notifyMock = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        hosts: {
          revokeProjectContentLinks: (opts: any) => revokeMock(opts),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/project/use-project-content-url", () => ({
  notifyContentLinksRevoked: (project_id: string) => notifyMock(project_id),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

import { RevokeContentLinksButton } from "./revoke-content-links";

const PROJECT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  revokeMock.mockReset();
  notifyMock.mockReset();
});

async function confirm() {
  render(<RevokeContentLinksButton project_id={PROJECT} />);
  fireEvent.click(screen.getByRole("button", { name: /Revoke/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
}

it("revokes only after confirmation, then refreshes open previews", async () => {
  revokeMock.mockResolvedValue({ content_epoch: 2, host_synced: true });
  render(<RevokeContentLinksButton project_id={PROJECT} />);
  fireEvent.click(screen.getByRole("button", { name: /Revoke/ }));
  expect(revokeMock).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(notifyMock).toHaveBeenCalledWith(PROJECT));
  expect(revokeMock).toHaveBeenCalledWith({ project_id: PROJECT });
});

it("doesn't refresh previews when the revocation failed", async () => {
  revokeMock.mockRejectedValue(new Error("not authorized"));
  await confirm();
  await waitFor(() => expect(revokeMock).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(notifyMock).not.toHaveBeenCalled();
});
