import { useEffect, useState } from "react";
import { Alert, Button, Flex, InputNumber, Modal, Spin, Switch } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import ShowError from "@cocalc/frontend/components/error";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { publishProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import {
  DEFAULT_SNAPSHOT_COUNTS,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export default function EditSchedule() {
  const { actions, project_id } = useProjectContext();
  const [loading, setLoading] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const openSchedule = useTypedRedux({ project_id }, "open_snapshot_schedule");
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const project = useTypedRedux("projects", "project_map")?.get(project_id);
  const [schedule0, setSchedule] = useState<SnapshotSchedule | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const canEditSchedule =
    isAdmin ||
    project?.getIn(["users", account_id, "group"]) === "owner" ||
    project?.get("allow_collaborator_destructive_storage_actions") === true;

  async function loadSchedule(): Promise<SnapshotSchedule> {
    const counts =
      await webapp_client.conat_client.hub.projects.getProjectSnapshotSchedule({
        project_id,
      });
    return {
      ...DEFAULT_SNAPSHOT_COUNTS,
      ...(counts ?? {}),
    };
  }

  async function openModal(): Promise<void> {
    try {
      setLoading(true);
      setError("");
      const [schedule, quota] = await Promise.all([
        loadSchedule(),
        webapp_client.conat_client.hub.projects.getSnapshotQuota({
          project_id,
        }),
      ]);
      setSchedule(schedule);
      setLimit(quota.limit);
      setOpen(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

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
    if (!openSchedule) return;
    void openModal().finally(() =>
      actions?.setState({ open_snapshot_schedule: false }),
    );
  }, [actions, openSchedule, project_id]);

  const schedule: SnapshotSchedule = schedule0 ?? {
    ...DEFAULT_SNAPSHOT_COUNTS,
  };
  const total = schedule.disabled
    ? 0
    : (schedule.frequent ?? 0) +
      (schedule.daily ?? 0) +
      (schedule.weekly ?? 0) +
      (schedule.monthly ?? 0);
  const overLimit = limit != null && total > limit;
  async function saveSchedule() {
    try {
      setLoading(true);
      setError("");
      if (!canEditSchedule) {
        throw new Error(
          "Only project owners can change snapshot schedules unless the owner allows collaborators to manage storage history.",
        );
      }
      if (overLimit) {
        throw new Error(
          `automatic snapshots total ${total} exceeds project limit ${limit}`,
        );
      }
      await webapp_client.query_client.query({
        query: {
          projects: { project_id, snapshots: schedule },
        },
      });
      publishProjectDetailInvalidation({
        project_id,
        fields: ["snapshots"],
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
              <Icon name="clock" /> Automatic Snapshots:{" "}
              <Switch
                style={{ marginRight: "15px" }}
                checkedChildren="Enabled"
                unCheckedChildren="Disabled"
                checked={!schedule?.disabled}
                disabled={!canEditSchedule || loading}
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
          onCancel={() => {
            setOpen(false);
          }}
          footer={[
            <Button
              key="cancel"
              onClick={() => {
                setOpen(false);
              }}
            >
              {canEditSchedule ? "Cancel" : "Close"}
            </Button>,
            ...(canEditSchedule
              ? [
                  <Button
                    disabled={loading}
                    key="create"
                    type="primary"
                    onClick={saveSchedule}
                  >
                    Save
                  </Button>,
                ]
              : []),
          ]}
        >
          {!canEditSchedule ? (
            <Alert
              showIcon
              type="info"
              style={{ marginBottom: "15px" }}
              message="Schedule is read-only"
              description="Only project owners can change automatic snapshot schedules unless the owner allows collaborators to manage storage history."
            />
          ) : undefined}
          {showHelp && (
            <p>
              Projects have rolling instant lightweight automatic snapshots of
              the exact state of your files, which are created when you are
              actively using your project. The parameters listed below determine
              how many of each timestamped snapshot is retained. Explicitly
              named snapshots that you manually create are not automatically
              deleted, but they do count against the same per-project snapshot
              cap.
            </p>
          )}
          {limit != null && (
            <p>
              This project can keep at most <b>{limit}</b> snapshots total.
              Current automatic schedule total: <b>{total}</b>.
            </p>
          )}

          {!schedule?.disabled && (
            <div style={{ marginBottom: "15px" }}>
              <Flex style={{ marginBottom: "5px" }}>
                <div style={{ flex: 0.5 }}>Every 15 minutes</div>
                <InputNumber
                  suffix="snapshots"
                  precision={0}
                  style={{ flex: 0.5 }}
                  step={1}
                  min={0}
                  max={limit ?? undefined}
                  disabled={!canEditSchedule || loading}
                  value={schedule.frequent ?? DEFAULT_SNAPSHOT_COUNTS.frequent}
                  onChange={(frequent) => {
                    if (frequent != null) {
                      setSchedule({
                        ...schedule,
                        frequent,
                      });
                    }
                  }}
                />
              </Flex>
              <Flex style={{ marginBottom: "5px" }}>
                <div style={{ flex: 0.5 }}>Daily</div>
                <InputNumber
                  suffix="snapshots"
                  style={{ flex: 0.5 }}
                  step={1}
                  min={0}
                  max={limit ?? undefined}
                  disabled={!canEditSchedule || loading}
                  value={schedule.daily ?? DEFAULT_SNAPSHOT_COUNTS.daily}
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
                  suffix="snapshots"
                  style={{ flex: 0.5 }}
                  step={1}
                  min={0}
                  max={limit ?? undefined}
                  disabled={!canEditSchedule || loading}
                  value={schedule.weekly ?? DEFAULT_SNAPSHOT_COUNTS.weekly}
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
              <Flex>
                <div style={{ flex: 0.5 }}>Monthly</div>
                <InputNumber
                  suffix="snapshots"
                  style={{ flex: 0.5 }}
                  step={1}
                  min={0}
                  max={limit ?? undefined}
                  disabled={!canEditSchedule || loading}
                  value={schedule.monthly ?? DEFAULT_SNAPSHOT_COUNTS.monthly}
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
            error={
              !error && overLimit
                ? `automatic snapshots total ${total} exceeds project limit ${limit}`
                : error
            }
            setError={setError}
          />
        </Modal>
      )}
    </>
  );
}
