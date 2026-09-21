import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

/** Runtime-neutral identity for ACP and network senders, not a model vendor. */
export function MessageAvatar({
  accountId,
  agentLabel,
  size = 40,
}: {
  accountId?: string;
  agentLabel?: string;
  size?: number;
}) {
  if (!agentLabel) return <Avatar account_id={accountId} size={size} />;
  return (
    <span
      role="img"
      aria-label={agentLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize: size * 0.7,
        color: UI_COLORS.secondary,
      }}
    >
      <Icon name="robot" />
    </span>
  );
}
