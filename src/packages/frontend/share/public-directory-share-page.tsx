/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Result, Skeleton, Space } from "antd";
import { useEffect, useState } from "react";

import { appUrl } from "@cocalc/frontend/auth/util";
import { Icon } from "@cocalc/frontend/components/icon";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { load_target } from "@cocalc/frontend/history";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { shareRouteCandidates } from "./public-directory-share-route";

function authHref(view: "sign-in" | "sign-up"): string {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${appUrl(`auth/${view}`)}?target=${encodeURIComponent(target)}`;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function joinSharePath(sharePath: string, relativePath: string): string {
  const pieces = [sharePath, relativePath]
    .map((path) => path.trim().replace(/^\/+|\/+$/g, ""))
    .filter((path) => path.length > 0 && path !== ".");
  return pieces.join("/");
}

async function grantShareRoute(rawPath: string): Promise<{
  projectId: string;
  target: string;
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
      const projectPath = joinSharePath(grant.path, candidate.relativePath);
      const encodedPath = encodePath(projectPath);
      return {
        projectId: grant.project_id,
        target:
          candidate.relativePath.length === 0
            ? `files/${encodedPath}${encodedPath.length > 0 ? "/" : ""}`
            : `files/${encodedPath}`,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("Published folder not found");
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
  const signedIn = reduxLoggedIn || webapp_client.is_signed_in();
  const [authSettled, setAuthSettled] = useState(signedIn);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
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
    if (!signedIn || !normalizedSlug) {
      return;
    }
    let canceled = false;
    setLoading(true);
    setError("");
    grantShareRoute(normalizedSlug)
      .then(({ projectId, target }) => {
        if (canceled) return;
        load_target(`projects/${projectId}/${target}`, false, true);
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
  }, [signedIn, normalizedSlug]);

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

  if (loading) {
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
