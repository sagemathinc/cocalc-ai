import { Button, Popover, Tag, Typography } from "antd";
import type { AcpStreamEvent } from "@cocalc/conat/ai/acp/types";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Text } = Typography;
export type PeerMessageEvent = Extract<AcpStreamEvent, { type: "peerMessage" }>;

function targetLabel(event: PeerMessageEvent): string {
  const name = event.target_name?.trim().replace(/^@/, "");
  return name ? `@${name}` : "agent";
}

function outcomeColor(outcome: PeerMessageEvent["outcome"]): string {
  if (outcome === "accepted") return "green";
  if (outcome === "rejected") return "red";
  return "orange";
}

export function PeerMessageCard({ event }: { event: PeerMessageEvent }) {
  const label = targetLabel(event);
  return (
    <section
      aria-label={`Message sent to ${label}`}
      style={{
        alignItems: "center",
        background: UI_COLORS.successBg,
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 8,
        display: "flex",
        gap: 8,
        minWidth: 0,
        padding: "5px 8px",
      }}
    >
      <Tag color="green" style={{ flex: "0 0 auto", margin: 0 }}>
        To {label}
      </Tag>
      <Text
        ellipsis={{ tooltip: event.body }}
        style={{ flex: 1, minWidth: 0, color: UI_COLORS.text }}
      >
        {event.body}
      </Text>
      <Tag
        color={outcomeColor(event.outcome)}
        style={{ flex: "0 0 auto", margin: 0 }}
      >
        {event.outcome}
      </Tag>
      <Popover
        placement="bottomRight"
        trigger="click"
        title={`Message to ${label}`}
        content={
          <div style={{ maxWidth: 460, fontSize: 12 }}>
            <div>
              <Text strong>Attempt: </Text>
              <Text copyable={{ text: event.attempt_id }}>
                {event.attempt_id}
              </Text>
            </div>
            <div>
              <Text strong>Agent Network: </Text>
              <Text>{event.agent_network_title || "Agent Network"}</Text>
            </div>
            {event.reason ? (
              <div>
                <Text strong>Result: </Text>
                <Text>{event.reason}</Text>
              </div>
            ) : null}
          </div>
        }
      >
        <Button type="link" size="small" style={{ padding: 0 }}>
          Inspect
        </Button>
      </Popover>
    </section>
  );
}

export function PeerMessageList({ events }: { events: PeerMessageEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        margin: "5px 0 8px",
      }}
    >
      {events.map((event) => (
        <PeerMessageCard key={event.attempt_id} event={event} />
      ))}
    </div>
  );
}
