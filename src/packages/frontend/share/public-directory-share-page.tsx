/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Result,
  Skeleton,
  Space,
  Tag,
} from "antd";
import { useEffect, useState } from "react";

import type { ResolvedPublicDirectoryShare } from "@cocalc/conat/hub/api/public-directory-shares";
import { appUrl } from "@cocalc/frontend/auth/util";
import { Icon } from "@cocalc/frontend/components/icon";
import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useTypedRedux } from "@cocalc/frontend/app-framework";

function authHref(view: "sign-in" | "sign-up"): string {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${appUrl(`auth/${view}`)}?target=${encodeURIComponent(target)}`;
}

function availabilityColor(status?: string): string {
  switch (status) {
    case "available":
      return "green";
    case "pending":
      return "gold";
    case "unavailable":
      return "red";
    default:
      return "default";
  }
}

export function PublicDirectorySharePage({ slug }: { slug?: string }) {
  const isLoggedIn = !!useTypedRedux("account", "is_logged_in");
  const [loading, setLoading] = useState(false);
  const [share, setShare] = useState<ResolvedPublicDirectoryShare | null>(null);
  const [error, setError] = useState<string>("");
  const normalizedSlug = `${slug ?? ""}`.trim();

  useEffect(() => {
    if (!isLoggedIn || !normalizedSlug) {
      return;
    }
    let canceled = false;
    setLoading(true);
    setError("");
    setShare(null);
    webapp_client.conat_client.hub.publicDirectoryShares
      .resolve({ slug: normalizedSlug })
      .then((result) => {
        if (!canceled) setShare(result);
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
            title="Sign in to view this shared directory"
            subTitle="CoCalc shared directories are visible to signed-in users. Reading files counts against your account egress quota."
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
        title="Shared directory unavailable"
        subTitle={error}
      />
    );
  }

  if (!share) {
    return null;
  }

  return (
    <div style={{ maxWidth: 960, margin: "32px auto", padding: "0 24px" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Card>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <div>
              <h2 style={{ marginBottom: 8 }}>{share.title || share.slug}</h2>
              {share.description ? <p>{share.description}</p> : null}
              <Space wrap>
                <Tag color={availabilityColor(share.availability_status)}>
                  {share.availability_status}
                </Tag>
                <Tag>{share.visibility}</Tag>
                {share.site_license_grant_on_copy ? (
                  <Tag color="blue">temporary access on copy</Tag>
                ) : null}
              </Space>
            </div>

            {share.available ? (
              <Alert
                type="info"
                showIcon
                message="File viewer integration is next"
                description="This share resolves successfully. The next implementation step is connecting this route to the read-only project viewer and copy-to-project flow."
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                message="Files are not available yet"
                description={
                  share.availability_message ||
                  "This share was imported from the legacy share server, but the backing project files are not available on this site yet."
                }
              />
            )}

            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="Slug">{share.slug}</Descriptions.Item>
              <Descriptions.Item label="Project">
                <code>{share.project_id}</code>
              </Descriptions.Item>
              <Descriptions.Item label="Path">
                <code>{share.path}</code>
              </Descriptions.Item>
              {share.legacy_url ? (
                <Descriptions.Item label="Legacy URL">
                  {share.legacy_url}
                </Descriptions.Item>
              ) : null}
              {share.license ? (
                <Descriptions.Item label="License">
                  {share.license}
                </Descriptions.Item>
              ) : null}
            </Descriptions>
          </Space>
        </Card>
      </Space>
    </div>
  );
}
