/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Result, Skeleton, Space } from "antd";
import { fromJS, Map } from "immutable";
import { useEffect, useState } from "react";

import type {
  GrantTemporaryViewerAccessResponse,
  ResolvedPublicDirectoryShare,
} from "@cocalc/conat/hub/api/public-directory-shares";
import { appUrl } from "@cocalc/frontend/auth/util";
import { Icon } from "@cocalc/frontend/components/icon";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { ProjectPage } from "@cocalc/frontend/project/page/page";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { path_split, path_to_file, tab_to_path } from "@cocalc/util/misc";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";
import { shareRouteCandidates } from "./public-directory-share-route";

function authHref(view: "sign-in" | "sign-up"): string {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${appUrl(`auth/${view}`)}?target=${encodeURIComponent(target)}`;
}

async function grantShareRoute(rawPath: string): Promise<{
  grant: GrantTemporaryViewerAccessResponse;
  projectId: string;
  relativePath: string;
  relativePathIsDirectory: boolean;
  slug: string;
}> {
  let lastError: unknown;
  for (const candidate of shareRouteCandidates(rawPath)) {
    try {
      const grant =
        await webapp_client.conat_client.hub.publicDirectoryShares.grantTemporaryViewerAccess(
          {
            slug: candidate.slug,
          },
        );
      let relativePathIsDirectory = candidate.relativePath.trim() === "";
      if (!relativePathIsDirectory) {
        try {
          await webapp_client.conat_client.hub.publicDirectoryShares.listDirectory(
            {
              slug: candidate.slug,
              path: candidate.relativePath,
            },
          );
          relativePathIsDirectory = true;
        } catch {}
      }
      return {
        grant,
        projectId: grant.project_id,
        relativePath: candidate.relativePath,
        relativePathIsDirectory,
        slug: candidate.slug,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("Published folder not found");
}

function materializeTemporaryViewerProject({
  accountId,
  grant,
}: {
  accountId: string;
  grant: GrantTemporaryViewerAccessResponse;
}) {
  const projectsStore = redux.getStore("projects");
  const currentProjectMap =
    projectsStore?.get("project_map") ?? Map<string, any>();
  const existingProject = currentProjectMap.get(grant.project_id);
  const syntheticProject = fromJS({
    project_id: grant.project_id,
    title: grant.project_title || grant.share_title || grant.path,
    host_id: grant.host_id ?? undefined,
    owning_bay_id: grant.owning_bay_id ?? undefined,
    users: {
      [accountId]: {
        group: "viewer",
        read_policy: grant.read_policy,
      },
    },
    state: existingProject?.get?.("state")?.toJS?.() ?? {
      state: "running",
    },
    temporary_public_share_viewer_grant: true,
  });
  redux.getActions("projects").setState({
    project_map: currentProjectMap.set(
      grant.project_id,
      existingProject
        ? existingProject.mergeDeep(syntheticProject)
        : syntheticProject,
    ),
    ...(grant.host_connection
      ? {
          host_info: (
            redux.getStore("projects")?.get("host_info") ?? Map<string, any>()
          ).set(
            grant.host_connection.host_id,
            fromJS({
              ...grant.host_connection,
              public_directory_share_connection: true,
              public_directory_share_id: grant.share_id,
              temporary_public_share_viewer_grant: true,
              updated_at: Date.now(),
            }),
          ),
        }
      : {}),
  });
}

function resolvedShareFromGrant({
  grant,
  slug,
}: {
  grant: GrantTemporaryViewerAccessResponse;
  slug: string;
}): ResolvedPublicDirectoryShare {
  return {
    id: grant.share_id,
    project_id: grant.project_id,
    path: grant.path,
    slug,
    visibility: "unlisted",
    requires_auth: true,
    availability_status: "available",
    title: grant.share_title,
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
    read_policy: grant.read_policy,
    available: true,
    project_title: grant.project_title,
    host_id: grant.host_id,
    host_connection: grant.host_connection,
    owning_bay_id: grant.owning_bay_id,
  };
}

interface ShareView {
  share: ResolvedPublicDirectoryShare;
  projectId: string;
  relativePath: string;
  relativePathIsDirectory: boolean;
}

function encodeShareRoutePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function relativePathInShare({
  path,
  sharePath,
}: {
  path?: string | null;
  sharePath: string;
}): string | undefined {
  const homeRelative = projectRuntimeHomeRelativePath(`${path ?? ""}`);
  const normalizedPath = `${homeRelative ?? path ?? ""}`
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const normalizedSharePath =
    sharePath === "." ? "" : sharePath.replace(/^\/+|\/+$/g, "");
  if (!normalizedSharePath) {
    return normalizedPath;
  }
  if (normalizedPath === normalizedSharePath) {
    return "";
  }
  if (normalizedPath.startsWith(`${normalizedSharePath}/`)) {
    return normalizedPath.slice(normalizedSharePath.length + 1);
  }
  return undefined;
}

function LoadingShare() {
  return (
    <div style={{ maxWidth: 960, margin: "32px auto", padding: "0 24px" }}>
      <Card>
        <Skeleton active paragraph={{ rows: 5 }} />
      </Card>
    </div>
  );
}

function TemporaryViewerProjectPage({ view }: { view: ShareView }) {
  const actions = useActions({ project_id: view.projectId });
  const currentPathAbs = useTypedRedux(
    { project_id: view.projectId },
    "current_path_abs",
  ) as string | undefined;
  const activeProjectTab = useTypedRedux(
    { project_id: view.projectId },
    "active_project_tab",
  ) as string | undefined;

  useEffect(() => {
    if (!actions) return;
    actions.setState({
      public_directory_share_id: view.share.id,
      public_directory_share_path: view.share.path,
      public_directory_share_slug: view.share.slug,
      temporary_public_share_route: true,
    });
    const sharePath = view.share.path === "." ? "." : view.share.path;
    const shareRelativePath = view.relativePath
      .trim()
      .replace(/^\/+|\/+$/g, "");
    const targetPath = shareRelativePath
      ? path_to_file(sharePath, shareRelativePath)
      : "";
    const currentPath =
      targetPath && !view.relativePathIsDirectory
        ? path_split(targetPath).head || sharePath
        : targetPath || sharePath;

    actions.set_current_path(currentPath);
    actions.set_active_tab("files", {
      update_file_listing: false,
      change_history: false,
    });
    actions.set_all_files_unchecked?.();
    if (targetPath && !view.relativePathIsDirectory) {
      actions.open_file({
        path: targetPath,
        foreground: true,
        foreground_project: false,
        change_history: false,
        explicit: false,
      });
    }
    return () => {
      actions.setState({
        public_directory_share_id: undefined,
        public_directory_share_path: undefined,
        public_directory_share_slug: undefined,
        temporary_public_share_route: false,
      });
    };
  }, [
    actions,
    view.projectId,
    view.relativePath,
    view.relativePathIsDirectory,
    view.share.id,
    view.share.path,
  ]);

  useEffect(() => {
    const tabPath = activeProjectTab
      ? tab_to_path(activeProjectTab)
      : undefined;
    const shareRelativePath = relativePathInShare({
      path: tabPath ?? currentPathAbs,
      sharePath: view.share.path,
    });
    if (shareRelativePath == null) {
      return;
    }
    const slugPath = encodeShareRoutePath(view.share.slug);
    const relativeRoute = encodeShareRoutePath(shareRelativePath);
    const nextPath = relativeRoute
      ? `/share/${slugPath}/${relativeRoute}`
      : `/share/${slugPath}`;
    if (
      typeof window !== "undefined" &&
      window.location.pathname !== nextPath
    ) {
      window.history.replaceState(window.history.state, "", nextPath);
    }
  }, [
    activeProjectTab,
    currentPathAbs,
    view.projectId,
    view.share.path,
    view.share.slug,
  ]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <ProjectPage
        project_id={view.projectId}
        is_active={true}
        forceForeground={true}
        publicDirectoryShare={view.share}
        publicDirectorySharePath={view.relativePath}
        publicDirectorySharePathIsDirectory={view.relativePathIsDirectory}
      />
    </div>
  );
}

export function PublicDirectorySharePage({ slug }: { slug?: string }) {
  const reduxLoggedIn = !!useTypedRedux("account", "is_logged_in");
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const signedIn = reduxLoggedIn || webapp_client.is_signed_in();
  const [authSettled, setAuthSettled] = useState(signedIn);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [view, setView] = useState<ShareView | null>(null);
  const normalizedSlug = `${slug ?? ""}`.trim();

  useEffect(() => {
    if (signedIn) {
      setAuthSettled(true);
      return;
    }
    setAuthSettled(false);
    const timeout = setTimeout(() => setAuthSettled(true), 1200);
    return () => clearTimeout(timeout);
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn || !accountId || !normalizedSlug) {
      return;
    }
    let canceled = false;
    setLoading(true);
    setError("");
    setView(null);
    grantShareRoute(normalizedSlug)
      .then(
        ({ grant, projectId, relativePath, relativePathIsDirectory, slug }) => {
          if (canceled) return;
          materializeTemporaryViewerProject({ accountId, grant });
          webapp_client.conat_client.registerPublicDirectoryShareRouting({
            project_id: projectId,
            share_id: grant.share_id,
            host_connection: grant.host_connection,
          });
          setView({
            projectId,
            relativePath,
            relativePathIsDirectory,
            share: resolvedShareFromGrant({
              grant,
              slug,
            }),
          });
        },
      )
      .catch((err) => {
        if (!canceled) setError(normalizeUserFacingError(err).message);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [accountId, signedIn, normalizedSlug]);

  if (view) {
    return <TemporaryViewerProjectPage view={view} />;
  }

  if (!normalizedSlug) {
    return (
      <Result
        status="warning"
        title="Missing share path"
        subTitle="Open a complete shared directory link."
      />
    );
  }

  if (!signedIn && !authSettled) {
    return <LoadingShare />;
  }

  if (!signedIn) {
    return (
      <div style={{ maxWidth: 760, margin: "48px auto", padding: "0 24px" }}>
        <Card>
          <Result
            icon={<Icon name="users" />}
            title="Sign in to view this published folder"
            subTitle="Published folders are visible to signed-in CoCalc users who know the URL."
            extra={
              <Space>
                <Button type="primary" href={authHref("sign-in")}>
                  Sign in
                </Button>
                <Button href={authHref("sign-up")}>Create account</Button>
              </Space>
            }
          />
        </Card>
      </div>
    );
  }

  if (loading || (signedIn && !accountId)) {
    return <LoadingShare />;
  }

  if (error) {
    return (
      <Result
        status="warning"
        title="Published folder unavailable"
        subTitle={error}
      />
    );
  }

  return <LoadingShare />;
}
