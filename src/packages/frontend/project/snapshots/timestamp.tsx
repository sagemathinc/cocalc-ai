import { TimeAgo } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const SNAPSHOT_TIMESTAMP_RE =
  /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

export function extractSnapshotTimestamp(name?: string): Date | undefined {
  const match = `${name ?? ""}`.match(SNAPSHOT_TIMESTAMP_RE);
  if (match == null) {
    return undefined;
  }
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function formatSnapshotLocalTimestamp(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function SnapshotTimestamp({
  name,
  clickToToggle = false,
}: {
  name?: string;
  clickToToggle?: boolean;
}) {
  const timestamp = extractSnapshotTimestamp(name);
  if (timestamp == null) {
    return null;
  }
  return (
    <span
      style={{
        color: UI_COLORS.secondary,
        display: "inline-flex",
        flexDirection: "column",
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
      title={timestamp.toISOString()}
    >
      <span>{formatSnapshotLocalTimestamp(timestamp)}</span>
      <span style={{ fontSize: "11px" }}>
        <TimeAgo
          date={timestamp.toISOString()}
          click_to_toggle={clickToToggle}
        />
      </span>
    </span>
  );
}
