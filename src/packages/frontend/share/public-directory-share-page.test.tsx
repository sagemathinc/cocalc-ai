/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import { TemporaryViewerProjectPage } from "./public-directory-share-page";

const mockUseActions = jest.fn();
const mockUseTypedRedux = jest.fn();
const mockProjectPage = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: jest.fn(),
    getActions: jest.fn(),
  },
  useActions: (...args: unknown[]) => mockUseActions(...args),
  useTypedRedux: (...args: unknown[]) => mockUseTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/project/page/page", () => ({
  ProjectPage: (props: any) => {
    mockProjectPage(props);
    return <div data-testid="project-page" />;
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { hub: { publicDirectoryShares: {} } },
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
  normalizeUserFacingError: (err: unknown) => `${err}`,
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

  expect(screen.getByTestId("project-page")).toBeTruthy();
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
