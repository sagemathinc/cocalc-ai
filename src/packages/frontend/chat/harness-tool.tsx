import type { AcpStreamEvent } from "@cocalc/conat/ai/acp/types";
import { Typography } from "antd";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { ActivityCodeBlock, stripAnsi } from "./activity-code-block";

export interface HarnessToolEntry {
  kind: "harness-tool";
  id: string;
  seq: number;
  time?: number;
  title: string;
  status: string;
  output: string;
  input?: { script?: string; cwd?: string; jobId?: string };
  result?: {
    stdout: string;
    stderr: string;
    error: string;
    status: string;
    code?: number;
    jobId: string;
    truncated: boolean;
    hasMore: boolean;
    cleanupPending: boolean;
    cleanupError: string;
  };
}

const LIMIT = 32 * 1024;
function bounded(value: unknown, limit = LIMIT): string {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

function projectExecName(title: string): string | undefined {
  return /^(?:mcp__cocalc_project(?:_[a-f0-9]+)?__)?(project_exec(?:_wait|_cancel)?)$/.exec(
    title,
  )?.[1];
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    if (value.length > 256 * 1024) return;
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function executionResult(value: unknown): HarnessToolEntry["result"] {
  // ACP content wraps MCP text blocks; rawOutput can contain those blocks directly.
  if (Array.isArray(value) && value.length === 1) {
    const item = value[0];
    value = item?.type === "content" ? item.content : item;
    if ((value as any)?.type === "text") value = (value as any).text;
  }
  const result = jsonObject(value);
  if (
    !result ||
    !(
      typeof result.stdout === "string" ||
      typeof result.stderr === "string" ||
      typeof result.code === "number"
    )
  )
    return;
  return {
    stdout: bounded(result.stdout),
    stderr: bounded(result.stderr),
    error: bounded(result.error),
    status: [
      "running",
      "completed",
      "failed",
      "cancelled",
      "canceled",
      "timed_out",
    ].includes(String(result.status))
      ? String(result.status)
      : "",
    code:
      typeof result.code === "number" && Number.isFinite(result.code)
        ? result.code
        : undefined,
    jobId: bounded(result.job_id, 128),
    truncated: result.truncated === true || result.output_truncated === true,
    hasMore: result.has_more === true,
    cleanupPending: result.cleanup_pending === true,
    cleanupError: bounded(result.cleanup_error),
  };
}

/** ACP updates replace supplied fields; omitted fields retain their prior value. */
export function updateHarnessTool(
  event: AcpStreamEvent,
  tools: Map<string, HarnessToolEntry>,
  seq: number,
  time?: number,
): HarnessToolEntry | undefined {
  if (event.type !== "harness" || event.kind !== "update") return;
  const update = event.data as any;
  if (
    !["tool_call", "tool_call_update"].includes(update?.sessionUpdate) ||
    typeof update.toolCallId !== "string" ||
    !update.toolCallId ||
    update.toolCallId.length > 1024
  )
    return;
  const previous = tools.get(update.toolCallId);
  const entry: HarnessToolEntry = previous ?? {
    kind: "harness-tool",
    id: `harness-tool-${seq}`,
    seq,
    time,
    title: "ACP tool",
    status: "unknown",
    output: "",
  };
  if (typeof update.title === "string")
    entry.title = bounded(update.title, 512);
  if (typeof update.status === "string") {
    entry.status = ["pending", "in_progress", "completed", "failed"].includes(
      update.status,
    )
      ? update.status.replaceAll("_", " ")
      : "unknown";
  }
  if (Array.isArray(update.content)) {
    const parts: string[] = [];
    let remaining = LIMIT;
    for (const item of update.content.slice(0, 128)) {
      const text =
        item?.type === "content" && item.content?.type === "text"
          ? bounded(item.content.text, remaining)
          : item?.type === "diff"
            ? `Reported edit: ${bounded(item.path, 1024)}`
            : item?.type === "terminal"
              ? `Harness terminal: ${bounded(item.terminalId, 1024)}`
              : "[Non-text tool content]";
      parts.push(text);
      remaining -= text.length;
      if (remaining <= 0) break;
    }
    entry.output = bounded(parts.join("\n"));
  }
  if (projectExecName(entry.title)) {
    if (update.rawInput !== undefined) {
      const input = jsonObject(update.rawInput);
      entry.input = input
        ? {
            script:
              typeof input.script === "string"
                ? bounded(input.script)
                : undefined,
            cwd:
              typeof input.cwd === "string"
                ? bounded(input.cwd, 4096)
                : undefined,
            jobId:
              typeof input.job_id === "string"
                ? bounded(input.job_id, 128)
                : undefined,
          }
        : undefined;
    }
    if (update.content !== undefined || update.rawOutput !== undefined) {
      entry.result =
        executionResult(update.content) ?? executionResult(update.rawOutput);
    }
  }
  tools.set(update.toolCallId, entry);
  return previous ? undefined : entry;
}

export function HarnessToolRow({
  entry,
  fontSize = 14,
  editorTheme,
}: {
  entry: HarnessToolEntry;
  fontSize?: number;
  editorTheme?: string | null;
}) {
  const tool = projectExecName(entry.title);
  if (tool) {
    const result = entry.result;
    const sections = [
      { label: "Input", text: entry.input?.script, language: "sh" as const },
      { label: "Output", text: result ? result.stdout : entry.output },
      { label: "stderr", text: result?.stderr },
      { label: "Error", text: result?.error },
      { label: "Cleanup error", text: result?.cleanupError },
    ];
    return (
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {entry.time != null && (
          <Typography.Text
            type="secondary"
            style={{ marginRight: 8, fontSize: Math.max(11, fontSize - 2) }}
          >
            <TimeAgo date={new Date(entry.time)} />
          </Typography.Text>
        )}
        <Typography.Text
          type="secondary"
          title={entry.title}
          style={{ fontSize: Math.max(11, fontSize - 2) }}
        >
          {tool === "project_exec"
            ? "Project command"
            : tool === "project_exec_wait"
              ? "Wait for project command"
              : "Cancel project command"}
          {" · "}
          {result?.status || entry.status}
          {result?.code !== undefined ? ` · exit ${result.code}` : ""}
          {entry.input?.cwd ? ` · cwd ${entry.input.cwd}` : ""}
        </Typography.Text>
        {(result?.jobId || entry.input?.jobId) && (
          <Typography.Text
            type="secondary"
            style={{ display: "block", fontSize: Math.max(11, fontSize - 2) }}
          >
            Job {result?.jobId || entry.input?.jobId}
          </Typography.Text>
        )}
        {sections
          .filter(({ text }) => !!text)
          .map(({ label, text, language }) => (
            <section
              key={label}
              aria-label={`Project command ${label.toLowerCase()}`}
            >
              <Typography.Text
                type="secondary"
                style={{
                  display: "block",
                  marginTop: 6,
                  marginBottom: 4,
                  fontSize: Math.max(11, fontSize - 2),
                }}
              >
                {label}
              </Typography.Text>
              <ActivityCodeBlock
                value={stripAnsi(text!)}
                language={language}
                fontSize={fontSize}
                editorTheme={editorTheme}
              />
            </section>
          ))}
        {result?.truncated && (
          <Typography.Text type="secondary">Output truncated</Typography.Text>
        )}
        {result?.hasMore && (
          <Typography.Text type="secondary" style={{ display: "block" }}>
            More output available in subsequent job polls.
          </Typography.Text>
        )}
        {result?.cleanupPending && (
          <Typography.Text type="warning" style={{ display: "block" }}>
            Job cleanup pending
          </Typography.Text>
        )}
        {!sections.some(({ label, text }) => label !== "Input" && !!text) && (
          <Typography.Text type="secondary" style={{ display: "block" }}>
            {result?.status === "running" ||
            entry.status === "in progress" ||
            entry.status === "pending"
              ? "Waiting for output..."
              : "No output."}
          </Typography.Text>
        )}
      </div>
    );
  }
  return (
    <details style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <summary>
        {entry.title || "ACP tool"} · {entry.status}
      </summary>
      <pre
        role="region"
        aria-label={`${entry.title || "ACP tool"} output`}
        tabIndex={0}
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxHeight: 320,
          overflow: "auto",
        }}
      >
        {entry.output || "No text output reported by this harness."}
      </pre>
    </details>
  );
}
