import { Command } from "commander";
import type {
  AiSessionInterruptAllResponse,
  AiSessionInterruptResponse,
  AiSessionRecord,
} from "@cocalc/conat/hub/api/ai-sessions";

export type CodexCommandDeps = {
  withContext: any;
  toIso: (value: unknown) => string | null;
};

function parseOptionalPositiveInteger(
  raw: string | undefined,
  flag: string,
): number | undefined {
  if (raw == null || `${raw}`.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function identityFromSessionId(sessionId: string) {
  const value = `${sessionId ?? ""}`.trim();
  if (!value) {
    throw new Error("session id must be non-empty");
  }
  if (value.startsWith("op:")) {
    return { op_id: value.slice(3) };
  }
  if (value.startsWith("session:")) {
    return { session_id: value.slice(8) };
  }
  return { session_key: value };
}

function serializeSession(
  row: AiSessionRecord,
  toIso: CodexCommandDeps["toIso"],
) {
  return {
    state: row.state,
    terminal: !!row.terminal,
    session_key: row.session_key,
    session_id: row.session_id ?? null,
    op_id: row.op_id ?? null,
    project_id: row.project_id,
    account_id: row.account_id ?? null,
    host_id: row.host_id ?? null,
    path: row.path ?? null,
    thread_id: row.thread_id ?? null,
    model: row.model ?? null,
    payment_source: row.payment_source_label ?? row.payment_source_kind ?? null,
    payment_source_kind: row.payment_source_kind ?? null,
    payment_source_id: row.payment_source_id ?? null,
    payment_source_label: row.payment_source_label ?? null,
    payment_source_owner_account_id:
      row.payment_source_owner_account_id ?? null,
    updated_at: toIso(row.updated_at),
    last_heartbeat_at: toIso(row.last_heartbeat_at),
    started_at: toIso(row.started_at),
    finished_at: toIso(row.finished_at),
    title: row.title ?? null,
    error: row.error ?? null,
  };
}

function serializeInterruptResponse(
  response: AiSessionInterruptResponse,
): Record<string, unknown> {
  return {
    ok: response.ok,
    state: response.state,
    terminal: response.terminal,
    session_key: response.session_key ?? null,
    session_id: response.session_id ?? null,
    op_id: response.op_id ?? null,
    project_id: response.project_id ?? null,
    message: response.message ?? null,
  };
}

function serializeInterruptAllResponse(
  response: AiSessionInterruptAllResponse,
): Record<string, unknown> {
  return {
    total: response.total,
    terminal: response.terminal,
    uncertain: response.uncertain,
    results: response.results.map(serializeInterruptResponse),
  };
}

function addListOptions(command: Command): Command {
  return command
    .option("--active", "show only active or possibly active sessions")
    .option("--recent", "show recent sessions, including terminal sessions")
    .option("--project <project_id>", "filter by project id")
    .option("--host <host_id>", "filter by project-host id")
    .option(
      "--payment-source <kind>",
      "filter by payment source kind, e.g. account_plan|user_api_key|site_api_key",
    )
    .option("--payment-source-id <id>", "filter by opaque payment source id")
    .option(
      "--payment-source-owner <account_id>",
      "filter by payment source owner account id",
    )
    .option("--limit <n>", "max rows", "50");
}

export function registerCodexCommand(
  program: Command,
  deps: CodexCommandDeps,
): Command {
  const { withContext, toIso } = deps;
  const codex = program
    .command("codex")
    .description("Codex session visibility and control");
  const admin = codex
    .command("admin")
    .description("admin Codex session visibility and control");

  addListOptions(
    codex
      .command("sessions")
      .description("list your current or recent Codex sessions"),
  ).action(
    async (
      opts: {
        active?: boolean;
        recent?: boolean;
        project?: string;
        host?: string;
        paymentSource?: string;
        paymentSourceId?: string;
        paymentSourceOwner?: string;
        limit?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "codex sessions", async (ctx: any) => {
        const rows = await ctx.hub.aiSessions.list({
          activeOnly: opts.active ? true : undefined,
          project_id: opts.project?.trim() || undefined,
          host_id: opts.host?.trim() || undefined,
          payment_source_kind: opts.paymentSource?.trim() || undefined,
          payment_source_id: opts.paymentSourceId?.trim() || undefined,
          payment_source_owner_account_id:
            opts.paymentSourceOwner?.trim() || undefined,
          limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
        });
        return rows.map((row: AiSessionRecord) => serializeSession(row, toIso));
      });
    },
  );

  codex
    .command("interrupt <session>")
    .description(
      "interrupt one Codex session by session_key, op:<op_id>, or session:<session_id>",
    )
    .option("--note <text>", "operator note stored with the interrupt request")
    .action(
      async (session: string, opts: { note?: string }, command: Command) => {
        await withContext(command, "codex interrupt", async (ctx: any) => {
          const response = await ctx.hub.aiSessions.interrupt({
            ...identityFromSessionId(session),
            note: opts.note?.trim() || undefined,
          });
          return serializeInterruptResponse(response);
        });
      },
    );

  codex
    .command("interrupt-all")
    .description(
      "interrupt all of your active or possibly active Codex sessions",
    )
    .option("--limit <n>", "max sessions to interrupt", "50")
    .option("--note <text>", "operator note stored with the interrupt requests")
    .action(
      async (opts: { limit?: string; note?: string }, command: Command) => {
        await withContext(command, "codex interrupt-all", async (ctx: any) => {
          const response = await ctx.hub.aiSessions.interruptAll({
            limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
            note: opts.note?.trim() || undefined,
          });
          return serializeInterruptAllResponse(response);
        });
      },
    );

  addListOptions(
    admin
      .command("sessions")
      .description("list Codex sessions across the site (admin-only)")
      .option("--account <account_id>", "filter by initiating account id"),
  ).action(
    async (
      opts: {
        active?: boolean;
        recent?: boolean;
        project?: string;
        host?: string;
        account?: string;
        paymentSource?: string;
        paymentSourceId?: string;
        paymentSourceOwner?: string;
        limit?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "codex admin sessions", async (ctx: any) => {
        const rows = await ctx.hub.aiSessions.adminList({
          activeOnly: opts.active ? true : undefined,
          target_account_id: opts.account?.trim() || undefined,
          project_id: opts.project?.trim() || undefined,
          host_id: opts.host?.trim() || undefined,
          payment_source_kind: opts.paymentSource?.trim() || undefined,
          payment_source_id: opts.paymentSourceId?.trim() || undefined,
          payment_source_owner_account_id:
            opts.paymentSourceOwner?.trim() || undefined,
          limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
        });
        return rows.map((row: AiSessionRecord) => serializeSession(row, toIso));
      });
    },
  );

  admin
    .command("interrupt <session>")
    .description(
      "interrupt any Codex session by session_key, op:<op_id>, or session:<session_id> (admin-only, fresh auth required)",
    )
    .option("--note <text>", "operator note stored with the interrupt request")
    .action(
      async (session: string, opts: { note?: string }, command: Command) => {
        await withContext(
          command,
          "codex admin interrupt",
          async (ctx: any) => {
            const response = await ctx.hub.aiSessions.adminInterrupt({
              ...identityFromSessionId(session),
              note: opts.note?.trim() || undefined,
            });
            return serializeInterruptResponse(response);
          },
        );
      },
    );

  admin
    .command("interrupt-all")
    .description(
      "interrupt all visible active Codex sessions (admin-only, fresh auth required)",
    )
    .option("--account <account_id>", "filter by initiating account id")
    .option("--project <project_id>", "filter by project id")
    .option("--host <host_id>", "filter by project-host id")
    .option("--limit <n>", "max sessions to interrupt", "50")
    .option("--note <text>", "operator note stored with the interrupt requests")
    .action(
      async (
        opts: {
          account?: string;
          project?: string;
          host?: string;
          limit?: string;
          note?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "codex admin interrupt-all",
          async (ctx: any) => {
            const response = await ctx.hub.aiSessions.adminInterruptAll({
              target_account_id: opts.account?.trim() || undefined,
              project_id: opts.project?.trim() || undefined,
              host_id: opts.host?.trim() || undefined,
              limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
              note: opts.note?.trim() || undefined,
            });
            return serializeInterruptAllResponse(response);
          },
        );
      },
    );

  return codex;
}
