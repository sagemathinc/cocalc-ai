import { useEffect, useState } from "react";
import { Button, Modal, Spin } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import ShowError from "@cocalc/frontend/components/error";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useTypedRedux } from "@cocalc/frontend/app-framework";

export default function CreateBackup({
  onCreated,
}: {
  onCreated?: () => void;
}) {
  const { actions, project_id } = useProjectContext();
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [limit, setLimit] = useState<number | null>(null);
  const openCreate = useTypedRedux({ project_id }, "open_create_backup");

  useEffect(() => {
    if (!open) return;
    actions?.setState({ disableExplorerKeyhandler: true });
    return () => actions?.setState({ disableExplorerKeyhandler: false });
  }, [open]);

  useEffect(() => {
    if (!openCreate) return;
    setOpen(true);
    actions?.setState({ open_create_backup: false });
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
        const { limit } =
          await webapp_client.conat_client.hub.projects.getBackupQuota({
            project_id,
          });
        if (!canceled) {
          setLimit(limit);
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

  if (!project_id) return null;

  async function createBackup() {
    try {
      setLoading(true);
      setError("");
      const op = await webapp_client.conat_client.hub.projects.createBackup({
        project_id,
      });
      actions?.trackBackupOp(op);
      onCreated?.();
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button disabled={open} onClick={() => setOpen(true)}>
        <Icon name="cloud-upload" /> Create Backup
      </Button>
      {open && (
        <Modal
          title={
            <>
              <Icon name="cloud-upload" /> Create Backup{" "}
              {loading && (
                <Spin style={{ float: "right", marginRight: "15px" }} />
              )}
            </>
          }
          open={open}
          onCancel={() => setOpen(false)}
          footer={[
            <Button key="cancel" onClick={() => setOpen(false)}>
              Cancel
            </Button>,
            <Button
              key="create"
              type="primary"
              onClick={createBackup}
              loading={loading}
            >
              Create Backup
            </Button>,
          ]}
        >
          <p>
            This project can keep up to <b>{limit ?? "..."}</b> backups in
            total. Automatic and manually created backups share the same cap.
          </p>
          <p>
            Backups are archives that include your project files, any software
            you have installed, and TimeTravel edit history, but not the
            contents of /tmp. Backups are state stored separately from project
            hosts. Creating a backup runs in the background and does not
            interrupt your work.
          </p>
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
