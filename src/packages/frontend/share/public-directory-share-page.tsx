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
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { ProjectPage } from "@cocalc/frontend/project/page/page";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { shareRouteCandidates } from "./public-directory-share-route";

function authHref(view: "sign-in" | "sign-up"): string {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${appUrl(`auth/${view}`)}?target=${encodeURIComponent(target)}`;
}

async function grantShareRoute(rawPath: string): Promise<{
  grant: GrantTemporaryViewerAccessResponse;
  projectId: string;
  relativePath: string;
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
      return {
        grant,
        projectId: grant.project_id,
        relativePath: candidate.relativePath,
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
      .then(({ grant, projectId, relativePath, slug }) => {
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
          share: resolvedShareFromGrant({
            grant,
            slug,
          }),
        });
      })
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
    return (
      <ProjectPage
        project_id={view.projectId}
        is_active={true}
        publicDirectoryShare={view.share}
        publicDirectorySharePath={view.relativePath}
      />
    );
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
