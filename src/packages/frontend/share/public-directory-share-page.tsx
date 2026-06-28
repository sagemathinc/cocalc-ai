/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Result, Skeleton, Space } from "antd";
import { fromJS, List, Map } from "immutable";
import { useEffect, useState } from "react";

import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import { appUrl } from "@cocalc/frontend/auth/util";
import { Icon } from "@cocalc/frontend/components/icon";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { ProjectPage } from "@cocalc/frontend/project/page/page";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { shareRouteCandidates } from "./public-directory-share-route";

function authHref(view: "sign-in" | "sign-up"): string {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${appUrl(`auth/${view}`)}?target=${encodeURIComponent(target)}`;
}

type ResolvedShareRoute = {
  share: ResolvedPublicDirectoryShare;
  relativePath: string;
};

async function resolveShareRoute(rawPath: string): Promise<ResolvedShareRoute> {
  let lastError: unknown;
  for (const candidate of shareRouteCandidates(rawPath)) {
    try {
      const share =
        await webapp_client.conat_client.hub.publicDirectoryShares.resolve({
          slug: candidate.slug,
        });
      return { share, relativePath: candidate.relativePath };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("Published folder not found");
}

export function PublicDirectorySharePage({ slug }: { slug?: string }) {
  const isLoggedIn = !!useTypedRedux("account", "is_logged_in");
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const projectsActions = useActions("projects");
  const [loading, setLoading] = useState(false);
  const [shareRoute, setShareRoute] = useState<ResolvedShareRoute | null>(null);
  const [error, setError] = useState<string>("");
  const [projectionReady, setProjectionReady] = useState(false);
  const normalizedSlug = `${slug ?? ""}`.trim();
  const share = shareRoute?.share ?? null;

  useEffect(() => {
    if (!isLoggedIn || !normalizedSlug) {
      return;
    }
    let canceled = false;
    setLoading(true);
    setError("");
    setShareRoute(null);
    setProjectionReady(false);
    resolveShareRoute(normalizedSlug)
      .then((result) => {
        if (!canceled) {
          webapp_client.conat_client.registerPublicDirectoryShareRouting({
            project_id: result.share.project_id,
            share_id: result.share.id,
            host_connection: result.share.host_connection,
          });
          setShareRoute(result);
        }
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
  }, [isLoggedIn, normalizedSlug]);

  useEffect(() => {
    setProjectionReady(false);
    if (!share || !accountId) return;
    const projectsStore = redux.getStore("projects");
    const currentProjectMap =
      projectsStore?.get("project_map") ?? Map<string, any>();
    const currentOpenProjects =
      projectsStore?.get("open_projects") ?? List<string>();
    const wasOpen = currentOpenProjects.includes(share.project_id);
    const existingProject = currentProjectMap.get(share.project_id);
    const syntheticProject = fromJS({
      project_id: share.project_id,
      title: share.project_title || share.title || share.slug,
      host_id: share.host_id ?? undefined,
      owning_bay_id: share.owning_bay_id ?? undefined,
      users: {
        [accountId]: {
          group: "viewer",
          read_policy: share.read_policy,
        },
      },
      state: existingProject?.get?.("state")?.toJS?.() ?? {
        state: "running",
      },
      __projection_only: true,
      public_directory_share_projection: true,
    });
    projectsActions.setState({
      project_map: currentProjectMap.set(
        share.project_id,
        existingProject
          ? existingProject.mergeDeep(syntheticProject)
          : syntheticProject,
      ),
      open_projects: wasOpen
        ? currentOpenProjects
        : currentOpenProjects.push(share.project_id),
      ...(share.host_connection
        ? {
            host_info: (
              redux.getStore("projects")?.get("host_info") ?? Map<string, any>()
            ).set(
              share.host_connection.host_id,
              fromJS({
                ...share.host_connection,
                public_directory_share_connection: true,
                public_directory_share_id: share.id,
                updated_at: Date.now(),
              }),
            ),
          }
        : {}),
    });
    setProjectionReady(true);
    return () => {
      if (wasOpen) return;
      const latestOpenProjects =
        redux.getStore("projects")?.get("open_projects") ?? List<string>();
      const index = latestOpenProjects.indexOf(share.project_id);
      if (index >= 0) {
        projectsActions.setState({
          open_projects: latestOpenProjects.delete(index),
        });
      }
    };
  }, [accountId, projectsActions, share]);

  if (!normalizedSlug) {
    return (
      <Result
        status="warning"
        title="Missing share path"
        subTitle="Open a complete shared directory link."
      />
    );
  }

  if (!isLoggedIn) {
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

  if (loading || (share?.available && !projectionReady)) {
    return (
      <div style={{ maxWidth: 960, margin: "32px auto", padding: "0 24px" }}>
        <Card>
          <Skeleton active paragraph={{ rows: 5 }} />
        </Card>
      </div>
    );
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

  if (!share) {
    return null;
  }

  if (!share.available) {
    return (
      <Result
        status="warning"
        title="Files are not available yet"
        subTitle={
          share.availability_message ||
          "This published folder was imported from the legacy share server, but the backing project files are not available on this site yet."
        }
      />
    );
  }

  return (
    <ProjectPage
      project_id={share.project_id}
      is_active
      publicDirectoryShare={share}
      publicDirectorySharePath={shareRoute?.relativePath}
    />
  );
}
