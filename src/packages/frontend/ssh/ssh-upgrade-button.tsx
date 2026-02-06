import { Button, Modal, Space, Tooltip, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { alert_message } from "@cocalc/frontend/alerts";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { UpgradeInfo } from "@cocalc/conat/hub/api/ssh";

const BUTTON_STYLE: React.CSSProperties = {
  margin: "2.5px 0 0 6px",
  maxWidth: "140px",
  display: "inline-flex",
  alignItems: "center",
} as const;

const LABEL_STYLE: React.CSSProperties = {
  marginLeft: "6px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const SKIP_KEY = "cocalc-plus-upgrade-skip";
const INFO_KEY = "cocalc-plus-upgrade-info";

export default function SshUpgradeButton() {
  const [upgradeInfo, setUpgradeInfo] = React.useState<UpgradeInfo | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [upgrading, setUpgrading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [skippedVersion, setSkippedVersion] = React.useState<string | null>(
    typeof window !== "undefined"
      ? window.localStorage.getItem(SKIP_KEY)
      : null,
  );

  const loadUpgradeInfo = React.useCallback(async (force = false) => {
    setChecking(true);
    try {
      const data = await webapp_client.conat_client.hub.ssh.getUpgradeInfoUI({
        force,
        scope: "local",
      });
      setUpgradeInfo(data?.local ?? null);
    } catch (err: any) {
      // ignore
    } finally {
      setChecking(false);
    }
  }, []);

  React.useEffect(() => {
    const readStored = () => {
      try {
        const raw = window.localStorage.getItem(INFO_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed?.currentVersion || parsed?.latestVersion) {
          setUpgradeInfo(parsed);
        }
      } catch {
        // ignore storage parse errors
      }
    };
    readStored();
    void loadUpgradeInfo(false);
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as UpgradeInfo | undefined;
      if (detail) {
        setUpgradeInfo(detail);
      } else {
        readStored();
      }
    };
    window.addEventListener("cocalc-plus-upgrade-info", handler);
    return () => {
      window.removeEventListener("cocalc-plus-upgrade-info", handler);
    };
  }, [loadUpgradeInfo]);

  const latestVersion = upgradeInfo?.latestVersion;
  const upgradeAvailable =
    !!upgradeInfo?.upgradeAvailable &&
    !!latestVersion &&
    latestVersion !== skippedVersion;

  if (!upgradeAvailable) {
    return null;
  }

  const handleSkip = () => {
    if (!latestVersion) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SKIP_KEY, latestVersion);
    }
    setSkippedVersion(latestVersion);
    setOpen(false);
  };

  const handleUpgrade = async () => {
    setUpgrading(true);
    try {
      await webapp_client.conat_client.hub.ssh.upgradeLocalUI();
      await loadUpgradeInfo(true);
      alert_message({
        type: "success",
        message: "Upgrade started. Restart to use the new version.",
      });
      setOpen(false);
    } catch (err: any) {
      alert_message({
        type: "error",
        message: err?.message || String(err),
      });
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <>
      <Tooltip
        title={
          upgradeInfo?.latestVersion
            ? `Upgrade available: v${upgradeInfo.latestVersion}`
            : "Upgrade available"
        }
      >
        <Button
          type="text"
          style={BUTTON_STYLE}
          onClick={() => setOpen(true)}
          loading={checking}
        >
          <Icon name="refresh" />
          <span style={LABEL_STYLE}>Upgrade</span>
        </Button>
      </Tooltip>
      <Modal
        title="Upgrade available"
        open={open}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>
            Cancel
          </Button>,
          <Button key="skip" onClick={handleSkip}>
            Skip
          </Button>,
          <Button
            key="upgrade"
            type="primary"
            loading={upgrading}
            onClick={handleUpgrade}
          >
            Upgrade
          </Button>,
        ]}
      >
        <Space orientation="vertical" size={12}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            A newer version of CoCalc Plus is available. Upgrading downloads the
            latest binary to your system. You may need to restart CoCalc Plus to
            use the new version.
          </Typography.Paragraph>
          <Typography.Text>
            Current: {upgradeInfo?.currentVersion ?? "unknown"}
          </Typography.Text>
          <Typography.Text>
            Latest: {upgradeInfo?.latestVersion ?? "unknown"}
          </Typography.Text>
        </Space>
      </Modal>
    </>
  );
}
