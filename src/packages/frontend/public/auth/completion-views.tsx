/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { Alert, Button, Card, Flex, Input, Spin, Typography } from "antd";

import type { ProjectCollabInviteRow } from "@cocalc/conat/hub/api/projects";
import {
  isWrongBayAuthResponse,
  retryAuthOnHomeBay,
  signOutAuthSession,
} from "@cocalc/frontend/auth/api";
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

function friendlyProjectInviteError(err: unknown): string {
  const message = `${err}`;
  const status = message.match(/invite is not pending \(status=([^)]+)\)/)?.[1];
  switch (status) {
    case "expired":
      return "Sorry, this project invite link has expired.";
    case "accepted":
      return "This project invite has already been accepted.";
    case "declined":
      return "This project invite has already been declined.";
    case "blocked":
      return "This project invite has already been blocked.";
    case "canceled":
      return "This project invite has been revoked.";
    case undefined:
      break;
    default:
      return "This project invite is no longer pending.";
  }
  if (message.includes("invalid invite token")) {
    return "This project invite link is invalid.";
  }
  if (message.includes("project invite link is incomplete")) {
    return "This project invite link is incomplete.";
  }
  if (message.includes("not found")) {
    return "This project invite link was not found.";
  }
  return message;
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
      const result = await api("auth/redeem-password-reset", {
        password,
        passwordResetId,
      });
      if (isWrongBayAuthResponse(result)) {
        await retryAuthOnHomeBay({
          endpoint: "auth/redeem-password-reset",
          wrongBay: result,
          body: { passwordResetId },
        });
      }
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
  inviteId?: string;
  isAuthenticated?: boolean;
  projectId?: string;
  token: string;
}) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<ProjectCollabInviteRow | null>(null);
  const [projectTitle, setProjectTitle] = useState<string | undefined>();
  const [state, setState] = useState<
    "preview" | "accepted" | "declined" | "blocked"
  >("preview");
  const [submitting, setSubmitting] = useState<
    "" | "accept" | "decline" | "block"
  >("");
  const [signingOut, setSigningOut] = useState(false);

  const accountEmail = currentAccountEmailAddress?.trim();
  const accountName = currentAccountDisplayName?.trim();
  const accountId = currentAccountId?.trim();
  const accountLabel = [accountEmail || accountId, accountName]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    let cancelled = false;

    async function preview(): Promise<void> {
      if (!token) {
        setError("This project invite link is incomplete or invalid.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await api("projects/preview-email-invite", {
          ...(projectId ? { project_id: projectId } : {}),
          ...(inviteId ? { invite_id: inviteId } : {}),
          token,
        });
        if (!cancelled) {
          setProjectTitle(result?.invite?.project_title ?? undefined);
          setInvite(result?.invite ?? null);
          setState("preview");
        }
      } catch (err) {
        if (!cancelled) {
          setError(friendlyProjectInviteError(err));
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
  }, [inviteId, projectId, token]);

  async function respond(action: "accept" | "decline" | "block") {
    if (!token) {
      setError("This project invite link is incomplete or invalid.");
      return;
    }
    setSubmitting(action);
    setError("");
    try {
      const result = await api("projects/respond-email-invite", {
        action,
        ...(projectId ? { project_id: projectId } : {}),
        ...(inviteId ? { invite_id: inviteId } : {}),
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
      setError(friendlyProjectInviteError(err));
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
        {loading ? (
          <Flex align="center" gap={12}>
            <Spin />
            <Text>Loading project invite...</Text>
          </Flex>
        ) : error ? (
          <Alert
            title="Project invite unavailable"
            description={error}
            showIcon
            type="error"
          />
        ) : (
          <Alert
            title="Sign in to accept this project invite"
            description="You can accept this invite using whichever CoCalc account you actually use. The account email does not have to match the address where the invite was sent."
            showIcon
            type="info"
          />
        )}
      </Flex>
    );
  }

  const resolvedProjectId = invite?.project_id ?? projectId;

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
              </Flex>
            }
            showIcon
            type="info"
          />
          <Card size="small" title="Signed-in account">
            <Flex vertical gap={8}>
              <div>
                {accountEmail ? (
                  <Paragraph style={{ marginBottom: 2 }}>
                    <Text type="secondary">Email: </Text>
                    <Text strong>{accountEmail}</Text>
                  </Paragraph>
                ) : null}
                {accountName ? (
                  <Paragraph style={{ marginBottom: 2 }}>
                    <Text type="secondary">Name: </Text>
                    <Text strong>{accountName}</Text>
                  </Paragraph>
                ) : null}
                {!accountEmail && !accountName && accountId ? (
                  <Paragraph style={{ marginBottom: 2 }}>
                    <Text type="secondary">Account ID: </Text>
                    <Text strong>{accountId}</Text>
                  </Paragraph>
                ) : null}
                {accountLabel ? (
                  <Text type="secondary">
                    Accepting this invite will add this account to the project.
                  </Text>
                ) : (
                  <Text type="warning">
                    This browser is signed in, but account details are still
                    loading. Refresh before accepting if you are unsure which
                    account this is.
                  </Text>
                )}
              </div>
              <div>
                <Button
                  disabled={signingOut || !!submitting}
                  loading={signingOut}
                  size="small"
                  onClick={() => void signOutToSwitchAccount()}
                >
                  Sign out to use a different account
                </Button>
              </div>
            </Flex>
          </Card>
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
        {state === "accepted" && resolvedProjectId ? (
          <Button
            href={joinUrlPath(appBasePath, "projects", resolvedProjectId)}
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
