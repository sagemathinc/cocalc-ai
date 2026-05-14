/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { postAuthApi } from "@cocalc/frontend/auth/api";

type PasskeySetupStart = {
  challenge_id: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

type PasskeyAuthenticationStart = {
  challenge_id: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

type PasskeyFreshAuthResult = {
  fresh_auth_until: string | Date;
  factor_level: "passkey";
};

export function webAuthnUnavailableMessage(): string | null {
  if (
    typeof window === "undefined" ||
    typeof PublicKeyCredential === "undefined"
  ) {
    return "This browser does not support passkeys.";
  }
  if (!window.isSecureContext) {
    return "Passkeys require HTTPS, except for localhost development.";
  }
  return null;
}

export async function registerPasskey({
  label,
}: {
  label?: string;
} = {}): Promise<{ passkey: unknown; recovery_codes?: string[] }> {
  const unavailable = webAuthnUnavailableMessage();
  if (unavailable) {
    throw new Error(unavailable);
  }
  const setup = await postAuthApi<PasskeySetupStart>({
    endpoint: "auth/2fa/passkeys/setup/start",
    body: { label },
  });
  const response: RegistrationResponseJSON = await startRegistration({
    optionsJSON: setup.options,
  });
  return await postAuthApi({
    endpoint: "auth/2fa/passkeys/setup/finish",
    body: {
      challenge_id: setup.challenge_id,
      label,
      response,
    },
  });
}

export async function signInWithPasskey({
  challenge_id,
  origin,
}: {
  challenge_id: string;
  origin?: string;
}): Promise<any> {
  const unavailable = webAuthnUnavailableMessage();
  if (unavailable) {
    throw new Error(unavailable);
  }
  const authentication = await postAuthApi<PasskeyAuthenticationStart>({
    endpoint: "auth/2fa/passkeys/authentication/start",
    origin,
    body: { challenge_id },
  });
  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: authentication.options,
  });
  return await postAuthApi({
    endpoint: "auth/2fa/passkeys/authentication/finish",
    origin,
    body: {
      challenge_id,
      response,
    },
  });
}

export async function freshAuthWithPasskey({
  current_password,
  duration,
}: {
  current_password: string;
  duration?: "default" | "extended";
}): Promise<PasskeyFreshAuthResult> {
  const unavailable = webAuthnUnavailableMessage();
  if (unavailable) {
    throw new Error(unavailable);
  }
  const authentication = await postAuthApi<PasskeyAuthenticationStart>({
    endpoint: "auth/2fa/passkeys/fresh-auth/start",
    body: {
      current_password,
      duration,
    },
  });
  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: authentication.options,
  });
  return await postAuthApi<PasskeyFreshAuthResult>({
    endpoint: "auth/2fa/passkeys/fresh-auth/finish",
    body: {
      challenge_id: authentication.challenge_id,
      response,
    },
  });
}

export async function approveCliElevationWithPasskey({
  challenge_id,
  current_password,
}: {
  challenge_id: string;
  current_password: string;
}): Promise<any> {
  const unavailable = webAuthnUnavailableMessage();
  if (unavailable) {
    throw new Error(unavailable);
  }
  const authentication = await postAuthApi<PasskeyAuthenticationStart>({
    endpoint: "auth/cli/elevate/passkey/start",
    body: {
      challenge_id,
      current_password,
    },
  });
  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: authentication.options,
  });
  return await postAuthApi({
    endpoint: "auth/cli/elevate/passkey/finish",
    body: {
      challenge_id,
      passkey_challenge_id: authentication.challenge_id,
      response,
    },
  });
}
