import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  message,
} from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import ShowError from "@cocalc/frontend/components/error";
import { Icon } from "@cocalc/frontend/components/icon";
import { TimeAgo } from "@cocalc/frontend/components";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  SnapshotRestoreMode,
  SnapshotUsage,
} from "@cocalc/conat/files/file-server";
import { human_readable_size } from "@cocalc/util/misc";

type SnapshotRestoreEntry = SnapshotUsage & {
  parsedTime?: Date;
};

const MODE_DESCRIPTION: Record<SnapshotRestoreMode, string> = {
  both: "Restore the full project filesystem and root filesystem image from this snapshot, then restart the project.",
  home: "Restore only HOME=/root from this snapshot and keep the current root filesystem image.",
  rootfs:
    "Restore only the root filesystem image from this snapshot and keep the current HOME=/root files.",
};

const MODE_LABEL: Record<SnapshotRestoreMode, string> = {
  both: "Restore both HOME and rootfs",
  home: "Restore HOME only",
  rootfs: "Restore rootfs only",
};

function sortSnapshots(snapshots: SnapshotUsage[]): SnapshotRestoreEntry[] {
  const sorted = snapshots.map((snapshot) => {
    const parsed = new Date(snapshot.name);
    return {
      ...snapshot,
      parsedTime: Number.isNaN(parsed.getTime()) ? undefined : parsed,
    };
  });
  sorted.sort((a, b) => {
    const aTime = a.parsedTime?.getTime();
    const bTime = b.parsedTime?.getTime();
    if (aTime != null && bTime != null && aTime !== bTime) {
      return bTime - aTime;
    }
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    return b.name.localeCompare(a.name);
  });
  return sorted;
}

function defaultSafetySnapshotName(snapshot: string): string {
  return `restore-safety-${snapshot}-${new Date().toISOString()}`;
}

export default function RestoreSnapshot() {
  const { actions, project_id } = useProjectContext();
  const openRestore = useTypedRedux({ project_id }, "open_restore_snapshot");
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingSnapshots, setLoadingSnapshots] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [snapshots, setSnapshots] = useState<SnapshotRestoreEntry[]>([]);
  const [snapshot, setSnapshot] = useState<string>("");
  const [mode, setMode] = useState<SnapshotRestoreMode>("both");
  const [safetySnapshotName, setSafetySnapshotName] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    actions?.setState({ disableExplorerKeyhandler: true });
    return () => {
      actions?.setState({ disableExplorerKeyhandler: false });
    };
  }, [actions, open]);

  useEffect(() => {
    if (!openRestore) return;
    setOpen(true);
    actions?.setState({ open_restore_snapshot: false });
  }, [actions, openRestore]);

  useEffect(() => {
    if (!open || !project_id) return;
    let canceled = false;
    (async () => {
      try {
        setLoadingSnapshots(true);
        setError("");
        const usage =
          await webapp_client.conat_client.hub.projects.allSnapshotUsage({
            project_id,
          });
        if (canceled) return;
        const sorted = sortSnapshots(usage);
        setSnapshots(sorted);
        setSnapshot((current) =>
          current && sorted.some((entry) => entry.name === current)
            ? current
            : (sorted[0]?.name ?? ""),
        );
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoadingSnapshots(false);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [open, project_id]);

  useEffect(() => {
    if (!open || !snapshot) return;
    setSafetySnapshotName(defaultSafetySnapshotName(snapshot));
  }, [open, snapshot]);

  const selectedSnapshot = useMemo(
    () => snapshots.find((entry) => entry.name === snapshot),
    [snapshot, snapshots],
  );

  async function restoreSnapshot() {
    try {
      if (!snapshot) {
        throw new Error("Choose a snapshot to restore.");
      }
      const trimmedSafetyName = safetySnapshotName.trim();
      if (!trimmedSafetyName) {
        throw new Error("Safety snapshot name must be nonempty.");
      }
      if (trimmedSafetyName === snapshot) {
        throw new Error(
          "Safety snapshot name must differ from the snapshot being restored.",
        );
      }
      setLoading(true);
      setError("");
      const op = await webapp_client.conat_client.hub.projects.restoreSnapshot({
        project_id,
        snapshot,
        mode,
        safety_snapshot_name: trimmedSafetyName,
      });
      actions?.trackRestoreOp?.(op);
      message.success("Snapshot restore started");
      setOpen(false);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button disabled={open} onClick={() => setOpen(true)}>
        <Icon name="undo" /> Restore Snapshot
      </Button>
      {open ? (
        <Modal
          destroyOnHidden
          width={760}
          open={open}
          onCancel={() => setOpen(false)}
          title={
            <>
              <Icon name="undo" /> Restore Snapshot
              {(loading || loadingSnapshots) && (
                <Spin style={{ float: "right", marginRight: "15px" }} />
              )}
            </>
          }
          footer={[
            <Button
              key="cancel"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>,
            <Button
              key="restore"
              type="primary"
              danger
              loading={loading}
              disabled={loadingSnapshots || !snapshot}
              onClick={restoreSnapshot}
            >
              Restore Snapshot
            </Button>,
          ]}
        >
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="warning"
              showIcon
              title="This is a total project restore, not a file copy."
              description={
                <span>
                  This workflow stops the project, creates a safety snapshot of
                  the current state, restores the selected snapshot, and starts
                  the project again. Use snapshot browsing or search if you only
                  want to copy back a few files.
                </span>
              }
            />
            <Alert
              type="info"
              showIcon
              title="Restoring can rewind CoCalc documents stored in the project."
              description={
                <span>
                  A full restore can roll back project files and CoCalc content
                  stored in the project filesystem, including chatrooms, Codex
                  threads, notebooks, and other documents in the restored paths.
                </span>
              }
            />
            <div>
              <div style={{ marginBottom: "6px", color: "#666" }}>
                Snapshot to restore
              </div>
              <Select
                showSearch
                style={{ width: "100%" }}
                value={snapshot || undefined}
                placeholder={
                  loadingSnapshots
                    ? "Loading snapshots..."
                    : "Choose a snapshot to restore"
                }
                optionFilterProp="label"
                onChange={(value) => setSnapshot(value)}
                options={snapshots.map((entry) => ({
                  value: entry.name,
                  label: entry.name,
                }))}
                notFoundContent={
                  loadingSnapshots ? (
                    <Spin size="small" />
                  ) : (
                    "No snapshots found"
                  )
                }
              />
              {selectedSnapshot ? (
                <div
                  style={{
                    marginTop: "8px",
                    color: "#666",
                    fontSize: "12px",
                  }}
                >
                  <span>
                    Snapshot usage: {human_readable_size(selectedSnapshot.used)}
                    {" • "}
                    Exclusive data:{" "}
                    {human_readable_size(selectedSnapshot.exclusive)}
                  </span>
                  {selectedSnapshot.parsedTime ? (
                    <>
                      <br />
                      <span>
                        Created <TimeAgo date={selectedSnapshot.parsedTime} />
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div>
              <div style={{ marginBottom: "6px", color: "#666" }}>
                Restore mode
              </div>
              <Radio.Group
                value={mode}
                onChange={(e) => setMode(e.target.value as SnapshotRestoreMode)}
              >
                <Space orientation="vertical" size="small">
                  {(["both", "home", "rootfs"] as SnapshotRestoreMode[]).map(
                    (value) => (
                      <div key={value}>
                        <Radio value={value}>{MODE_LABEL[value]}</Radio>
                        <div
                          style={{
                            marginLeft: "24px",
                            color: "#666",
                            fontSize: "12px",
                            maxWidth: "620px",
                          }}
                        >
                          {MODE_DESCRIPTION[value]}
                        </div>
                      </div>
                    ),
                  )}
                </Space>
              </Radio.Group>
            </div>
            <div>
              <div style={{ marginBottom: "6px", color: "#666" }}>
                Safety snapshot name
              </div>
              <Input
                allowClear
                value={safetySnapshotName}
                onChange={(e) => setSafetySnapshotName(e.target.value)}
                placeholder="Snapshot created before restore to preserve the current state"
              />
              <div
                style={{ marginTop: "8px", color: "#666", fontSize: "12px" }}
              >
                The current project state is snapshotted first so you can roll
                back if this restore is not what you wanted.
              </div>
            </div>
            <ShowError error={error} setError={setError} />
          </Space>
        </Modal>
      ) : null}
    </>
  );
}
