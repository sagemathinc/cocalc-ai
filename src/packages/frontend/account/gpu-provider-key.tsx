/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Settings > Connectors: the account's own RunPod API key, which CoCalc uses to
launch and manage GPUs that RunPod bills to the user directly.
*/

import {
  Alert,
  Button,
  Input,
  Popconfirm,
  Space,
  Spin,
  Typography,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  type GpuProviderKeyStatus,
  VERIFY_RPC_TIMEOUT_MS,
} from "@cocalc/util/gpu/provider-keys";
import { joinUrlPath } from "@cocalc/util/url-path";

export const RUNPOD_SECTION = "RunPod GPUs";

const RUNPOD_API_KEYS_URL = "https://console.runpod.io/user/credentials";

export function GpuProviderKeySection() {
  const [status, setStatus] = useState<GpuProviderKeyStatus>();
  const [loadError, setLoadError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set synchronously, so a save and a removal can never both start, even
  // from a confirmation that was already open.
  const busyRef = useRef(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const refresh = useCallback(async () => {
    setLoadError("");
    try {
      setStatus(
        await webapp_client.conat_client.hub.system.getGpuProviderKeyStatus({
          provider: "runpod",
        }),
      );
    } catch (err) {
      setLoadError(`${err}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async () => {
    const key = apiKey.trim();
    if (!key || busyRef.current) return;
    busyRef.current = true;
    setConfirmRemove(false);
    setBusy(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        setStatus(
          await webapp_client.conat_client.hub.system.setGpuProviderKey({
            provider: "runpod",
            api_key: key,
            browser_id: webapp_client.browser_id,
            timeout: VERIFY_RPC_TIMEOUT_MS,
          }),
        );
      });
      if (completed) {
        setApiKey("");
        setReplacing(false);
      }
    } catch (err) {
      setError(`${err}`);
      // Show what the server actually has, e.g. after a timeout.
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.system.deleteGpuProviderKey({
          provider: "runpod",
          browser_id: webapp_client.browser_id,
        });
      });
      if (completed) await refresh();
    } catch (err) {
      setError(`${err}`);
      // The removal may have happened before a timeout or a lost reply.
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const keyForm = (
    <Space orientation="vertical" style={{ width: "100%", maxWidth: 600 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        On{" "}
        <a href={RUNPOD_API_KEYS_URL} target="_blank" rel="noreferrer">
          RunPod&apos;s Credentials page
        </a>{" "}
        (API Keys tab), create a key just for CoCalc with &quot;All&quot;
        permissions, so CoCalc can start and stop pods. Paste it here. CoCalc
        checks it with RunPod before saving it, and never shows it again.
      </Typography.Paragraph>
      <Space.Compact style={{ width: "100%" }}>
        <Input.Password
          aria-label="RunPod API key"
          autoComplete="off"
          placeholder="RunPod API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onPressEnter={() => void connect()}
        />
        <Button
          type="primary"
          loading={busy}
          disabled={busy || !apiKey.trim()}
          onClick={() => void connect()}
        >
          {status?.connected ? "Replace key" : "Connect"}
        </Button>
      </Space.Compact>
    </Space>
  );

  let body;
  if (loadError) {
    body = (
      <Alert
        type="error"
        title="Unable to load your RunPod connection"
        description={loadError}
        action={<Button onClick={() => void refresh()}>Retry</Button>}
      />
    );
  } else if (status == null) {
    body = <Spin aria-label="Loading your RunPod connection" />;
  } else if (status.connected) {
    const account = status.provider_account;
    body = (
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Connected to RunPod
          {account
            ? account.kind === "organization"
              ? ` organization ${account.name ?? account.id}`
              : ` account ${account.id}`
            : ""}
          {status.connected_at && (
            <>
              {" "}
              (<TimeAgo date={status.connected_at} />)
            </>
          )}
          .
        </Typography.Paragraph>
        <Space>
          {!replacing && (
            <Button disabled={busy} onClick={() => setReplacing(true)}>
              Replace key
            </Button>
          )}
          <Popconfirm
            title="Remove your RunPod key?"
            description={
              <div style={{ maxWidth: 360 }}>
                This deletes CoCalc&apos;s copy of the key. To fully revoke it,
                also delete it on RunPod&apos;s Credentials page (API Keys tab).
              </div>
            }
            okText="Remove"
            okButtonProps={{ danger: true, disabled: busy }}
            open={confirmRemove && !busy}
            onOpenChange={(open) => setConfirmRemove(open && !busyRef.current)}
            onConfirm={() => void remove()}
          >
            <Button danger disabled={busy}>
              Remove
            </Button>
          </Popconfirm>
        </Space>
        {replacing && keyForm}
      </Space>
    );
  } else if (!status.entitled) {
    body = (
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        Your membership doesn&apos;t include RunPod GPUs.{" "}
        <a href={joinUrlPath(appBasePath, "settings", "membership")}>
          See memberships
        </a>
        .
      </Typography.Paragraph>
    );
  } else {
    body = keyForm;
  }

  return (
    <Panel header={RUNPOD_SECTION}>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 900 }}>
        Connect your own RunPod account, and CoCalc can launch and manage GPUs
        for you and your agents. RunPod bills you directly; CoCalc adds no
        markup.
      </Typography.Paragraph>
      {body}
      {error && (
        <Alert
          role="alert"
          type="error"
          showIcon
          title={error}
          style={{ marginTop: 12 }}
        />
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Panel>
  );
}
