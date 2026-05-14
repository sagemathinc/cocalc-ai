import { Alert, Button, Input, Space } from "antd";
import { useState } from "react";

import { setStoredControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";
import { MAX_PASSWORD_LENGTH } from "@cocalc/util/auth";
import type { AuthView } from "./types";
import {
  isMfaRequiredAuthResponse,
  isWrongBayAuthResponse,
  postAuthApi,
  retryAuthOnHomeBay,
  type SecondFactorMethod,
} from "./api";
import { signInWithPasskey } from "./passkeys";
import { appUrl } from "./util";

interface SignInProps {
  onNavigate: (view: AuthView) => void;
}

export default function SignInForm({ onNavigate }: SignInProps) {
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [challengeId, setChallengeId] = useState<string>("");
  const [factorMethods, setFactorMethods] = useState<SecondFactorMethod[]>([]);
  const [factorMethod, setFactorMethod] = useState<SecondFactorMethod>("totp");
  const [factorCode, setFactorCode] = useState<string>("");
  const [mfaOrigin, setMfaOrigin] = useState<string | undefined>();
  const [signingIn, setSigningIn] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const canSubmit = challengeId
    ? factorMethod === "passkey"
      ? !signingIn
      : factorCode.trim().length > 0 && !signingIn
    : isValidEmailAddress(email) && password.length > 0 && !signingIn;

  async function signIn() {
    if (!canSubmit) {
      return;
    }
    setError("");
    setSigningIn(true);
    try {
      let result = await postAuthApi<any>({
        endpoint: "auth/sign-in",
        body: { email, password },
      });
      if (isWrongBayAuthResponse(result)) {
        result = await retryAuthOnHomeBay({
          endpoint: "auth/sign-in",
          wrongBay: result,
          body: { email, password },
        });
      }
      if (isMfaRequiredAuthResponse(result)) {
        setStoredControlPlaneOrigin(result?.home_bay_url);
        setChallengeId(result.challenge_id);
        setFactorMethods(result.methods ?? []);
        setFactorMethod(
          result.methods?.includes("passkey")
            ? "passkey"
            : (result.methods?.[0] ?? "totp"),
        );
        setMfaOrigin(result.home_bay_url);
        setFactorCode("");
        return;
      }
      if (!result?.account_id) {
        throw new Error("Sign in failed. Please try again.");
      }
      setStoredControlPlaneOrigin(result?.home_bay_url);
      window.location.href = appUrl("app?sign-in");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningIn(false);
    }
  }

  async function verifySecondFactor() {
    if (!canSubmit) {
      return;
    }
    setError("");
    setSigningIn(true);
    try {
      const result =
        factorMethod === "passkey"
          ? await signInWithPasskey({
              challenge_id: challengeId,
              origin: mfaOrigin,
            })
          : await postAuthApi<any>({
              endpoint: "auth/verify-second-factor",
              origin: mfaOrigin,
              body: {
                challenge_id: challengeId,
                method: factorMethod,
                code: factorCode.trim(),
              },
            });
      if (!result?.account_id) {
        throw new Error("Second factor verification failed. Please try again.");
      }
      setStoredControlPlaneOrigin(result?.home_bay_url);
      window.location.href = appUrl("app?sign-in");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {error && <Alert type="error" showIcon title={error} />}
      {!challengeId ? (
        <>
          <div>
            <div>Email address</div>
            <Input
              autoFocus
              value={email}
              autoComplete="username"
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
              onPressEnter={signIn}
            />
          </div>
          <div>
            <div>Password</div>
            <Input.Password
              value={password}
              autoComplete="current-password"
              placeholder="Password"
              maxLength={MAX_PASSWORD_LENGTH}
              onChange={(e) => setPassword(e.target.value)}
              onPressEnter={signIn}
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <div>Second factor</div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              {factorMethods.includes("passkey") ? (
                <Button
                  type={factorMethod === "passkey" ? "primary" : "default"}
                  onClick={() => setFactorMethod("passkey")}
                >
                  Use passkey
                </Button>
              ) : undefined}
              {factorMethods.includes("totp") ? (
                <Button
                  type={factorMethod === "totp" ? "primary" : "default"}
                  onClick={() => setFactorMethod("totp")}
                >
                  Authenticator code
                </Button>
              ) : undefined}
              {factorMethods.includes("recovery_code") ? (
                <Button
                  type={
                    factorMethod === "recovery_code" ? "primary" : "default"
                  }
                  onClick={() => setFactorMethod("recovery_code")}
                >
                  Recovery code
                </Button>
              ) : undefined}
            </div>
            {factorMethod === "passkey" ? (
              <Alert
                type="info"
                showIcon
                message="Use your browser or device passkey prompt to finish signing in."
              />
            ) : (
              <Input
                autoFocus
                value={factorCode}
                autoComplete="one-time-code"
                placeholder={
                  factorMethod === "totp" ? "123456" : "ABCD-EFGH-IJKL"
                }
                onChange={(e) => setFactorCode(e.target.value)}
                onPressEnter={verifySecondFactor}
              />
            )}
          </div>
          <a
            onClick={() => {
              setChallengeId("");
              setFactorMethods([]);
              setFactorMethod("totp");
              setFactorCode("");
              setMfaOrigin(undefined);
              setError("");
            }}
            style={{ cursor: "pointer" }}
          >
            Use a different account
          </a>
        </>
      )}
      <Button
        type="primary"
        size="large"
        disabled={!canSubmit}
        onClick={challengeId ? verifySecondFactor : signIn}
      >
        {signingIn
          ? challengeId
            ? "Verifying..."
            : "Signing In..."
          : challengeId
            ? factorMethod === "passkey"
              ? "Use passkey"
              : "Verify"
            : "Sign In"}
      </Button>
      {!challengeId && (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <a
            onClick={() => onNavigate("password-reset")}
            style={{ cursor: "pointer" }}
          >
            Forgot password?
          </a>
          <a
            onClick={() => onNavigate("sign-up")}
            style={{ cursor: "pointer" }}
          >
            Create an account
          </a>
        </div>
      )}
    </Space>
  );
}
