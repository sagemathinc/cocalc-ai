import { TimeAgo } from "@cocalc/frontend/components";

export function SearchHitTime({ date }: { date: number }) {
  if (!Number.isFinite(date)) return null;
  const value = new Date(date);
  if (!Number.isFinite(value.valueOf())) return null;
  return (
    <time
      dateTime={value.toISOString()}
      title={value.toLocaleString()}
      style={{ display: "block", fontSize: 12 }}
    >
      <TimeAgo date={value} click_to_toggle={false} />
    </time>
  );
}
