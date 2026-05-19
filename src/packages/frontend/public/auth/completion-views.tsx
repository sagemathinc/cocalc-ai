/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { Alert, Button, Flex, Input, Spin, Typography } from "antd";

import type { ProjectCollabInviteRow } from "@cocalc/conat/hub/api/projects";
import { signOutAuthSession } from "@cocalc/frontend/auth/api";
import api from "@cocalc/frontend/client/api";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { MIN_PASSWORD_LENGTH } from "@cocalc/util/auth";
import { joinUrlPath } from "@cocalc/util/url-path";

import {
  pathForAuthView,
  pathForPasswordResetDone,
} from "@cocalc/frontend/public/auth/routes";

const { Paragraph, Text } = Typography;

function openPath(path: string): void {
  window.location.assign(path);
}

export function PublicRedeemPasswordResetView({
  passwordResetId,
}: {
  passwordResetId: string;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const canSubmit =
    password.length >= MIN_PASSWORD_LENGTH &&
    !submitting &&
    passwordResetId.length > 0;

  async function submit(): Promise<void> {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await api("auth/redeem-password-reset", { password, passwordResetId });
      openPath(pathForPasswordResetDone());
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Flex vertical gap={16}>
      <Paragraph style={{ margin: 0 }}>
        Choose a new password for your account. After this succeeds, you will be
        signed in automatically.
      </Paragraph>
      {error ? (
        <Alert
          title="Could not reset password"
          description={error}
          showIcon
          type="error"
        />
      ) : null}
      <div>
        <Text strong>New password</Text>
        <Input.Password
          autoComplete="new-password"
          autoFocus
          placeholder="Enter a new password"
          size="large"
          style={{ marginTop: 8 }}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onPressEnter={() => void submit()}
        />
        <Text type="secondary">
          Use at least {MIN_PASSWORD_LENGTH} characters.
        </Text>
      </div>
      <Flex wrap gap={12}>
        <Button
          disabled={!canSubmit}
          loading={submitting}
          size="large"
          type="primary"
          onClick={() => void submit()}
        >
          Change password
        </Button>
        <Button href={pathForAuthView("sign-in")} size="large">
          Back to sign in
        </Button>
      </Flex>
    </Flex>
  );
}

export function PublicPasswordResetDoneView() {
  return (
    <Flex vertical gap={16}>
      <Alert
        title="Password updated"
        description="Your password was changed successfully and you are now signed in."
        showIcon
        type="success"
      />
      <Flex wrap gap={12}>
        <Button href={joinUrlPath(appBasePath, "projects")} type="primary">
          Open projects
        </Button>
        <Button href={joinUrlPath(appBasePath, "settings")}>Settings</Button>
      </Flex>
    </Flex>
  );
}

export function PublicVerifyEmailView({
  email,
  isAuthenticated = false,
  token,
}: {
  email?: string;
  isAuthenticated?: boolean;
  token: string;
}) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function verify(): Promise<void> {
      if (!token || !email) {
        setError("This verification link is incomplete or invalid.");
        setLoading(false);
        return;
      }
      try {
        await api("auth/redeem-verify-email", {
          email_address: email,
          token,
        });
        if (!cancelled) {
          setSuccess("Successfully verified your email address.");
        }
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void verify();
    return () => {
      cancelled = true;
    };
  }, [email, token]);

  return (
    <Flex vertical gap={16}>
      {loading ? (
        <Flex align="center" gap={12}>
          <Spin />
          <Text>Verifying your email address...</Text>
        </Flex>
      ) : success ? (
        <Alert
          title="Email verified"
          description={
            <Flex vertical gap={6}>
              <span>{success}</span>
              {email ? (
                <span>
                  Verified email: <Text code>{email}</Text>
                </span>
              ) : null}
            </Flex>
          }
          showIcon
          type="success"
        />
      ) : (
        <Alert
          title="Could not verify email"
          description={error || "This verification link is invalid or expired."}
          showIcon
          type="error"
        />
      )}
      <Flex wrap gap={12}>
        {success && isAuthenticated ? (
          <>
            <Button href={joinUrlPath(appBasePath, "projects")} type="primary">
              Open projects
            </Button>
            <Button href={joinUrlPath(appBasePath, "settings")}>
              Account settings
            </Button>
          </>
        ) : (
          <Button href={pathForAuthView("sign-in")} type="primary">
            Sign in
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

export function PublicRedeemProjectInviteView({
  currentAccountDisplayName,
  currentAccountEmailAddress,
  currentAccountId,
  inviteId,
  isAuthenticated = false,
  projectId,
  token,
}: {
  currentAccountDisplayName?: string;
  currentAccountEmailAddress?: string;
  currentAccountId?: string;
  inviteId: string;
  isAuthenticated?: boolean;
  projectId: string;
  token: string;
}) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(isAuthenticated);
  const [invite, setInvite] = useState<ProjectCollabInviteRow | null>(null);
  const [projectTitle, setProjectTitle] = useState<string | undefined>();
  const [state, setState] = useState<
    "preview" | "accepted" | "declined" | "blocked"
  >("preview");
  const [submitting, setSubmitting] = useState<
    "" | "accept" | "decline" | "block"
  >("");
  const [signingOut, setSigningOut] = useState(false);

  const accountLabel = [
    currentAccountEmailAddress?.trim() || currentAccountId?.trim(),
    currentAccountDisplayName?.trim()
      ? `(${currentAccountDisplayName.trim()})`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    let cancelled = false;

    async function preview(): Promise<void> {
      if (!isAuthenticated) {
        setLoading(false);
        return;
      }
      if (!projectId || !inviteId || !token) {
        setError("This project invite link is incomplete or invalid.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await api("projects/preview-email-invite", {
          project_id: projectId,
          invite_id: inviteId,
          token,
        });
        if (!cancelled) {
          setProjectTitle(result?.invite?.project_title ?? undefined);
          setInvite(result?.invite ?? null);
          setState("preview");
        }
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void preview();
    return () => {
      cancelled = true;
    };
  }, [inviteId, isAuthenticated, projectId, token]);

  async function respond(action: "accept" | "decline" | "block") {
    if (!projectId || !inviteId || !token) {
      setError("This project invite link is incomplete or invalid.");
      return;
    }
    setSubmitting(action);
    setError("");
    try {
      const result = await api("projects/respond-email-invite", {
        action,
        project_id: projectId,
        invite_id: inviteId,
        token,
      });
      setProjectTitle(result?.invite?.project_title ?? projectTitle);
      setInvite(result?.invite ?? invite);
      setState(
        action === "accept"
          ? "accepted"
          : action === "block"
            ? "blocked"
            : "declined",
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting("");
    }
  }

  async function signOutToSwitchAccount(): Promise<void> {
    setSigningOut(true);
    setError("");
    try {
      await signOutAuthSession();
      window.location.reload();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningOut(false);
    }
  }

  if (!isAuthenticated) {
    return (
      <Flex vertical gap={16}>
        <Alert
          title="Sign in to accept this project invite"
          description="You can accept this invite using whichever CoCalc account you actually use. The account email does not have to match the address where the invite was sent."
          showIcon
          type="info"
        />
      </Flex>
    );
  }

  return (
    <Flex vertical gap={16}>
      {loading ? (
        <Flex align="center" gap={12}>
          <Spin />
          <Text>Loading project invite...</Text>
        </Flex>
      ) : state === "accepted" ? (
        <Alert
          title="Project invite accepted"
          description={
            projectTitle
              ? `You now have access to ${projectTitle}.`
              : "You now have access to the invited project."
          }
          showIcon
          type="success"
        />
      ) : state === "declined" ? (
        <Alert
          title="Project invite declined"
          description="You were not added to this project."
          showIcon
          type="info"
        />
      ) : state === "blocked" ? (
        <Alert
          title="Project invite blocked"
          description="You were not added to this project, and this inviter is blocked from sending you account-based project invites."
          showIcon
          type="warning"
        />
      ) : !error ? (
        <Flex vertical gap={12}>
          <Alert
            title="Confirm project invite"
            description={
              <Flex vertical gap={8}>
                <span>
                  Only accept this invite if you trust the person who sent it.
                  You can accept with this signed-in CoCalc account even if the
                  email address that received the link is different.
                </span>
                <span>
                  This browser is signed in
                  {accountLabel ? (
                    <>
                      {" "}
                      as <Text strong>{accountLabel}</Text>
                    </>
                  ) : null}
                  . If you want to accept using a different account,{" "}
                  <Button
                    disabled={signingOut || !!submitting}
                    loading={signingOut}
                    size="small"
                    type="link"
                    style={{ padding: 0 }}
                    onClick={() => void signOutToSwitchAccount()}
                  >
                    sign out first
                  </Button>
                  , then sign in with the account you want to use.
                </span>
              </Flex>
            }
            showIcon
            type="info"
          />
          <div>
            <Text type="secondary">Project</Text>
            <Paragraph style={{ marginBottom: 0 }}>
              <Text strong>
                {projectTitle || invite?.project_title || "Invited project"}
              </Text>
            </Paragraph>
          </div>
          {invite?.inviter_name ? (
            <div>
              <Text type="secondary">Invited by</Text>
              <Paragraph style={{ marginBottom: 0 }}>
                {invite.inviter_name}
              </Paragraph>
            </div>
          ) : null}
          {invite?.message ? (
            <div>
              <Text type="secondary">Message</Text>
              <Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                {invite.message}
              </Paragraph>
            </div>
          ) : null}
        </Flex>
      ) : (
        <Alert
          title="Could not accept project invite"
          description={error || "This invite link is invalid or expired."}
          showIcon
          type="error"
        />
      )}
      <Flex wrap gap={12}>
        {state === "preview" && !loading && !error ? (
          <>
            <Button
              disabled={!!submitting}
              loading={submitting === "accept"}
              size="large"
              type="primary"
              onClick={() => void respond("accept")}
            >
              Accept invite
            </Button>
            <Button
              disabled={!!submitting}
              size="large"
              onClick={() => void respond("decline")}
            >
              Decline
            </Button>
            <Button
              danger
              disabled={!!submitting}
              size="large"
              onClick={() => void respond("block")}
            >
              Block inviter
            </Button>
          </>
        ) : null}
        {state === "accepted" ? (
          <Button
            href={joinUrlPath(appBasePath, "projects", projectId)}
            type="primary"
          >
            Open project
          </Button>
        ) : null}
        <Button href={joinUrlPath(appBasePath, "projects")}>Projects</Button>
      </Flex>
    </Flex>
  );
}
