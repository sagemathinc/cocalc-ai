import { Button, Space, Typography } from "antd";
import CloudflareCredentialRotationHelp from "./cloudflare-credential-rotation-help";

export default function CloudflareSettingsEntry({
  onConfigure,
  storageOnly = false,
}: {
  onConfigure: () => void;
  storageOnly?: boolean;
}) {
  return (
    <div style={{ margin: "8px 0 16px" }}>
      <Typography.Paragraph type="secondary">
        {storageOnly
          ? "R2 backups and blob storage are configured in the Cloudflare setup wizard. Individual fields are available with Show hidden."
          : "Set up Cloudflare credentials, tunnels and R2 storage, or check an existing configuration."}
      </Typography.Paragraph>
      <Space wrap size="middle">
        <Button
          type={storageOnly ? "default" : "primary"}
          onClick={onConfigure}
        >
          {storageOnly ? "Configure R2 storage" : "Configure Cloudflare"}
        </Button>
        {!storageOnly && <CloudflareCredentialRotationHelp />}
      </Space>
    </div>
  );
}

type SettingItem = { name: string; conf: { type?: string; wizard?: unknown } };

export function hasVisibleSettings(items: SettingItem[]): boolean {
  return items.some(
    ({ conf }) => conf.type !== "header" || conf.wizard != null,
  );
}

// Cloudflare's entry point replaces its lone mode row; keep raw controls
// available with Show hidden. Don't create empty disclosures from headers.
export function showSettingsSubgroup(
  group: string,
  subgroup: string,
  items: SettingItem[],
  showHidden: boolean,
): boolean {
  if (
    group === "Cloudflare" &&
    !showHidden &&
    items.every(
      ({ name, conf }) => name === "cloudflare_mode" || conf.type === "header",
    )
  )
    return false;
  return (
    (group === "Backups & Storage" && subgroup === "Cloudflare R2") ||
    hasVisibleSettings(items)
  );
}
