/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

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
      desc: "Provider implementation kind, e.g. google_oidc, saml, oidc.",
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
