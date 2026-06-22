/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Descriptions, Result, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

import { normalizeUserFacingError } from "@cocalc/frontend/components/user-facing-error";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { SiteLicenseExternalClaimConsumption } from "@cocalc/conat/hub/api/purchases";
import { appUrl } from "@cocalc/frontend/auth/util";

const { Paragraph, Text, Title } = Typography;
const CLAIM_TOKEN_SESSION_KEY = "cocalc-site-license-claim-token";

export function claimTargetWithoutToken(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function claimAuthHref(view: "sign-in" | "sign-up"): string {
  return `${appUrl(`auth/${view}`)}?target=${encodeURIComponent(claimTargetWithoutToken())}`;
}

function getSessionClaimToken(): string {
  try {
    return sessionStorage.getItem(CLAIM_TOKEN_SESSION_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function setSessionClaimToken(token: string) {
  try {
    sessionStorage.setItem(CLAIM_TOKEN_SESSION_KEY, token);
  } catch {
    // If storage is blocked, keep the in-memory token for this render only.
  }
}

function clearSessionClaimToken() {
  try {
    sessionStorage.removeItem(CLAIM_TOKEN_SESSION_KEY);
  } catch {
    // Ignore blocked storage cleanup.
  }
}

export function tokenFromLocationOrSession(): string {
  const token =
    new URL(window.location.href).searchParams.get("token")?.trim() ?? "";
  if (token) {
    setSessionClaimToken(token);
    return token;
  }
  return getSessionClaimToken();
}

function formatDate(value?: Date | string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleString();
}

function rootfsHref(rootfsId: string): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return `${base}/rootfs/id/${encodeURIComponent(rootfsId)}`;
}

function clearTokenFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  url.searchParams.set("claimed", "1");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function removeTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) {
    return;
  }
  url.searchParams.delete("token");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function claimErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object"
      ? `${(error as { code?: unknown }).code ?? ""}`
      : "";
  switch (code) {
    case "claim_token_expired":
      return "This claim link has expired. Ask the issuer for a new claim link.";
    case "claim_token_already_used":
      return "This claim link has already been used.";
    case "claim_token_not_active":
      return "This claim link is not active yet.";
    case "claim_pool_disabled":
    case "claim_site_license_disabled":
      return "This claim is no longer active.";
    case "claim_pool_limit":
      return "This claim pool has no seats available.";
    case "claim_pool_account_limit":
      return "Your account has already claimed the allowed access from this pool.";
    case "claim_audience_mismatch":
    case "claim_issuer_mismatch":
    case "claim_not_found":
    case "claim_token_invalid":
      return "This claim link is not valid for this CoCalc site.";
    case "claim_membership_failed":
      return "The claim was accepted, but applying membership access failed. Please contact support.";
    case "claim_token_required":
      return "No claim token was provided.";
  }
  return normalizeUserFacingError(error).message;
}

function SuccessDetails({
  consumption,
}: {
  consumption: SiteLicenseExternalClaimConsumption;
}) {
  const expires = formatDate(consumption.membership_expires_at);
  return (
    <Card>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="Status">
          {consumption.status}
        </Descriptions.Item>
        <Descriptions.Item label="Membership class">
          {consumption.membership_class}
        </Descriptions.Item>
        {expires && (
          <Descriptions.Item label="Membership expires">
            {expires}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="Package">
          <Text code>{consumption.package_id}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Site license">
          <Text code>{consumption.site_license_id}</Text>
        </Descriptions.Item>
        {consumption.external_subject && (
          <Descriptions.Item label="External subject">
            <Text code>{consumption.external_subject}</Text>
          </Descriptions.Item>
        )}
        {consumption.rootfs_id && (
          <Descriptions.Item label="Image">
            <a href={rootfsHref(consumption.rootfs_id)}>
              Open the associated image
            </a>
          </Descriptions.Item>
        )}
      </Descriptions>
    </Card>
  );
}

export default function SiteLicenseClaimPage() {
  const isLoggedIn = !!useTypedRedux("account", "is_logged_in");
  const [token] = useState(tokenFromLocationOrSession);
  const attemptedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [consumption, setConsumption] =
    useState<SiteLicenseExternalClaimConsumption | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    removeTokenFromUrl();
  }, []);

  useEffect(() => {
    if (!isLoggedIn || !token || attemptedRef.current) {
      return;
    }
    attemptedRef.current = true;
    setLoading(true);
    setError("");
    webapp_client.conat_client.hub.purchases
      .consumeSiteLicenseExternalClaimToken({ token })
      .then((result) => {
        setConsumption(result);
        clearSessionClaimToken();
        clearTokenFromUrl();
      })
      .catch((err) => {
        setError(claimErrorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [isLoggedIn, token]);

  if (!token && !consumption) {
    return (
      <Result
        status="warning"
        title="No claim token found"
        subTitle="Open the complete claim link from your instructor, organization, or image publisher."
      />
    );
  }

  if (!isLoggedIn) {
    return (
      <div style={{ maxWidth: 760, margin: "48px auto", padding: "0 24px" }}>
        <Card>
          <Space orientation="vertical" size="large" style={{ width: "100%" }}>
            <div>
              <Title level={2}>Claim CoCalc access</Title>
              <Paragraph>
                This link grants your account the membership, course, or image
                access chosen by the organization that issued it. Sign in or
                create an account to apply the claim to your account.
              </Paragraph>
              <Paragraph type="secondary">
                The token is consumed once. Keep using this browser tab until
                the claim finishes.
              </Paragraph>
            </div>
            <Space wrap>
              <Button type="primary" href={claimAuthHref("sign-in")}>
                Sign in and claim
              </Button>
              <Button href={claimAuthHref("sign-up")}>Create account</Button>
            </Space>
          </Space>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <Result
        status="info"
        title="Claiming access"
        subTitle="Applying this claim to your account..."
      />
    );
  }

  if (error) {
    return (
      <Result
        status="error"
        title="Claim failed"
        subTitle={error}
        extra={
          <Text type="secondary">
            If this link was already used, expired, or revoked, ask the issuer
            for a new claim link.
          </Text>
        }
      />
    );
  }

  if (consumption) {
    return (
      <div style={{ maxWidth: 860, margin: "48px auto", padding: "0 24px" }}>
        <Result
          status="success"
          title="Access claimed"
          subTitle="The claim has been applied to your account."
          extra={
            <Space wrap>
              <Button type="primary" href={appUrl("projects")}>
                Open projects
              </Button>
              {consumption.rootfs_id && (
                <Button href={rootfsHref(consumption.rootfs_id)}>
                  Open Image
                </Button>
              )}
            </Space>
          }
        />
        <SuccessDetails consumption={consumption} />
      </div>
    );
  }

  return (
    <Result
      status="info"
      title="Preparing claim"
      subTitle="Connecting to CoCalc..."
    />
  );
}
