import { useEffect, useState } from "react";
import { Button, Flex, InputNumber, Modal, Spin, Switch } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import ShowError from "@cocalc/frontend/components/error";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { publishProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import {
  DEFAULT_BACKUP_COUNTS,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const MAX = 50;

export default function EditBackupSchedule() {
  const { actions, project_id } = useProjectContext();
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const openSchedule = useTypedRedux({ project_id }, "open_backup_schedule");
  const [schedule0, setSchedule] = useState<SnapshotSchedule | null>(null);

  async function loadSchedule(): Promise<SnapshotSchedule> {
    const counts =
      await webapp_client.conat_client.hub.projects.getProjectBackupSchedule({
        project_id,
      });
    return {
      ...DEFAULT_BACKUP_COUNTS,
      ...(counts ?? {}),
      frequent: 0,
    };
  }

  async function openModal(): Promise<void> {
    try {
      setLoading(true);
      setError("");
      setSchedule(await loadSchedule());
      setOpen(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    actions?.setState({ disableExplorerKeyhandler: true });
    return () => actions?.setState({ disableExplorerKeyhandler: false });
  }, [open]);

  useEffect(() => {
    if (!openSchedule) return;
    void openModal().finally(() =>
      actions?.setState({ open_backup_schedule: false }),
    );
  }, [actions, openSchedule, project_id]);

  const schedule = schedule0!;

  async function saveSchedule() {
    try {
      setLoading(true);
      setError("");
      await webapp_client.query_client.query({
        query: {
          projects: { project_id, backups: { ...schedule, frequent: 0 } },
        },
      });
      publishProjectDetailInvalidation({
        project_id,
        fields: ["backups"],
      });
      setSchedule(schedule);
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button disabled={open || loading} onClick={() => void openModal()}>
        <Icon name="clock" /> Schedule
      </Button>
      {open && (
        <Modal
          title={
            <div style={{ marginBottom: "30px" }}>
              <Icon name="clock" /> Automatic Backups:{" "}
              <Switch
                style={{ marginRight: "15px" }}
                checkedChildren="Enabled"
                unCheckedChildren="Disabled"
                checked={!schedule?.disabled}
                onChange={(enabled) =>
                  setSchedule({ ...schedule, disabled: !enabled })
                }
              />
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
            </div>
          }
          open={open}
          onCancel={() => setOpen(false)}
          footer={[
            <Button key="cancel" onClick={() => setOpen(false)}>
              Cancel
            </Button>,
            <Button
              disabled={loading}
              key="save"
              type="primary"
              onClick={saveSchedule}
            >
              Save
            </Button>,
          ]}
        >
          {showHelp && (
            <p>
              Backups run automatically while you actively use the project.
              These settings control how many daily, weekly, and monthly backups
              are retained. Backups are deduplicated and stored outside the
              project host, so they remain available even if the host changes.
            </p>
          )}

          {!schedule?.disabled && (
            <div style={{ marginBottom: "15px" }}>
              <Flex style={{ marginBottom: "5px" }}>
                <div style={{ flex: 0.5 }}>Daily</div>
                <InputNumber
                  suffix="backups"
                  style={{ flex: 0.5 }}
                  step={1}
                  min={0}
                  max={MAX}
                  defaultValue={schedule.daily ?? DEFAULT_BACKUP_COUNTS.daily}
                  onChange={(daily) => {
                    if (daily != null) {
                      setSchedule({
                        ...schedule,
                        daily,
                      });
                    }
                  }}
                />
              </Flex>
              <Flex style={{ marginBottom: "5px" }}>
                <div style={{ flex: 0.5 }}>Weekly</div>
                <InputNumber
                  suffix="backups"
                  style={{ flex: 0.5 }}
                  step={1}
                  min={0}
                  max={MAX}
                  defaultValue={schedule.weekly ?? DEFAULT_BACKUP_COUNTS.weekly}
                  onChange={(weekly) => {
                    if (weekly != null) {
                      setSchedule({
                        ...schedule,
                        weekly,
                      });
                    }
                  }}
                />
              </Flex>
              <Flex style={{ marginBottom: "5px" }}>
                <div style={{ flex: 0.5 }}>Monthly</div>
                <InputNumber
                  suffix="backups"
                  style={{ flex: 0.5 }}
                  step={1}
                  min={0}
                  max={MAX}
                  defaultValue={
                    schedule.monthly ?? DEFAULT_BACKUP_COUNTS.monthly
                  }
                  onChange={(monthly) => {
                    if (monthly != null) {
                      setSchedule({
                        ...schedule,
                        monthly,
                      });
                    }
                  }}
                />
              </Flex>
            </div>
          )}

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
