/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

const SECRET_CONFIG_KEYS = new Set([
  "cert",
  "clientSecret",
  "decryptionPvk",
  "idpCert",
  "metadataXml",
  "privateKey",
]);

const ALLOWED_PROVIDER_KINDS = new Set(["saml"]);

const DISALLOWED_PLAINTEXT_CONFIG_KEYS = new Set([
  "accessToken",
  "clientSecret",
  "client_secret",
  "decryptionPvk",
  "metadataXml",
  "password",
  "privateKey",
  "refreshToken",
  "secret",
  "token",
]);

function findDisallowedPlaintextConfigKey(
  value: unknown,
  path: string[] = [],
): string | undefined {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const match = findDisallowedPlaintextConfigKey(value[i], [
        ...path,
        `${i}`,
      ]);
      if (match) return match;
    }
    return;
  }
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const nextPath = [...path, key];
    if (DISALLOWED_PLAINTEXT_CONFIG_KEYS.has(key)) {
      return nextPath.join(".");
    }
    const match = findDisallowedPlaintextConfigKey(nestedValue, nextPath);
    if (match) return match;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  return text ? text : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizedSsoProviderAuditValue(oldVal, newVal, accountId: string) {
  const config: Record<string, any> =
    newVal?.config && typeof newVal.config === "object" ? newVal.config : {};
  const configKeys = Object.keys(config).sort();
  return {
    actor_account_id: accountId,
    provider_id: stringOrUndefined(newVal?.provider_id ?? oldVal?.provider_id),
    kind: stringOrUndefined(newVal?.kind ?? oldVal?.kind),
    enabled: booleanOrUndefined(newVal?.enabled),
    public: booleanOrUndefined(newVal?.public),
    had_previous: oldVal != null,
    provided_fields: Object.keys(newVal ?? {}).sort(),
    config_summary: {
      keys: configKeys.filter((key) => !SECRET_CONFIG_KEYS.has(key)),
      has_client_secret: config.clientSecret != null,
      has_idp_cert: config.idpCert != null || config.cert != null,
      has_metadata_xml: config.metadataXml != null,
      has_private_key:
        config.privateKey != null || config.decryptionPvk != null,
      want_assertions_signed: booleanOrUndefined(config.wantAssertionsSigned),
      want_authn_response_signed: booleanOrUndefined(
        config.wantAuthnResponseSigned,
      ),
    },
  };
}

function sanitizedSsoDomainPolicyAuditValue(oldVal, newVal, accountId: string) {
  return {
    actor_account_id: accountId,
    domain: stringOrUndefined(newVal?.domain ?? oldVal?.domain),
    provider_id: stringOrUndefined(newVal?.provider_id ?? oldVal?.provider_id),
    mode: stringOrUndefined(newVal?.mode),
    enabled: booleanOrUndefined(newVal?.enabled),
    require_cocalc_2fa: booleanOrUndefined(newVal?.require_cocalc_2fa),
    signup_mode: stringOrUndefined(newVal?.signup_mode),
    had_previous: oldVal != null,
    provided_fields: Object.keys(newVal ?? {}).sort(),
  };
}

function logSsoConfigChange(
  database,
  event: string,
  value: object,
  cb: (err?: string | Error) => void,
) {
  database.log({
    event,
    value,
    cb,
  });
}

Table({
  name: "sso_providers",
  rules: {
    primary_key: "provider_id",
    anonymous: false,
    pg_indexes: ["enabled", "kind"],
    user_query: {
      set: {
        admin: true,
        delete: true,
        fields: {
          provider_id: null,
          kind: null,
          display: null,
          enabled: null,
          public: null,
          config: null,
          notes: null,
        },
        check_hook(_database, obj, _accountId, _projectId, cb) {
          const kind = stringOrUndefined(obj?.kind);
          if (kind != null && !ALLOWED_PROVIDER_KINDS.has(kind)) {
            cb(
              `Unsupported SSO provider kind "${kind}". Configure public Google SSO in Site Settings; this provider table only accepts SAML providers.`,
            );
            return;
          }
          const disallowedKey = findDisallowedPlaintextConfigKey(obj?.config);
          if (disallowedKey) {
            cb(
              `SSO provider config must not contain plaintext secret key "${disallowedKey}". Store secrets in encrypted site settings or a future secret table.`,
            );
            return;
          }
          cb();
        },
        on_change(database, oldVal, newVal, accountId, cb) {
          logSsoConfigChange(
            database,
            "sso_provider_config_changed",
            sanitizedSsoProviderAuditValue(oldVal, newVal, accountId),
            cb,
          );
        },
      },
      get: {
        admin: true,
        pg_where: [],
        fields: {
          provider_id: null,
          kind: null,
          display: null,
          enabled: null,
          public: null,
          config: null,
          notes: null,
        },
      },
    },
  },
  fields: {
    provider_id: {
      type: "string",
      desc: "Stable provider id, e.g. google, cornell, colby.",
    },
    kind: {
      type: "string",
      desc: "Provider implementation kind. For cocalc-ai release SSO provider rows only support saml; public Google OIDC is configured through encrypted site settings.",
    },
    display: {
      type: "string",
      desc: "Admin/user-visible provider name.",
    },
    enabled: {
      type: "boolean",
      desc: "If false, this provider should not be used.",
    },
    public: {
      type: "boolean",
      desc: "Whether this provider is displayed as a public sign-in option.",
    },
    config: {
      type: "map",
      desc: "Provider-specific non-secret configuration. Secrets belong in encrypted server settings or a future secret table.",
    },
    notes: {
      type: "string",
      desc: "Admin notes.",
    },
  },
});

Table({
  name: "sso_domain_policies",
  rules: {
    primary_key: "domain",
    anonymous: false,
    pg_indexes: ["provider_id", "enabled", "mode"],
    user_query: {
      set: {
        admin: true,
        delete: true,
        fields: {
          domain: null,
          provider_id: null,
          mode: null,
          enabled: null,
          require_cocalc_2fa: null,
          signup_mode: null,
          notes: null,
        },
        on_change(database, oldVal, newVal, accountId, cb) {
          logSsoConfigChange(
            database,
            "sso_domain_policy_changed",
            sanitizedSsoDomainPolicyAuditValue(oldVal, newVal, accountId),
            cb,
          );
        },
      },
      get: {
        admin: true,
        pg_where: [],
        fields: {
          domain: null,
          provider_id: null,
          mode: null,
          enabled: null,
          require_cocalc_2fa: null,
          signup_mode: null,
          notes: null,
        },
      },
    },
  },
  fields: {
    domain: {
      type: "string",
      desc: "Lowercase email domain, e.g. example.edu. Subdomains match this policy.",
    },
    provider_id: {
      type: "string",
      desc: "SSO provider id that handles this domain.",
    },
    mode: {
      type: "string",
      desc: "Domain auth mode: password_allowed, sso_required, or sso_signup_only.",
    },
    enabled: {
      type: "boolean",
      desc: "If false, this policy is ignored.",
    },
    require_cocalc_2fa: {
      type: "boolean",
      desc: "If true, matching accounts should be required to configure CoCalc-native 2FA.",
    },
    signup_mode: {
      type: "string",
      desc: "Domain-specific account creation mode: disabled, registration_token_required, public_allowed, or inherit.",
    },
    notes: {
      type: "string",
      desc: "Admin notes.",
    },
  },
});
