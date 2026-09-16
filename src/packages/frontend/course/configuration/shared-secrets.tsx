/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect } from "react";

import type {
  CourseSecretPolicyState,
  CourseSecretRecipientPreview,
  CourseSecretSyncRun,
  ProjectSecretMetadata,
} from "@cocalc/conat/hub/api/projects";
import {
  FreshAuthModal,
  isFreshAuthRequiredError,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { useMemo, useRedux, useState } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { revealDocsAction } from "@cocalc/frontend/project/docs-actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { CourseActions } from "../actions";
import type { CourseSettingsRecord, StudentsMap } from "../store";
import { selectableRecipientIds } from "./shared-secrets-selection";

interface Props {
  actions: CourseActions;
  name: string;
  project_id: string;
  settings: CourseSettingsRecord;
}

function activeGrantNames(state: CourseSecretPolicyState | null): string[] {
  return (
    state?.grants
      .filter(({ enabled, revoked_at }) => enabled && revoked_at == null)
      .map(({ name }) => name) ?? []
  );
}

export function SharedSecrets({ actions, name, project_id, settings }: Props) {
  const students = useRedux(name, "students") as StudentsMap | undefined;
  const coursePath = useRedux(name, "course_filename") as string | undefined;
  const courseId = `${settings.get("course_id") ?? ""}`.trim();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const [shareable, setShareable] = useState<ProjectSecretMetadata[]>([]);
  const [policyState, setPolicyState] =
    useState<CourseSecretPolicyState | null>(null);
  const [preview, setPreview] = useState<CourseSecretRecipientPreview[]>([]);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [lastRun, setLastRun] = useState<CourseSecretSyncRun | null>(null);
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const roster = useMemo(() => {
    const rows: Array<{
      project_id: string;
      account_id?: string;
      label: string;
    }> = [];
    if (students) {
      for (const [, student] of students) {
        const studentProjectId = student.get("project_id");
        if (!studentProjectId || student.get("deleted")) continue;
        const label =
          student.get("display_name") ||
          [student.get("first_name"), student.get("last_name")]
            .filter(Boolean)
            .join(" ") ||
          student.get("email_address") ||
          studentProjectId;
        rows.push({
          project_id: studentProjectId,
          account_id: student.get("account_id"),
          label,
        });
      }
    }
    return rows;
  }, [students]);
  const rosterByProject = useMemo(
    () => new Map(roster.map((item) => [item.project_id, item])),
    [roster],
  );
  const rosterKey = roster.map(({ project_id }) => project_id).join(",");

  useEffect(() => {
    if (courseId) return;
    actions.ensure_course_id();
  }, [actions, courseId]);

  const refresh = useCallback(async () => {
    if (!courseId || !coursePath) return;
    setError("");
    try {
      const [eligible, state] = await Promise.all([
        webapp_client.conat_client.hub.projects.listCourseShareableSecrets({
          course_project_id: project_id,
        }),
        webapp_client.conat_client.hub.projects.getCourseSecretPolicy({
          course_project_id: project_id,
          course_id: courseId,
          course_path: coursePath,
        }),
      ]);
      const targetIds = Array.from(
        new Set([
          ...roster.map(({ project_id }) => project_id),
          ...(state?.recipients.map(
            ({ target_project_id }) => target_project_id,
          ) ?? []),
        ]),
      );
      const syncPreview =
        await webapp_client.conat_client.hub.projects.previewCourseSecretSync({
          course_project_id: project_id,
          course_id: courseId,
          course_path: coursePath,
          target_project_ids: targetIds,
        });
      setShareable(eligible);
      setPolicyState(state);
      setPreview(syncPreview.recipients);
      setSelectedNames(activeGrantNames(state));
      setSelectedRecipients((current) =>
        current.filter((target) =>
          syncPreview.recipients.some(
            (item) => item.target_project_id === target && !item.approved,
          ),
        ),
      );
    } catch (err) {
      setError(`${err}`);
    }
  }, [courseId, coursePath, project_id, rosterKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!lastRun || !["pending", "running"].includes(lastRun.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const status =
          await webapp_client.conat_client.hub.projects.getCourseSecretSyncStatus(
            {
              course_project_id: project_id,
              course_id: courseId,
              run_id: lastRun.run_id,
            },
          );
        if (status) setLastRun(status.run);
      } catch (err) {
        setError(`${err}`);
      }
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [courseId, lastRun, project_id]);

  async function mutate(action: () => Promise<void>): Promise<void> {
    await runFreshAuthAction(async () => {
      setBusy(true);
      setError("");
      try {
        await action();
        await refresh();
      } catch (err) {
        if (isFreshAuthRequiredError(err)) throw err;
        setError(`${err}`);
      } finally {
        setBusy(false);
      }
    });
  }

  async function openProjectSecrets(): Promise<void> {
    setError("");
    try {
      await revealDocsAction({
        actionId: "settings.environment.secrets",
        projectId: project_id,
      });
    } catch (err) {
      setError(`${err}`);
    }
  }

  const identity = {
    browser_id: webapp_client.browser_id,
    course_project_id: project_id,
    course_id: courseId,
    course_path: coursePath ?? "",
  };
  const activeRecipients =
    policyState?.recipients.filter(({ revoked_at }) => revoked_at == null) ??
    [];
  const enabled = policyState?.policy.enabled === true;
  const revoked = policyState?.policy.revoked_at != null;
  const cleanupRecipients = policyState?.recipients ?? [];
  const selectableRecipients = useMemo(
    () => selectableRecipientIds(preview),
    [preview],
  );
  const selectableRecipientSet = useMemo(
    () => new Set(selectableRecipients),
    [selectableRecipients],
  );
  const selectedRecipientCount = selectedRecipients.filter((projectId) =>
    selectableRecipientSet.has(projectId),
  ).length;

  async function approveSelectedRecipients(): Promise<void> {
    const recipientIds = selectedRecipients.filter((projectId) =>
      selectableRecipientSet.has(projectId),
    );
    if (recipientIds.length === 0) return;
    await mutate(async () => {
      await webapp_client.conat_client.hub.projects.approveCourseSecretRecipients(
        {
          ...identity,
          browser_id: webapp_client.browser_id,
          recipients: recipientIds.map((target_project_id) => ({
            target_project_id,
            student_account_id:
              rosterByProject.get(target_project_id)?.account_id,
          })),
        },
      );
      setSelectedRecipients([]);
    });
  }

  return (
    <Card
      title={
        <>
          <Icon name="key" /> Shared Secrets
        </>
      }
    >
      <Space vertical size="middle" style={{ width: "100%" }}>
        <Alert
          showIcon
          type="warning"
          title="Students can read and extract every shared secret. Use dedicated, limited provider keys."
          description="Nothing is shared when this course opens or during ordinary course reconfiguration. Source secrets, recipients, and each synchronization require explicit actions."
        />
        <Button
          data-cocalc-docs-action="settings.environment.secrets"
          icon={<Icon name="key" />}
          onClick={() => void openProjectSecrets()}
        >
          Manage Project Secrets
        </Button>
        {error ? <Alert showIcon type="error" title={error} /> : undefined}
        {revoked ? (
          <Alert
            showIcon
            type="warning"
            title="This sharing policy is revoked."
            description="No further distribution is allowed. Managed copies can still be removed with the cleanup action below."
          />
        ) : undefined}
        <Typography.Text type="secondary">
          Course identity: <Typography.Text code>{courseId}</Typography.Text>
        </Typography.Text>

        <div>
          <Typography.Text strong>Secrets eligible for sharing</Typography.Text>
          <div style={{ marginTop: 8 }}>
            {shareable.length ? (
              <Space vertical>
                {shareable.map((secret) => (
                  <Checkbox
                    key={secret.name}
                    checked={selectedNames.includes(secret.name)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelectedNames((current) =>
                        event.target.checked
                          ? [...new Set([...current, secret.name])]
                          : current.filter((name) => name !== secret.name),
                      )
                    }
                  >
                    <Typography.Text code>{secret.name}</Typography.Text>
                  </Checkbox>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                No source secret is marked for course sharing. Enable that
                explicitly in this project&apos;s Secrets settings.
              </Typography.Text>
            )}
          </div>
          <Button
            style={{ marginTop: 8 }}
            disabled={busy || !courseId || revoked}
            onClick={() =>
              void mutate(async () => {
                const state =
                  await webapp_client.conat_client.hub.projects.setCourseSecretGrants(
                    {
                      ...identity,
                      browser_id: webapp_client.browser_id,
                      names: selectedNames,
                    },
                  );
                setPolicyState(state);
              })
            }
          >
            Save Selected Secrets
          </Button>
        </div>

        <div>
          <Typography.Text strong>Recipients</Typography.Text>
          <br />
          <Button
            style={{ marginTop: 8 }}
            onClick={() => setRecipientsOpen(true)}
          >
            Manage Recipients ({activeRecipients.length} approved,{" "}
            {selectableRecipients.length} eligible)
          </Button>
        </div>

        <Space wrap>
          <Button
            disabled={busy || !policyState || revoked}
            onClick={() =>
              void mutate(async () => {
                const state =
                  await webapp_client.conat_client.hub.projects.setCourseSecretPolicy(
                    {
                      ...identity,
                      browser_id: webapp_client.browser_id,
                      enabled: !enabled,
                    },
                  );
                setPolicyState(state);
              })
            }
          >
            {enabled ? "Disable Sharing" : "Enable Sharing"}
          </Button>
          <Popconfirm
            title={`Share ${activeGrantNames(policyState).length} secret(s) with ${activeRecipients.length} approved project(s)? Students can extract these values.`}
            okText="Share Now"
            onConfirm={() =>
              mutate(async () => {
                const run =
                  await webapp_client.conat_client.hub.projects.startCourseSecretSync(
                    {
                      ...identity,
                      browser_id: webapp_client.browser_id,
                    },
                  );
                setLastRun(run);
              })
            }
          >
            <Button
              type="primary"
              disabled={
                busy ||
                !enabled ||
                activeGrantNames(policyState).length === 0 ||
                activeRecipients.length === 0
              }
            >
              Share Now
            </Button>
          </Popconfirm>
          <Popconfirm
            title="Remove secrets managed by this course policy from all current and former approved recipient projects?"
            okText="Remove Copies"
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              mutate(async () => {
                const run =
                  await webapp_client.conat_client.hub.projects.startCourseSecretCleanup(
                    {
                      ...identity,
                      browser_id: webapp_client.browser_id,
                    },
                  );
                setLastRun(run);
              })
            }
          >
            <Button
              danger
              disabled={busy || !policyState || cleanupRecipients.length === 0}
            >
              Remove Managed Copies
            </Button>
          </Popconfirm>
          <Popconfirm
            title="Permanently revoke this sharing policy? Remove managed copies first if desired."
            okText="Revoke Policy"
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              mutate(async () => {
                await webapp_client.conat_client.hub.projects.revokeCourseSecretPolicy(
                  {
                    ...identity,
                    browser_id: webapp_client.browser_id,
                  },
                );
              })
            }
          >
            <Button danger disabled={busy || !policyState || revoked}>
              Revoke Policy
            </Button>
          </Popconfirm>
          <Button disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        </Space>
        {lastRun ? (
          <Alert
            showIcon
            type={
              lastRun.status === "completed"
                ? "success"
                : lastRun.status === "failed"
                  ? "error"
                  : lastRun.status === "partial"
                    ? "warning"
                    : "info"
            }
            title={`Secret ${lastRun.mode}: ${lastRun.status}`}
            description={`Copied/removed ${lastRun.copied_count}; unchanged ${lastRun.unchanged_count}; conflicts ${lastRun.conflict_count}; skipped ${lastRun.skipped_count}; failed ${lastRun.failed_count}.`}
          />
        ) : undefined}
        <Modal
          destroyOnHidden
          footer={
            <Space>
              <Button onClick={() => setRecipientsOpen(false)}>Done</Button>
              <Button
                type="primary"
                disabled={busy || revoked || selectedRecipientCount === 0}
                onClick={() => void approveSelectedRecipients()}
              >
                Approve {selectedRecipientCount} Selected
              </Button>
            </Space>
          }
          onCancel={() => setRecipientsOpen(false)}
          open={recipientsOpen}
          title="Secret Recipients"
          width={860}
        >
          <Space vertical size="middle" style={{ width: "100%" }}>
            <Space wrap>
              <Button
                disabled={
                  busy ||
                  revoked ||
                  selectableRecipients.length === 0 ||
                  selectedRecipientCount === selectableRecipients.length
                }
                onClick={() => setSelectedRecipients([...selectableRecipients])}
              >
                Select All Eligible
              </Button>
              <Button
                disabled={busy || selectedRecipientCount === 0}
                onClick={() => setSelectedRecipients([])}
              >
                Clear Selection
              </Button>
              <Typography.Text type="secondary">
                {activeRecipients.length} approved;{" "}
                {selectableRecipients.length} eligible; {selectedRecipientCount}{" "}
                selected
              </Typography.Text>
            </Space>
            <div
              style={{
                maxHeight: "60vh",
                overflowY: "auto",
                paddingRight: 8,
              }}
            >
              <Space vertical size={6} style={{ display: "flex" }}>
                {preview.length ? (
                  preview.map((item) => {
                    const row = rosterByProject.get(item.target_project_id);
                    return (
                      <div
                        key={item.target_project_id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(180px, 1fr) auto auto",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <Typography.Text>
                            {row?.label ?? "Former recipient"}
                          </Typography.Text>
                          <br />
                          <Typography.Text type="secondary" code>
                            {item.target_project_id}
                          </Typography.Text>
                        </div>
                        {item.approved ? (
                          <Tag
                            color={
                              item.reason === "eligible" ? "green" : "orange"
                            }
                          >
                            {item.reason === "eligible"
                              ? "Approved"
                              : item.reason}
                          </Tag>
                        ) : (
                          <Checkbox
                            disabled={
                              busy || revoked || item.reason !== "not_approved"
                            }
                            checked={selectedRecipients.includes(
                              item.target_project_id,
                            )}
                            onChange={(event) =>
                              setSelectedRecipients((current) =>
                                event.target.checked
                                  ? [
                                      ...new Set([
                                        ...current,
                                        item.target_project_id,
                                      ]),
                                    ]
                                  : current.filter(
                                      (id) => id !== item.target_project_id,
                                    ),
                              )
                            }
                          >
                            Approve
                          </Checkbox>
                        )}
                        {item.approved ? (
                          <Popconfirm
                            title="Revoke this recipient? Existing copies remain until cleanup."
                            onConfirm={() =>
                              mutate(async () => {
                                await webapp_client.conat_client.hub.projects.revokeCourseSecretRecipients(
                                  {
                                    ...identity,
                                    browser_id: webapp_client.browser_id,
                                    target_project_ids: [
                                      item.target_project_id,
                                    ],
                                  },
                                );
                              })
                            }
                          >
                            <Button size="small" danger disabled={busy}>
                              Revoke
                            </Button>
                          </Popconfirm>
                        ) : (
                          <Typography.Text type="secondary">
                            {item.reason === "not_approved"
                              ? "Eligible"
                              : item.reason}
                          </Typography.Text>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <Typography.Text type="secondary">
                    No student projects are available.
                  </Typography.Text>
                )}
              </Space>
            </div>
          </Space>
        </Modal>
        <FreshAuthModal {...freshAuthModalProps} />
      </Space>
    </Card>
  );
}
