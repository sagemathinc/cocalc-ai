/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import { PublicDirectoryShareBanner } from "./public-directory-share-banner";

const copyToNewProject = jest.fn();
const copyToProject = jest.fn();
const getProjectRegion = jest.fn();
const lroWait = jest.fn();
const openProject = jest.fn();

jest.mock("antd", () => {
  const Button = ({ children, disabled, loading, onClick, type }: any) => (
    <button
      data-type={type}
      disabled={disabled || loading}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
  const Space = ({ children }: any) => <div>{children}</div>;
  return {
    Alert: ({ description, title }: any) => (
      <div>
        <div>{title}</div>
        <div>{description}</div>
      </div>
    ),
    Button,
    Input: ({ onChange, placeholder, value }: any) => (
      <input
        aria-label={placeholder}
        onChange={onChange}
        placeholder={placeholder}
        value={value}
      />
    ),
    Modal: ({ children, footer, open, title }: any) =>
      open ? (
        <div role="dialog">
          <div>{title}</div>
          {children}
          {footer}
        </div>
      ) : null,
    Space,
    Tag: ({ children }: any) => <span>{children}</span>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
    },
  };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    open_project: openProject,
  }),
}));

jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: () => <div>SelectProject</div>,
}));

jest.mock("@cocalc/frontend/components/user-facing-error", () => ({
  normalizeUserFacingError: (err: unknown) => ({
    message: (err as any)?.message ?? `${err}`,
  }),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getProjectRegion: (...args: any[]) => getProjectRegion(...args),
        },
        publicDirectoryShares: {
          copyToNewProject: (...args: any[]) => copyToNewProject(...args),
          copyToProject: (...args: any[]) => copyToProject(...args),
        },
      },
      lroWait: (...args: any[]) => lroWait(...args),
    },
  },
}));

function share(): ResolvedPublicDirectoryShare {
  return {
    id: "share-id",
    project_id: "source-project",
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

describe("PublicDirectoryShareBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    copyToNewProject.mockResolvedValue({
      destination_project_id: "new-project",
      op_id: "op-1",
      scope_id: "new-project",
      scope_type: "project",
      site_license_grant: null,
    });
    lroWait.mockResolvedValue({ status: "succeeded" });
    getProjectRegion.mockResolvedValue("wnam");
  });

  it("waits for create-project copy success before opening the new project", async () => {
    render(<PublicDirectoryShareBanner share={share()} />);

    fireEvent.click(screen.getByText("Copy"));
    fireEvent.click(screen.getByText("Create project and copy"));

    await waitFor(() => {
      expect(openProject).toHaveBeenCalledWith({
        project_id: "new-project",
        switch_to: true,
        target: "files",
      });
    });
    expect(copyToNewProject).toHaveBeenCalledWith({
      slug: "test2",
      options: { recursive: true },
    });
    expect(lroWait).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "op-1",
        scope_id: "new-project",
        scope_type: "project",
      }),
    );
    expect(getProjectRegion).toHaveBeenCalledWith({
      project_id: "new-project",
    });
    expect(lroWait.mock.invocationCallOrder[0]).toBeLessThan(
      openProject.mock.invocationCallOrder[0],
    );
  });

  it("does not open the new project before it is readable", async () => {
    jest.useFakeTimers();
    getProjectRegion.mockRejectedValue(new Error("not ready"));
    render(<PublicDirectoryShareBanner share={share()} />);

    fireEvent.click(screen.getByText("Copy"));
    fireEvent.click(screen.getByText("Create project and copy"));

    await waitFor(() => {
      expect(lroWait).toHaveBeenCalled();
    });
    await act(async () => {
      await jest.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(
        screen.getByText(/not yet available in your project list/),
      ).toBeTruthy();
    });
    expect(openProject).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("does not open the new project when the queued copy fails", async () => {
    lroWait.mockResolvedValueOnce({
      status: "failed",
      error: "copy failed",
    });
    render(<PublicDirectoryShareBanner share={share()} />);

    fireEvent.click(screen.getByText("Copy"));
    fireEvent.click(screen.getByText("Create project and copy"));

    await waitFor(() => {
      expect(screen.getByText("copy failed")).toBeTruthy();
    });
    expect(openProject).not.toHaveBeenCalled();
  });

  it("shows progress and explains when same-host placement falls back", async () => {
    copyToNewProject.mockResolvedValueOnce({
      destination_project_id: "new-project",
      op_id: "op-1",
      scope_id: "new-project",
      scope_type: "project",
      site_license_grant: null,
      requested_host_id: "source-host",
      placed_on_requested_host: false,
      host_placement_message: "host source-host is unavailable",
    });
    lroWait.mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.({
        type: "progress",
        ts: Date.now(),
        phase: "copy",
        message: "copying files",
        progress: 37,
      });
      return { status: "succeeded" };
    });
    render(<PublicDirectoryShareBanner share={share()} />);

    fireEvent.click(screen.getByText("Copy"));
    fireEvent.click(screen.getByText("Create project and copy"));

    await waitFor(() => {
      expect(screen.getByText(/source host was not available/)).toBeTruthy();
    });
    expect(screen.getByText(/host source-host is unavailable/)).toBeTruthy();
    await waitFor(() => {
      expect(openProject).toHaveBeenCalled();
    });
  });
});
