/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import {
  PublicDirectorySharePage,
  TemporaryViewerProjectPage,
} from "./public-directory-share-page";

const mockUseActions = jest.fn();
const mockUseTypedRedux = jest.fn();
const mockProjectPage = jest.fn();
const mockEnsureRuntime = jest.fn();
const mockGrantAccess = jest.fn();
const mockRegisterRouting = jest.fn();
const mockSetProjectState = jest.fn();

jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: () => mockEnsureRuntime(),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: jest.fn(),
    getActions: () => ({ setState: mockSetProjectState }),
  },
  useActions: (...args: unknown[]) => mockUseActions(...args),
  useTypedRedux: (...args: unknown[]) => mockUseTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/project/page/page", () => ({
  ProjectPage: (props: any) => {
    mockProjectPage(props);
    return <div role="region" aria-label="Project workspace" />;
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        publicDirectoryShares: {
          grantTemporaryViewerAccess: (...args: unknown[]) =>
            mockGrantAccess(...args),
        },
      },
      registerPublicDirectoryShareRouting: (...args: unknown[]) =>
        mockRegisterRouting(...args),
    },
    is_signed_in: jest.fn(() => true),
  },
}));

jest.mock("@cocalc/frontend/auth/util", () => ({
  appUrl: (path: string) => `/${path}`,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/components/user-facing-error", () => ({
  normalizeUserFacingError: (err: unknown) => ({ message: `${err}` }),
}));

function share(): ResolvedPublicDirectoryShare {
  return {
    id: "share-id",
    project_id: "project-id",
    path: "share",
    slug: "test2",
    visibility: "unlisted",
    requires_auth: true,
    availability_status: "available",
    title: "Test Share",
    description: null,
    license: null,
    image: null,
    redirect: null,
    legacy_public_path_id: null,
    legacy_url: null,
    site_license_id: null,
    site_license_pool_id: null,
    site_license_membership_tier_id: null,
    site_license_duration_days: null,
    site_license_grant_on_copy: false,
    site_license_copy_requires_grant: false,
    disabled: false,
    read_policy: { rules: [{ action: "include", path: "share/**" }] },
    available: true,
    project_title: "Source Project",
    host_id: null,
    host_connection: null,
    owning_bay_id: "bay-0",
  } as ResolvedPublicDirectoryShare;
}

beforeEach(() => {
  mockUseActions.mockReset();
  mockUseTypedRedux.mockReset();
  mockProjectPage.mockReset();
  mockEnsureRuntime.mockReset().mockResolvedValue(undefined);
  mockGrantAccess.mockReset().mockResolvedValue({
    project_id: "project-id",
    share_id: "share-id",
    path: "a.chat",
    path_type: "file",
    read_policy: { rules: [{ action: "include", path: "a.chat" }] },
  });
  mockRegisterRouting.mockReset();
  mockSetProjectState.mockReset();
  mockUseActions.mockReturnValue({
    setState: jest.fn(),
    set_current_path: jest.fn(),
    set_active_tab: jest.fn(),
    set_all_files_unchecked: jest.fn(),
    open_file: jest.fn(),
  });
  mockUseTypedRedux.mockReturnValue(undefined);
});

test("temporary share wrapper delegates route activation to ProjectPage", () => {
  render(
    <TemporaryViewerProjectPage
      view={{
        share: share(),
        projectId: "project-id",
        relativePath: "a.chat",
        relativePathIsDirectory: false,
        slug: "test2",
      }}
    />,
  );

  expect(
    screen.getByRole("region", { name: "Project workspace" }),
  ).toBeTruthy();
  expect(mockUseActions).not.toHaveBeenCalled();
  expect(mockProjectPage).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "project-id",
      is_active: true,
      forceForeground: true,
      publicDirectoryShare: expect.objectContaining({ slug: "test2" }),
      publicDirectorySharePath: "a.chat",
      publicDirectorySharePathIsDirectory: false,
    }),
  );
});

function signedInAccount() {
  mockUseTypedRedux.mockImplementation((store, field) =>
    store === "account" && field === "account_id" ? "account-id" : undefined,
  );
}

it("waits for the project runtime before rendering a newly granted share", async () => {
  signedInAccount();
  let ready!: () => void;
  mockEnsureRuntime.mockReturnValue(
    new Promise<void>((resolve) => (ready = resolve)),
  );
  render(<PublicDirectorySharePage slug="test2" />);

  await waitFor(() => expect(mockEnsureRuntime).toHaveBeenCalledTimes(1));
  expect(mockProjectPage).not.toHaveBeenCalled();
  expect(mockRegisterRouting).not.toHaveBeenCalled();

  await act(async () => ready());
  expect(
    screen.getByRole("region", { name: "Project workspace" }),
  ).toBeTruthy();
  expect(mockRegisterRouting).toHaveBeenCalledTimes(1);
});

it("reports runtime load errors without rendering an uninitialized project", async () => {
  signedInAccount();
  mockEnsureRuntime.mockRejectedValue(new Error("Runtime chunk unavailable"));
  render(<PublicDirectorySharePage slug="test2" />);

  expect(await screen.findByText("Published folder unavailable")).toBeTruthy();
  expect(screen.getByText("Error: Runtime chunk unavailable")).toBeTruthy();
  expect(mockProjectPage).not.toHaveBeenCalled();
  expect(mockRegisterRouting).not.toHaveBeenCalled();
});

it("does not register a canceled share when runtime loading finishes", async () => {
  signedInAccount();
  let ready!: () => void;
  mockEnsureRuntime.mockReturnValue(
    new Promise<void>((resolve) => (ready = resolve)),
  );
  const { unmount } = render(<PublicDirectorySharePage slug="test2" />);
  await waitFor(() => expect(mockEnsureRuntime).toHaveBeenCalledTimes(1));
  unmount();

  await act(async () => ready());
  expect(mockRegisterRouting).not.toHaveBeenCalled();
  expect(mockSetProjectState).not.toHaveBeenCalled();
  expect(mockProjectPage).not.toHaveBeenCalled();
});
