/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import { Alert, Button, Flex, Input, Spin, Typography } from "antd";

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
  token,
}: {
  email?: string;
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
          description={success}
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
        <Button href={pathForAuthView("sign-in")} type="primary">
          Sign in
        </Button>
        <Button href={pathForAuthView("sign-up")}>Create account</Button>
      </Flex>
    </Flex>
  );
}
