import {
  Alert,
  Button,
  Card,
  Input,
  Popover,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type {
  HostAvailabilityCategory,
  HostAvailabilityDay,
  HostAvailabilityEvent,
  HostAvailabilityReport,
} from "@cocalc/conat/hub/api/hosts";
import { COLORS } from "@cocalc/util/theme";
import { webapp_client } from "@cocalc/frontend/webapp-client";

type Props = {
  availability?: HostAvailabilityReport;
  loading?: boolean;
  canAnnotate?: boolean;
  onAnnotated?: () => void | Promise<void>;
};

const CATEGORY_OPTIONS: { value: HostAvailabilityCategory; label: string }[] = [
  { value: "spot_interruption", label: "Spot interruption" },
  { value: "provider_repair", label: "Provider repair" },
  { value: "provider_offline", label: "Provider offline" },
  { value: "host_reboot", label: "Host reboot" },
  { value: "maintenance", label: "Maintenance" },
  { value: "resize_disk", label: "Disk resize" },
  { value: "deploy", label: "Deploy" },
  { value: "overload", label: "Overload" },
  { value: "user_stopped", label: "User stopped" },
  { value: "host_stale", label: "Heartbeat stale" },
  { value: "unknown", label: "Unknown" },
];

function formatDuration(ms?: number): string {
  const value = Math.max(0, Math.floor(Number(ms) || 0));
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatPercent(value?: number): string {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return "n/a";
  if (pct >= 99.995) return "100%";
  if (pct >= 99) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}

function eventLabel(event: HostAvailabilityEvent): string {
  const from = new Date(event.started_at).toLocaleString();
  const to = event.ended_at ? new Date(event.ended_at).toLocaleString() : "now";
  const kind = event.planned ? "planned" : "unplanned";
  return `${from} to ${to}: ${event.summary ?? event.category} (${kind})`;
}

function dayColor(day: HostAvailabilityDay): string {
  if (day.unplanned_downtime_ms > 0) {
    if (day.uptime_percent < 95) return COLORS.ANTD_RED;
    if (day.uptime_percent < 99.5) return COLORS.ANTD_ORANGE;
    return COLORS.YELL_D;
  }
  if (day.planned_downtime_ms > 0) return COLORS.GRAY_L;
  if (day.uptime_percent >= 99.995) return COLORS.ANTD_GREEN;
  return COLORS.BS_GREEN_LL;
}

function dayTitle(day: HostAvailabilityDay): React.JSX.Element {
  return (
    <Space orientation="vertical" size={4}>
      <Typography.Text strong>{day.date}</Typography.Text>
      <Typography.Text>
        Uptime: {formatPercent(day.uptime_percent)}
      </Typography.Text>
      {day.unplanned_downtime_ms > 0 && (
        <Typography.Text type="danger">
          Unplanned downtime: {formatDuration(day.unplanned_downtime_ms)}
        </Typography.Text>
      )}
      {day.planned_downtime_ms > 0 && (
        <Typography.Text type="secondary">
          Planned downtime: {formatDuration(day.planned_downtime_ms)}
        </Typography.Text>
      )}
      {day.events
        .filter((event) => event.state !== "online")
        .slice(0, 5)
        .map((event) => (
          <Typography.Text key={event.id} style={{ fontSize: 12 }}>
            {eventLabel(event)}
            {event.admin_note ? ` - ${event.admin_note}` : ""}
          </Typography.Text>
        ))}
      {day.events.filter((event) => event.state !== "online").length > 5 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Additional outage intervals omitted.
        </Typography.Text>
      )}
    </Space>
  );
}

function stateTag(report: HostAvailabilityReport): React.JSX.Element {
  const event = report.summary.current_event;
  if (report.summary.current_state === "online") {
    return <Tag color="green">Online</Tag>;
  }
  const color = event?.planned ? "orange" : "red";
  return <Tag color={color}>{report.summary.current_state}</Tag>;
}

function EventAnnotationEditor({
  event,
  hostId,
  onAnnotated,
}: {
  event: HostAvailabilityEvent;
  hostId: string;
  onAnnotated?: () => void | Promise<void>;
}): React.JSX.Element {
  const [summary, setSummary] = React.useState(event.summary ?? "");
  const [note, setNote] = React.useState(event.admin_note ?? "");
  const [planned, setPlanned] = React.useState(event.planned);
  const [category, setCategory] = React.useState<HostAvailabilityCategory>(
    event.category,
  );
  const [saving, setSaving] = React.useState(false);
  return (
    <Card size="small" type="inner">
      <Space orientation="vertical" style={{ width: "100%" }} size="small">
        <Space wrap>
          <Tag>{new Date(event.started_at).toLocaleString()}</Tag>
          {event.ended_at ? (
            <Tag>{new Date(event.ended_at).toLocaleString()}</Tag>
          ) : (
            <Tag color="red">open</Tag>
          )}
          <Switch
            checked={planned}
            checkedChildren="planned"
            unCheckedChildren="unplanned"
            onChange={setPlanned}
          />
          <Select
            size="small"
            style={{ minWidth: 170 }}
            value={category}
            options={CATEGORY_OPTIONS}
            onChange={setCategory}
          />
        </Space>
        <Input
          value={summary}
          placeholder="Short outage summary"
          onChange={(e) => setSummary(e.target.value)}
        />
        <Input.TextArea
          value={note}
          rows={2}
          placeholder="Admin note explaining what happened"
          onChange={(e) => setNote(e.target.value)}
        />
        <Space style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button
            size="small"
            type="primary"
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await webapp_client.conat_client.hub.hosts.annotateHostAvailabilityEvent(
                  {
                    id: hostId,
                    event_id: event.id,
                    summary: summary.trim() || null,
                    admin_note: note.trim() || null,
                    admin_note_visibility: "private",
                    planned,
                    category,
                  },
                );
                await onAnnotated?.();
                message.success("Availability annotation saved");
              } catch (err) {
                message.error(`${err}`);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save annotation
          </Button>
        </Space>
      </Space>
    </Card>
  );
}

export function HostAvailabilityPanel({
  availability,
  loading,
  canAnnotate,
  onAnnotated,
}: Props): React.JSX.Element {
  if (loading && !availability) {
    return (
      <Card size="small" title="Reliability">
        <Typography.Text type="secondary">
          Loading availability history...
        </Typography.Text>
      </Card>
    );
  }
  if (!availability) {
    return (
      <Card size="small" title="Reliability">
        <Typography.Text type="secondary">
          Availability history is not available yet.
        </Typography.Text>
      </Card>
    );
  }
  const currentEvent = availability.summary.current_event;
  const currentIsOnline = availability.summary.current_state === "online";
  const annotatableEvents = availability.events
    .filter((event) => event.state !== "online")
    .slice(-5)
    .reverse();
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      {!currentIsOnline && (
        <Alert
          type={currentEvent?.planned ? "warning" : "error"}
          showIcon
          message={
            currentEvent?.planned
              ? "Host is intentionally unavailable"
              : "Host is currently unavailable or recovering"
          }
          description={
            currentEvent?.summary ??
            "Projects on this host may be unavailable until recovery completes."
          }
        />
      )}
      <Card size="small" title="Reliability">
        <Space orientation="vertical" style={{ width: "100%" }} size="small">
          <Space wrap>
            {stateTag(availability)}
            <Tag>
              Reliability:{" "}
              {formatPercent(availability.summary.reliability_percent)}
            </Tag>
            <Tag>
              Current uptime:{" "}
              {currentIsOnline
                ? formatDuration(availability.summary.current_uptime_ms)
                : "not online"}
            </Tag>
            <Tag>
              {availability.window_days}d availability:{" "}
              {formatPercent(availability.summary.window_uptime_percent)}
            </Tag>
            <Tag
              color={
                availability.summary.unplanned_outage_count ? "red" : "green"
              }
            >
              Unplanned outages: {availability.summary.unplanned_outage_count}
            </Tag>
            <Tag>
              Exposure:{" "}
              {formatDuration(availability.summary.unplanned_downtime_ms)}
            </Tag>
            {availability.summary.planned_downtime_ms > 0 && (
              <Tag>
                Planned:{" "}
                {formatDuration(availability.summary.planned_downtime_ms)}
              </Tag>
            )}
          </Space>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(30, 14px)",
              gap: 4,
              alignItems: "center",
            }}
          >
            {availability.days.map((day) => (
              <Popover key={day.date} content={dayTitle(day)} trigger="hover">
                <div
                  title={`${day.date}: ${formatPercent(day.uptime_percent)}`}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    background: dayColor(day),
                    border: `1px solid ${COLORS.GRAY_L}`,
                  }}
                />
              </Popover>
            ))}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Reliability measures uptime only during periods when this host was
            intended to be online. Availability is wall-clock uptime over the
            whole window. Green days were reporting online; yellow/red indicates
            unplanned exposure; gray indicates planned downtime.
          </Typography.Text>
        </Space>
      </Card>
      {canAnnotate && annotatableEvents.length > 0 && (
        <Card size="small" title="Admin annotations">
          <Space orientation="vertical" style={{ width: "100%" }} size="small">
            <Typography.Text type="secondary">
              Add operational context after an outage or mark a downtime window
              as planned.
            </Typography.Text>
            {annotatableEvents.map((event) => (
              <EventAnnotationEditor
                key={event.id}
                event={event}
                hostId={availability.host_id}
                onAnnotated={onAnnotated}
              />
            ))}
          </Space>
        </Card>
      )}
    </Space>
  );
}
