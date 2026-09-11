import type { History } from "@cocalc/util/types/ai";
import { CREATED_BY, ID } from "./crm";
import { SCHEMA as schema } from "./index";
import { LanguageModel } from "./ai-models";
import { Table } from "./types";

export interface AIUsageLogEntry {
  id: number;
  account_id?: string;
  analytics_cookie?: string; // at least one of analytics_cookie or account_id will be set
  cost_microusd?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  funded_event_id?: string;
  expire?: Date;
  funded_turn_id?: string;
  history?: History;
  input: string;
  model?: LanguageModel;
  output: string;
  output_tokens?: number;
  path?: string;
  price_version?: string;
  project_id?: string;
  provider_request_id?: string;
  provider_tool_fees_microusd?: number;
  prompt_tokens: number;
  reasoning_output_tokens?: number;
  request_sequence?: number;
  long_context?: boolean;
  media_operation?: "transcription" | "speech";
  audio_duration_ms?: number;
  input_characters?: number;
  system?: string;
  tag?: string; // useful for keeping track of where queries come frome when doing analytics later
  time: Date;
  total_time_s: number; // how long the request took in s
  total_tokens: number;
  usage_units?: number;
}

Table({
  name: "ai_usage_log",
  fields: {
    id: ID,
    time: { type: "timestamp", desc: "When this particular chat happened." },
    analytics_cookie: {
      title: "Analytics Cookie",
      type: "string",
      desc: "The analytics cookie for the user that asked this question.",
    },
    account_id: CREATED_BY,
    cost_microusd: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Exact provider cost in millionths of one US dollar.",
    },
    cached_input_tokens: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Provider-reported cached input tokens.",
    },
    cache_write_input_tokens: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Provider-reported cache-write input tokens.",
    },
    funded_event_id: {
      type: "uuid",
      desc: "Idempotency key for an exact site-funded Codex provider request.",
    },
    funded_turn_id: {
      type: "uuid",
      desc: "Groups exact provider requests from one site-funded Codex turn.",
    },
    output_tokens: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Provider-reported output tokens.",
    },
    price_version: {
      type: "string",
      desc: "Version of the exact provider price used for this request.",
    },
    provider_request_id: {
      type: "string",
      desc: "Opaque provider request identifier used for reconciliation.",
    },
    provider_tool_fees_microusd: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Provider tool fees in millionths of one US dollar.",
    },
    reasoning_output_tokens: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Provider-reported reasoning output tokens.",
    },
    request_sequence: {
      type: "integer",
      desc: "Sequence number within a site-funded Codex turn.",
    },
    long_context: {
      type: "boolean",
      desc: "Whether long-context pricing applied to this request.",
    },
    media_operation: {
      type: "string",
      desc: "Media operation represented by this usage event.",
    },
    audio_duration_ms: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Measured or estimated audio duration in milliseconds.",
    },
    input_characters: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Number of text characters supplied to a media model.",
    },
    system: {
      title: "System Context",
      type: "string",
      desc: "System context prompt.",
      render: {
        type: "markdown",
      },
    },
    input: {
      title: "Input",
      type: "string",
      desc: "Input text that was sent to the AI service",
      render: {
        type: "markdown",
      },
    },
    output: {
      title: "Output",
      type: "string",
      desc: "Output text that was returned from the AI service",
      render: {
        type: "markdown",
      },
    },
    history: {
      title: "History",
      type: "array",
      pg_type: "JSONB[]",
      desc: "Historical context for this thread of discussion",
      render: {
        type: "json",
      },
    },
    total_tokens: {
      type: "integer",
      desc: "The total number of tokens involved in this API call.",
    },
    usage_units: {
      type: "integer",
      desc: "Normalized usage units for this API call.",
    },
    prompt_tokens: {
      type: "integer",
      desc: "The number of tokens in the prompt.",
    },
    total_time_s: {
      type: "number",
      desc: "Total amount of time the API call took in seconds.",
    },
    project_id: {
      type: "uuid",
      render: { type: "project_link" },
    },
    path: {
      type: "string",
    },
    expire: {
      type: "timestamp",
      desc: "optional future date, when the entry will be deleted",
    },
    model: {
      type: "string",
    },
    tag: {
      type: "string",
      desc: "A string that the client can include that is useful for analytics later",
    },
  },
  rules: {
    desc: "AI Usage Log",
    primary_key: "id",
    pg_indexes: ["account_id", "analytics_cookie", "time"],
    user_query: {
      get: {
        pg_where: [{ "account_id = $::UUID": "account_id" }],
        fields: {
          id: null,
          time: null,
          account_id: null,
          cost_microusd: null,
          cached_input_tokens: null,
          cache_write_input_tokens: null,
          funded_event_id: null,
          input: null,
          system: null,
          output: null,
          output_tokens: null,
          total_tokens: null,
          usage_units: null,
          prompt_tokens: null,
          total_time_s: null,
          project_id: null,
          price_version: null,
          provider_request_id: null,
          provider_tool_fees_microusd: null,
          reasoning_output_tokens: null,
          request_sequence: null,
          long_context: null,
          media_operation: null,
          audio_duration_ms: null,
          input_characters: null,
          path: null,
          history: null,
          expire: null,
          model: null,
          tag: null,
        },
      },
      set: {
        // this is so that a user can expire any chats they wanted to have expunged from
        // the system completely.
        fields: {
          account_id: "account_id",
          id: true,
          expire: true,
        },
      },
    },
  },
});

Table({
  name: "crm_ai_usage_log",
  rules: {
    virtual: "ai_usage_log",
    primary_key: "id",
    user_query: {
      get: {
        pg_where: [],
        admin: true,
        fields: {
          id: null,
          time: null,
          account_id: null,
          cost_microusd: null,
          cached_input_tokens: null,
          cache_write_input_tokens: null,
          analytics_cookie: null,
          input: null,
          system: null,
          output: null,
          output_tokens: null,
          total_tokens: null,
          usage_units: null,
          prompt_tokens: null,
          total_time_s: null,
          project_id: null,
          price_version: null,
          provider_request_id: null,
          provider_tool_fees_microusd: null,
          reasoning_output_tokens: null,
          request_sequence: null,
          long_context: null,
          media_operation: null,
          audio_duration_ms: null,
          input_characters: null,
          path: null,
          history: null,
          funded_turn_id: null,
          funded_event_id: null,
          model: null,
          tag: null,
        },
      },
    },
  },
  fields: schema.ai_usage_log.fields,
});
