import { Alert, Button, Input, Space } from "antd";
import { useEffect, useMemo, useState } from "react";

import api from "@cocalc/frontend/client/api";
import { setStoredControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import {
  is_valid_email_address as isValidEmailAddress,
  len,
} from "@cocalc/util/misc";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@cocalc/util/auth";
import { isWrongBayAuthResponse, postAuthApi, retryAuthOnHomeBay } from "./api";
import type { AuthView } from "./types";
import { appUrl } from "./util";

interface SignUpFormBaseProps {
  initialRequiresToken?: boolean;
  onNavigate: (view: AuthView) => void;
}

function getQueryParam(name: string): string | null {
  return new URL(window.location.href).searchParams.get(name);
}

export default function SignUpFormBase({
  onNavigate,
  initialRequiresToken,
}: SignUpFormBaseProps) {
  const [requiresToken, setRequiresToken] = useState<boolean | undefined>(
    initialRequiresToken,
  );
  const [registrationToken, setRegistrationToken] = useState<string>(
    getQueryParam("registrationToken") ?? "",
  );
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [signingUp, setSigningUp] = useState<boolean>(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>("");

  const bootstrap = useMemo(() => getQueryParam("bootstrap") === "1", []);

  useEffect(() => {
    setRequiresToken(initialRequiresToken);
  }, [initialRequiresToken]);

  useEffect(() => {
    if (requiresToken !== undefined) {
      return;
    }
    (async () => {
      try {
        const result = await api("auth/requires-token");
        setRequiresToken(!!result);
      } catch (_err) {
        setRequiresToken(false);
      }
    })();
  }, [requiresToken]);

  const canSubmit = useMemo(() => {
    if (!isValidEmailAddress(email)) {
      return false;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return false;
    }
    if (!firstName.trim() || !lastName.trim()) {
      return false;
    }
    if (requiresToken && !registrationToken.trim()) {
      return false;
    }
    return !signingUp;
  }, [
    email,
    password,
    firstName,
    lastName,
    requiresToken,
    registrationToken,
    signingUp,
  ]);

  async function signUp() {
    if (!canSubmit) {
      return;
    }
    setIssues({});
    setError("");
    setSigningUp(true);
    try {
      let result = await postAuthApi<any>({
        endpoint: "auth/sign-up",
        body: {
          terms: true,
          email,
          password,
          firstName,
          lastName,
          registrationToken: registrationToken.trim(),
        },
      });
      if (isWrongBayAuthResponse(result)) {
        result = await retryAuthOnHomeBay({
          endpoint: "auth/sign-in",
          wrongBay: result,
          body: { email, password },
        });
      }
      if (result?.issues && len(result.issues) > 0) {
        setIssues(result.issues);
        return;
      }
      if (result?.error) {
        throw new Error(`${result.error}`);
      }
      setStoredControlPlaneOrigin(result?.home_bay_url);
      window.location.href = appUrl("app?sign-in");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningUp(false);
    }
  }

  const issueList = Object.values(issues).filter(Boolean);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {bootstrap && (
        <Alert
          type="info"
          showIcon
          title="You are creating the initial admin account for this server."
        />
      )}
      {error && <Alert type="error" showIcon title={error} />}
      {issueList.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="Sign up failed"
          description={
            <ul style={{ margin: 0, paddingLeft: "18px" }}>
              {issueList.map((issue, idx) => (
                <li key={idx}>{issue}</li>
              ))}
            </ul>
          }
        />
      )}
      {requiresToken && (
        <div>
          <div>Registration token</div>
          <Input
            value={registrationToken}
            placeholder="Enter your registration token"
            onChange={(e) => setRegistrationToken(e.target.value)}
          />
        </div>
      )}
      <div>
        <div>Email address</div>
        <Input
          value={email}
          autoComplete="username"
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
          onPressEnter={signUp}
        />
      </div>
      <div>
        <div>Password</div>
        <Input.Password
          value={password}
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          maxLength={MAX_PASSWORD_LENGTH}
          onChange={(e) => setPassword(e.target.value)}
          onPressEnter={signUp}
        />
      </div>
      <div>
        <div>First name</div>
        <Input
          value={firstName}
          placeholder="First name"
          onChange={(e) => setFirstName(e.target.value)}
          onPressEnter={signUp}
        />
      </div>
      <div>
        <div>Last name</div>
        <Input
          value={lastName}
          placeholder="Last name"
          onChange={(e) => setLastName(e.target.value)}
          onPressEnter={signUp}
        />
      </div>
      <Button
        type="primary"
        size="large"
        disabled={!canSubmit}
        onClick={signUp}
      >
        {signingUp ? "Creating account..." : "Create account"}
      </Button>
      <div style={{ textAlign: "center" }}>
        Already have an account?{" "}
        <a onClick={() => onNavigate("sign-in")} style={{ cursor: "pointer" }}>
          Sign in
        </a>
      </div>
    </Space>
  );
}
