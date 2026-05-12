import { Table } from "./types";
import { CREATED_BY, ID } from "./crm";

export type Action = "get" | "delete" | "create" | "edit";

export const API_KEY_CAPABILITIES = [
  "account:read",
  "project:create",
  "project:list",
  "project:read",
  "project:write",
  "file:read",
  "file:write",
  "project:exec",
  "codex:run",
] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

export interface ApiKey {
  id: number;
  key_id?: string;
  account_id: string;
  created: Date;
  hash?: string; // usually NOT available
  trunc: string;
  expire?: Date;
  name: string;
  capabilities: ApiKeyCapability[];
  allowed_project_ids: string[];
  last_active?: Date;
  secret?: string; // only when initially creating the key (and never in database)
}

Table({
  name: "api_keys",
  fields: {
    id: ID,
    account_id: CREATED_BY, // who made this api key
    expire: {
      type: "timestamp",
      desc: "When this api key expires and is automatically deleted.",
    },
    created: {
      type: "timestamp",
      desc: "When this api key was created.",
    },
    hash: {
      type: "string",
      pg_type: "VARCHAR(173)",
      desc: "Hash of the api key. This is the same hash as for user passwords, which is 1000 iterations of sha512 with salt of length 32.",
    },
    key_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Random non-sequential lookup id embedded in v2 API keys.",
    },
    name: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "user defined name of this key",
    },
    trunc: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Truncated version of the actual api key, suitable for display to remind user which key it is.",
    },
    capabilities: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "Explicit allow-list of capabilities granted to this API key.",
    },
    allowed_project_ids: {
      type: "array",
      pg_type: "UUID[]",
      desc: "Explicit allow-list of project IDs this API key can access for project-scoped capabilities.",
    },
    last_active: {
      type: "timestamp",
      desc: "When this api key was last used.",
    },
  },
  rules: {
    primary_key: "id",
    pg_indexes: ["((created IS NOT NULL))", "((account_id IS NOT NULL))"],
    pg_unique_indexes: ["key_id"],
  },
});
