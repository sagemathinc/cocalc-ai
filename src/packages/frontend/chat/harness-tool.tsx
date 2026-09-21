import type { AcpStreamEvent } from "@cocalc/conat/ai/acp/types";

export interface HarnessToolEntry {
  kind: "harness-tool";
  id: string;
  seq: number;
  time?: number;
  title: string;
  status: string;
  output: string;
}

const LIMIT = 32 * 1024;
function bounded(value: unknown, limit = LIMIT): string {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
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
  tools.set(update.toolCallId, entry);
  return previous ? undefined : entry;
}

export function HarnessToolRow({ entry }: { entry: HarnessToolEntry }) {
  return (
    <details style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <summary>
        {entry.title || "ACP tool"} · {entry.status}
      </summary>
      <pre
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
