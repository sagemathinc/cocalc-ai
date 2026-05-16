/*
The Snapshots button pops up a model that:

 - lets you create a new snapshot
 -

*/

import { useEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import { Alert, Button, Input, Modal, Spin } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import ShowError from "@cocalc/frontend/components/error";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useTypedRedux } from "@cocalc/frontend/app-framework";

export default function CreateSnapshot({
  onCreated,
}: {
  onCreated?: () => void;
}) {
  const { actions, project_id } = useProjectContext();
  const [loading, setLoading] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [limit, setLimit] = useState<number | null>(null);
  const [manualLimit, setManualLimit] = useState<number | null>(null);
  const [manualCurrent, setManualCurrent] = useState<number | null>(null);
  const [rollingReserved, setRollingReserved] = useState<number | null>(null);
  const openCreate = useTypedRedux({ project_id }, "open_create_snapshot");
  const inputRef = useRef<InputRef>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    actions?.setState({ disableExplorerKeyhandler: true });
    return () => {
      actions?.setState({ disableExplorerKeyhandler: false });
    };
  }, [open]);

  useEffect(() => {
    if (!openCreate) return;
    setOpen(true);
    actions?.setState({ open_create_snapshot: false });
  }, [actions, openCreate]);

  useEffect(() => {
    if (!open) {
      setLimit(null);
      return;
    }
    let canceled = false;
    (async () => {
      try {
        setLoading(true);
        const { limit, manual } =
          await webapp_client.conat_client.hub.projects.getSnapshotQuota({
            project_id,
          });
        if (!canceled) {
          setLimit(limit);
          setManualLimit(manual?.limit ?? null);
          setManualCurrent(manual?.current ?? null);
          setRollingReserved(manual?.rolling_reserved ?? null);
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [open, project_id]);

  if (!project_id) {
    return null;
  }

  async function createSnapshot() {
    try {
      setLoading(true);
      setError("");
      if (!name.trim()) {
        throw Error("name must be nonempty");
      }
      await webapp_client.conat_client.hub.projects.createSnapshot({
        project_id,
        name,
      });
      onCreated?.();
      setName("");
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button disabled={open} onClick={() => setOpen(!open)}>
        <Icon name="disk-snapshot" /> Create Snapshot
      </Button>
      {open && (
        <Modal
          afterOpenChange={async (open) => {
            if (!open) return;
            setName(`manual-${new Date().toISOString()}`);
            inputRef.current?.focus({
              cursor: "all",
            });
          }}
          title={
            <>
              <Icon name="disk-snapshot" /> Create Snapshot{" "}
              <Button
                size="small"
                type="text"
                style={{ float: "right", marginRight: "15px" }}
                onClick={() => setShowHelp(!showHelp)}
              >
                Help
              </Button>
              {loading && (
                <Spin style={{ float: "right", marginRight: "15px" }} />
              )}
            </>
          }
          open={open}
          onOk={() => {
            setOpen(false);
          }}
          onCancel={() => {
            setOpen(false);
          }}
          footer={[
            <Button
              key="cancel"
              onClick={() => {
                setOpen(false);
                setName("");
              }}
            >
              Cancel
            </Button>,
            <Button
              key="create"
              type="primary"
              onClick={createSnapshot}
              disabled={
                !name.trim() ||
                (manualLimit != null &&
                  manualCurrent != null &&
                  manualCurrent >= manualLimit)
              }
            >
              Create Snapshot
            </Button>,
          ]}
        >
          <p>
            This project can keep up to <b>{limit ?? "..."}</b> snapshots in
            total. Automatic rolling snapshots reserve{" "}
            <b>{rollingReserved ?? "..."}</b> slots, leaving{" "}
            <b>{manualLimit ?? "..."}</b> named snapshot slots.
          </p>
          {manualLimit != null &&
            manualCurrent != null &&
            manualCurrent >= manualLimit && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 10 }}
                message="Manual snapshot limit reached"
                description="Delete a named snapshot or ask the owner to increase the snapshot limit before creating another named snapshot."
              />
            )}
          {showHelp && (
            <p>
              Create instant lightweight snapshots of the exact state of all
              files in your project. Named snapshots remain until you delete
              them, whereas the default timestamp snapshots are created and
              deleted automatically according to a schedule. Snapshot-retained
              data counts against your project quota, so deleting old snapshots
              can reduce quota usage.
            </p>
          )}
          <Input
            allowClear
            ref={inputRef}
            style={{ flex: 1, width: "100%", marginTop: "5px" }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name of snapshot to create..."
            onPressEnter={() => {
              if (name.trim()) {
                createSnapshot();
              }
            }}
          />
          <ShowError
            style={{ marginTop: "10px" }}
            error={error}
            setError={setError}
          />
        </Modal>
      )}
    </>
  );
}
