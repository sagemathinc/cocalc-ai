import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Popconfirm, Space, Spin } from "antd";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { Icon } from "@cocalc/frontend/components";
import {
  listRemoteKernelTargets,
  removeRemoteKernelTarget,
  type RemoteKernelTarget,
} from "./remote-kernel-service";

export default function RemoteKernelTargets({
  project_id,
  onRemoved,
}: {
  project_id: string;
  onRemoved?: () => Promise<void>;
}) {
  const [targets, setTargets] = useState<RemoteKernelTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);

  async function refresh() {
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const data = await listRemoteKernelTargets(project_id);
      if (current === generation.current) setTargets(data);
    } catch (err) {
      if (current === generation.current) setError(String(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [project_id]);

  async function remove(name: string) {
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      await removeRemoteKernelTarget(project_id, name);
      if (current !== generation.current) return;
      await onRemoved?.();
      if (current === generation.current) await refresh();
    } catch (err) {
      if (current === generation.current) setError(String(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <>
      <Button onClick={refresh} disabled={busy} icon={<Icon name="refresh" />}>
        Refresh targets
      </Button>
      {error && (
        <Alert
          type="error"
          showIcon
          title="Remote kernel operation failed"
          description={error}
          style={{ marginTop: 12 }}
        />
      )}
      <div role="status" aria-live="polite">
        {busy && <Spin aria-label="Updating remote kernels" />}
      </div>
      {!busy && !targets.length && <Empty description="No remote kernels" />}
      {targets.map((target) => (
        <div
          key={target.name}
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            padding: "12px 0",
          }}
        >
          <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            <strong>{target.name}</strong>
            <div>
              {target.host} / {target.environment}
            </div>
            {target.disabled && (
              <div>Removal incomplete; retry to finish stopping sessions.</div>
            )}
          </div>
          <Space>
            <Popconfirm
              title={`Remove ${target.name}?`}
              description="This stops its running kernels in all notebooks. The VM and its files are not deleted."
              okText="Stop kernels and remove"
              onConfirm={() => remove(target.name)}
            >
              <Tooltip title="Remove remote kernel">
                <Button
                  danger
                  disabled={busy}
                  aria-label={`Remove ${target.name}`}
                  icon={<Icon name="trash" />}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        </div>
      ))}
    </>
  );
}
