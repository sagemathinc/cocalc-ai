import { noAuth, authFirst, requireSignedIn } from "./util";
import type { Customize } from "@cocalc/util/db-schema/server-settings";
import type {
  ApiKey,
  Action as ApiKeyAction,
} from "@cocalc/util/db-schema/api-keys";
import { type UserSearchResult } from "@cocalc/util/db-schema/accounts";

export const system = {
  getCustomize: noAuth,
  ping: noAuth,
  terminate: authFirst,
  userTracking: authFirst,
  logClientError: authFirst,
  webappError: authFirst,
  manageApiKeys: authFirst,
  generateUserAuthToken: authFirst,
  revokeUserAuthToken: noAuth,
  userSearch: authFirst,
  getNames: requireSignedIn,
  adminResetPasswordLink: authFirst,
  sendEmailVerification: authFirst,
  deletePassport: authFirst,
  getAdminAssignedMembership: authFirst,
  setAdminAssignedMembership: authFirst,
  clearAdminAssignedMembership: authFirst,
  listExternalCredentials: authFirst,
  revokeExternalCredential: authFirst,
  setOpenAiApiKey: authFirst,
  deleteOpenAiApiKey: authFirst,
  getOpenAiApiKeyStatus: authFirst,
  getCodexPaymentSource: authFirst,

  adminSalesloftSync: authFirst,
  userSalesloftSync: authFirst,
};

export interface ExternalCredentialInfo {
  id: string;
  provider: string;
  kind: string;
  scope: string;
  owner_account_id?: string;
  project_id?: string;
  organization_id?: string;
  metadata?: Record<string, any>;
  created: Date;
  updated: Date;
  revoked?: Date | null;
  last_used?: Date | null;
}

export interface CodexPaymentSourceInfo {
  source:
    | "subscription"
    | "project-api-key"
    | "account-api-key"
    | "site-api-key"
    | "shared-home"
    | "none";
  hasSubscription: boolean;
  hasProjectApiKey: boolean;
  hasAccountApiKey: boolean;
  hasSiteApiKey: boolean;
  sharedHomeMode: "disabled" | "fallback" | "prefer" | "always";
  project_id?: string;
}

export interface OpenAiApiKeyStatus {
  account?: ExternalCredentialInfo;
  project?: ExternalCredentialInfo;
  project_id?: string;
}

export interface System {
  // get all or specific customize data
  getCustomize: (fields?: string[]) => Promise<Customize>;
  // ping server and get back the current time
  ping: () => { now: number };
  // terminate a service:
  //   - only admin can do this.
  //   - useful for development
  terminate: (service: "database" | "api") => Promise<void>;

  userTracking: (opts: {
    event: string;
    value: object;
    account_id?: string;
  }) => Promise<void>;

  logClientError: (opts: {
    account_id?: string;
    event: string;
    error: string;
  }) => Promise<void>;

  webappError: (opts: object) => Promise<void>;

  manageApiKeys: (opts: {
    account_id?: string;
    action: ApiKeyAction;
    project_id?: string;
    name?: string;
    expire?: Date;
    id?: number;
  }) => Promise<ApiKey[] | undefined>;

  generateUserAuthToken: (opts: {
    account_id?: string;
    user_account_id: string;
    password?: string;
  }) => Promise<string>;

  revokeUserAuthToken: (authToken: string) => Promise<void>;

  userSearch: (opts: {
    account_id?: string;
    query: string;
    limit?: number;
    admin?: boolean;
    only_email?: boolean;
  }) => Promise<UserSearchResult[]>;

  getNames: (account_ids: string[]) => Promise<{
    [account_id: string]:
      | {
          first_name: string;
          last_name: string;
          profile?: { color?: string; image?: string };
        }
      | undefined;
  }>;

  // adminResetPasswordLink: Enables admins (and only admins!) to generate and get a password reset
  // for another user.  The response message contains a password reset link,
  // though without the site part of the url (the client should fill that in).
  // This makes it possible for admins to reset passwords of users, even if
  // sending email is not setup, e.g., for cocalc-docker, and also deals with the
  // possibility that users have no email address, or broken email, or they
  // can't receive email due to crazy spam filtering.
  // Non-admins always get back an error.
  adminResetPasswordLink: (opts: {
    account_id?: string;
    user_account_id: string;
  }) => Promise<string>;

  // user must be an admin or get an error. Sync's the given salesloft accounts.
  adminSalesloftSync: (opts: {
    account_id?: string;
    account_ids: string[];
  }) => Promise<void>;

  userSalesloftSync: (opts: { account_id?: string }) => Promise<void>;

  sendEmailVerification: (opts: {
    account_id?: string;
    only_verify?: boolean;
  }) => Promise<void>;

  deletePassport: (opts: {
    account_id?: string;
    strategy: string;
    id: string;
  }) => Promise<void>;

  getAdminAssignedMembership: (opts: {
    account_id?: string;
    user_account_id: string;
  }) => Promise<
    | {
        account_id: string;
        membership_class: string;
        assigned_by: string;
        assigned_at: Date;
        expires_at?: Date | null;
        notes?: string | null;
      }
    | undefined
  >;

  setAdminAssignedMembership: (opts: {
    account_id?: string;
    user_account_id: string;
    membership_class: string;
    expires_at?: Date | null;
    notes?: string | null;
  }) => Promise<void>;

  clearAdminAssignedMembership: (opts: {
    account_id?: string;
    user_account_id: string;
  }) => Promise<void>;

  listExternalCredentials: (opts: {
    account_id?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    include_revoked?: boolean;
  }) => Promise<ExternalCredentialInfo[]>;

  revokeExternalCredential: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<{ revoked: boolean }>;

  setOpenAiApiKey: (opts: {
    account_id?: string;
    api_key: string;
    project_id?: string;
  }) => Promise<{
    id: string;
    created: boolean;
    scope: "account" | "project";
    project_id?: string;
  }>;

  deleteOpenAiApiKey: (opts: {
    account_id?: string;
    project_id?: string;
  }) => Promise<{
    revoked: boolean;
    scope: "account" | "project";
    project_id?: string;
  }>;

  getOpenAiApiKeyStatus: (opts: {
    account_id?: string;
    project_id?: string;
  }) => Promise<OpenAiApiKeyStatus>;

  getCodexPaymentSource: (opts: {
    account_id?: string;
    project_id?: string;
  }) => Promise<CodexPaymentSourceInfo>;
}
