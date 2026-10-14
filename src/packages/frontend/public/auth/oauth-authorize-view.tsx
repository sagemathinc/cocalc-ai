/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The OAuth authorize page: a registered client (e.g. Sagebrush) asks to sign the
user in with their CoCalc account. The user signs in with CoCalc's usual forms,
then allows or denies sharing their account id, email address and name. See
docs/sagebrush.md.
*/

import { useEffect, useMemo, useState } from "react";

import { Alert, Button, Flex, Typography } from "antd";

import { postAuthApi, signOutAuthSession } from "@cocalc/frontend/auth/api";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";

export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

type AuthorizeRequest = Partial<
  Record<(typeof AUTHORIZE_PARAMS)[number], string>
>;

type AuthorizeInfo = {
  client_id: string;
  client_name: string;
  client_homepage: string;
  redirect_uri: string;
  redirect_origin: string;
  deny_url: string;
};

export function authorizeRequestFromSearch(search: string): AuthorizeRequest {
  const params = new URLSearchParams(search);
  const request: AuthorizeRequest = {};
  for (const name of AUTHORIZE_PARAMS) {
    const value = params.get(name);
    if (value != null) request[name] = value;
  }
  return request;
}

function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function accountLabel(
  displayName?: string,
  emailAddress?: string,
): string | undefined {
  const name = displayName?.trim();
  const email = emailAddress?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || undefined;
}

export function PublicOAuthAuthorizeView({
  search,
  isAuthenticated,
  accountDisplayName,
  accountEmailAddress,
  accountEmailAddressVerified,
  navigate = (url) => window.location.assign(url),
}: {
  search: string;
  isAuthenticated: boolean;
  accountDisplayName?: string;
  accountEmailAddress?: string;
  accountEmailAddressVerified?: boolean;
  // Sends the browser back to the client; replaceable in tests.
  navigate?: (url: string) => void;
}) {
  const request = useMemo(() => authorizeRequestFromSearch(search), [search]);
  const [info, setInfo] = useState<AuthorizeInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [needsVerification, setNeedsVerification] = useState(false);
  const [busy, setBusy] = useState<"" | "allow" | "deny" | "sign-out">("");
  const [verificationSent, setVerificationSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setLoadError("");
    void (async () => {
      try {
        const next = await postAuthApi<AuthorizeInfo>({
          endpoint: "auth/oauth/authorize-info",
          body: { request },
        });
        if (!cancelled) setInfo(next);
      } catch (err) {
        if (!cancelled) setLoadError(`${err}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    setNeedsVerification(
      isAuthenticated && accountEmailAddressVerified === false,
    );
  }, [isAuthenticated, accountEmailAddressVerified]);

  async function allow() {
    setBusy("allow");
    setError("");
    try {
      const proof = await postAuthApi<{ token: string; home_bay_id: string }>({
        endpoint: "auth/oauth/approval-token",
        origin: getControlPlaneOrigin(),
        body: { request },
      });
      const approved = await postAuthApi<{ redirect_url: string }>({
        endpoint: "auth/oauth/approve",
        body: {
          request,
          approval_token: proof.token,
          approval_home_bay_id: proof.home_bay_id,
        },
      });
      navigate(approved.redirect_url);
    } catch (err: any) {
      if (err?.code === "email_not_verified") {
        setNeedsVerification(true);
      } else {
        setError(`${err?.message ?? err}`);
      }
      setBusy("");
    }
  }

  function deny() {
    if (info == null) return;
    setBusy("deny");
    navigate(info.deny_url);
  }

  async function signOut() {
    setBusy("sign-out");
    setError("");
    try {
      await signOutAuthSession();
      window.location.reload();
    } catch (err) {
      setError(`${err}`);
      setBusy("");
    }
  }

  async function sendVerification() {
    setError("");
    try {
      await postAuthApi({
        endpoint: "accounts/send-verification-email",
        origin: getControlPlaneOrigin(),
        body: { email_address: accountEmailAddress },
      });
      setVerificationSent(true);
    } catch (err) {
      setError(`${err}`);
    }
  }

  // Defense in depth against clickjacking: the sign-in cookie is SameSite, so
  // a framed page is signed out anyway.
  if (isFramed()) {
    return (
      <Alert
        showIcon
        type="error"
        role="alert"
        title="Open this sign-in page in its own browser window"
      />
    );
  }

  if (loadError) {
    return (
      <Alert
        showIcon
        type="error"
        role="alert"
        title="This sign-in request is not valid"
        description={`${loadError} Go back to the site you came from and try again.`}
      />
    );
  }

  if (info == null) {
    return (
      <Alert
        showIcon
        type="info"
        role="status"
        title="Loading sign-in request…"
      />
    );
  }

  const clientLink = (
    <Typography.Link href={info.client_homepage} target="_blank">
      {info.client_name}
    </Typography.Link>
  );

  if (!isAuthenticated) {
    return (
      <Alert
        showIcon
        type="info"
        title={<>Sign in to continue to {info.client_name}</>}
        description={
          <>
            {clientLink} uses your CoCalc account. Sign in below, then choose
            whether to continue.
          </>
        }
      />
    );
  }

  const account = accountLabel(accountDisplayName, accountEmailAddress);

  return (
    <Flex vertical gap={16}>
      {error ? (
        <Alert showIcon type="error" role="alert" title={error} />
      ) : null}
      {needsVerification ? (
        <Alert
          showIcon
          type="warning"
          title="Verify your email address first"
          description={
            <Flex vertical gap={8} align="start">
              <span>
                {info.client_name} needs a verified email address. Open the link
                in the verification email, then reload this page.
              </span>
              {verificationSent ? (
                <span role="status">Verification email sent.</span>
              ) : (
                <Button onClick={sendVerification}>
                  Send verification email
                </Button>
              )}
            </Flex>
          }
        />
      ) : null}
      <Typography.Paragraph style={{ margin: 0 }}>
        {clientLink} ({info.redirect_origin}) wants to sign you in with your
        CoCalc account{account ? <> {account}</> : null}. It will receive your
        account id, email address and name. It gets no access to your projects
        or files.
      </Typography.Paragraph>
      <Flex gap={12} wrap>
        <Button
          type="primary"
          loading={busy === "allow"}
          disabled={busy !== "" || needsVerification}
          onClick={allow}
        >
          Allow
        </Button>
        <Button loading={busy === "deny"} disabled={busy !== ""} onClick={deny}>
          Deny
        </Button>
      </Flex>
      <Typography.Text type="secondary">
        Not you?{" "}
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: "auto" }}
          disabled={busy !== ""}
          onClick={() => void signOut()}
        >
          Sign out
        </Button>{" "}
        and sign in with another account.
      </Typography.Text>
    </Flex>
  );
}
