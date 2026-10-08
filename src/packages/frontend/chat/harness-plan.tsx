import type { AcpStreamEvent } from "@cocalc/conat/ai/acp/types";
import {
  BorderOutlined,
  CaretRightOutlined,
  CheckSquareOutlined,
} from "@ant-design/icons";
import { Typography } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export type HarnessPlanStatus = "pending" | "in_progress" | "completed";

export interface HarnessPlanEntry {
  kind: "harness-plan";
  id: string;
  seq: number;
  time?: number;
  entries: { content: string; status: HarnessPlanStatus }[];
}

const MAX_ITEMS = 100;
const MAX_ITEM_CHARS = 1000;

/**
 * ACP plan updates (Claude's task list) carry the complete list every time.
 * Keep one checklist per activity log showing the latest list, placed where
 * it last changed so it stays next to the current work.
 */
export function updateHarnessPlan(
  event: AcpStreamEvent,
  plan: { current?: HarnessPlanEntry },
  seq: number,
  time?: number,
): HarnessPlanEntry | undefined | false {
  if (event.type !== "harness" || event.kind !== "update") return false;
  const update = event.data as any;
  if (update?.sessionUpdate !== "plan") return false;
  if (!Array.isArray(update.entries)) return undefined;
  const entries = update.entries.slice(0, MAX_ITEMS).flatMap((item: any) =>
    typeof item?.content === "string" && item.content.trim()
      ? [
          {
            content: item.content.slice(0, MAX_ITEM_CHARS),
            status: ["pending", "in_progress", "completed"].includes(
              item.status,
            )
              ? item.status
              : "pending",
          },
        ]
      : [],
  );
  if (plan.current) {
    plan.current.entries = entries;
    plan.current.seq = seq;
    plan.current.time = time ?? plan.current.time;
    return undefined;
  }
  plan.current = {
    kind: "harness-plan",
    id: "harness-plan",
    seq,
    time,
    entries,
  };
  return plan.current;
}

const STATUS_TEXT: Record<HarnessPlanStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Done",
};

// Read by screen readers only; the icon shows the status visually.
const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

function StatusIcon({ status }: { status: HarnessPlanStatus }) {
  if (status === "completed")
    return (
      <CheckSquareOutlined aria-hidden style={{ color: UI_COLORS.success }} />
    );
  if (status === "in_progress")
    return <CaretRightOutlined aria-hidden style={{ color: UI_COLORS.info }} />;
  return <BorderOutlined aria-hidden style={{ color: UI_COLORS.secondary }} />;
}

export function HarnessPlanRow({
  entry,
  fontSize = 14,
}: {
  entry: HarnessPlanEntry;
  fontSize?: number;
}) {
  const done = entry.entries.filter((e) => e.status === "completed").length;
  return (
    <section
      aria-label="Agent task list"
      style={{
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      <Typography.Text strong>Tasks</Typography.Text>{" "}
      <Typography.Text type="secondary">
        {done} of {entry.entries.length} done
      </Typography.Text>
      <ul style={{ listStyle: "none", margin: "6px 0 0 0", padding: 0 }}>
        {entry.entries.map((item, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
              fontSize,
              overflowWrap: "anywhere",
            }}
          >
            <StatusIcon status={item.status} />
            <span style={VISUALLY_HIDDEN}>{STATUS_TEXT[item.status]}: </span>
            <span
              style={
                item.status === "completed"
                  ? { color: UI_COLORS.secondary }
                  : item.status === "in_progress"
                    ? { fontWeight: 600 }
                    : undefined
              }
            >
              {item.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function harnessPlanToMarkdown(entry: HarnessPlanEntry): string {
  return [
    "- Tasks:",
    ...entry.entries.map(
      (item) =>
        `  - [${item.status === "completed" ? "x" : " "}] ${item.content}${item.status === "in_progress" ? " (in progress)" : ""}`,
    ),
  ].join("\n");
}
