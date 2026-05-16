/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  List,
  Popconfirm,
  Popover,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";

import type { ProjectRuntimeSponsorStatus } from "@cocalc/conat/hub/api/projects";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import {
  accountIsProjectCollaborator,
  projectOwnerAccountId,
  runtimeSponsorAccountId,
} from "@cocalc/frontend/projects/runtime-start-policy";
import { User } from "@cocalc/frontend/users/user";
import { COLORS } from "@cocalc/util/theme";

import type { Project } from "./types";

const { Text } = Typography;

const ROW_STYLE: CSSProperties = {
  alignItems: "center",
  background: COLORS.GRAY_LLL,
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 8,
  display: "grid",
  gap: 12,
  gridTemplateColumns: "minmax(0, 1fr) auto",
  padding: "10px 12px",
};

const ROW_TITLE_STYLE: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 7,
  marginBottom: 2,
};

function DetailsLink({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover
      title={title}
      content={<div style={{ maxWidth: 380 }}>{children}</div>}
      trigger="click"
    >
      <Button type="link" size="small" style={{ height: "auto", padding: 0 }}>
        Details
      </Button>
    </Popover>
  );
}

function SponsorRow({
  icon,
  title,
  summary,
  details,
  action,
  extra,
}: {
  icon: ReactNode;
  title: ReactNode;
  summary: ReactNode;
  details?: ReactNode;
  action?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div style={ROW_STYLE}>
      <div style={{ minWidth: 0 }}>
        <div style={ROW_TITLE_STYLE}>
          {icon}
          <Text strong>{title}</Text>
        </div>
        <Space size={6} wrap>
          <Text type="secondary">{summary}</Text>
          {details && <DetailsLink title={title}>{details}</DetailsLink>}
        </Space>
        {extra}
      </div>
      {action && <div style={{ justifySelf: "end" }}>{action}</div>}
    </div>
  );
}

interface Props {
  project: Project;
  project_id: string;
}

export function RuntimeSponsorControls({ project, project_id }: Props) {
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const [saving, setSaving] = useState(false);
  const [savingAutostart, setSavingAutostart] = useState(false);
  const [savingStorageHistory, setSavingStorageHistory] = useState(false);
  const [changingSponsor, setChangingSponsor] = useState(false);
  const [revertingSponsor, setRevertingSponsor] = useState(false);
  const [error, setError] = useState("");
  const sponsorAccountId = runtimeSponsorAccountId(project);
  const ownerAccountId = projectOwnerAccountId(project);
  const isOwner = account_id === ownerAccountId;
  const isSponsor = !!account_id && account_id === sponsorAccountId;
  const isCollaborator = accountIsProjectCollaborator(project, account_id);
  const canEdit = isAdmin || isOwner || isSponsor;
  const canEditAutostart = isAdmin || isOwner;
  const canEditStorageHistory = isAdmin || isOwner;
  const canSelfSponsor = isCollaborator && !isSponsor;
  const canStopSponsoring = isSponsor && !isOwner && !!ownerAccountId;
  const checked =
    project.get("allow_collaborator_starts_using_sponsor") !== false;
  const autostartChecked = project.get("autostart_enabled") !== false;
  const storageHistoryChecked =
    project.get("allow_collaborator_destructive_storage_actions") === true;

  async function setAllowCollaboratorStarts(value: boolean) {
    setError("");
    setSaving(true);
    try {
      await redux
        .getActions("projects")
        .set_project_allow_collaborator_starts_using_sponsor(project_id, value);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function useMyMembership() {
    setError("");
    setChangingSponsor(true);
    try {
      await redux
        .getActions("projects")
        .set_project_runtime_sponsor_to_me(project_id);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setChangingSponsor(false);
    }
  }

  async function stopSponsoring() {
    setError("");
    setRevertingSponsor(true);
    try {
      if (!ownerAccountId) {
        throw Error("Project owner account id is not available.");
      }
      await redux
        .getActions("projects")
        .set_project_runtime_sponsor_to_owner(project_id, ownerAccountId);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRevertingSponsor(false);
    }
  }

  async function setAutostartEnabled(value: boolean) {
    setError("");
    setSavingAutostart(true);
    try {
      await redux
        .getActions("projects")
        .set_project_autostart_enabled(project_id, value);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSavingAutostart(false);
    }
  }

  async function setAllowCollaboratorDestructiveStorageActions(value: boolean) {
    setError("");
    setSavingStorageHistory(true);
    try {
      await redux
        .getActions("projects")
        .set_project_allow_collaborator_destructive_storage_actions(
          project_id,
          value,
        );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSavingStorageHistory(false);
    }
  }

  const sponsor = sponsorAccountId ? (
    <>
      <User account_id={sponsorAccountId} show_avatar avatarSize={18} />
      {"'s"}
    </>
  ) : (
    "the project owner's"
  );

  const sponsorAction = canSelfSponsor ? (
    <Popconfirm
      title="Use your membership as runtime sponsor?"
      description="Future starts of this project will use your simultaneous running-project slots instead of the current sponsor's slots."
      okText="Use my membership"
      cancelText="Cancel"
      onConfirm={useMyMembership}
    >
      <Button size="small" loading={changingSponsor}>
        Use mine
      </Button>
    </Popconfirm>
  ) : canStopSponsoring ? (
    <Popconfirm
      title="Stop sponsoring this project?"
      description="Future starts will use the project owner's membership again. This does not stop the project if it is already running."
      okText="Stop sponsoring"
      cancelText="Cancel"
      onConfirm={stopSponsoring}
    >
      <Button size="small" loading={revertingSponsor}>
        Stop
      </Button>
    </Popconfirm>
  ) : undefined;

  return (
    <section>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <SponsorRow
          icon={<Icon name="user" style={{ color: COLORS.BS_BLUE_TEXT }} />}
          title="Sponsor"
          summary={<>Starts use {sponsor} membership.</>}
          details="The sponsor's simultaneous running-project limit, shared-compute priority, and RAM limits apply while this project is running."
          action={sponsorAction}
          extra={
            <RuntimeSponsorUsageSummary
              project_id={project_id}
              refreshKey={`${sponsorAccountId ?? ""}:${checked}:${autostartChecked}`}
              compact
            />
          }
        />
        <SponsorRow
          icon={<Icon name="users" style={{ color: COLORS.BS_GREEN_D }} />}
          title="Collaborator starts"
          summary={
            checked
              ? "Collaborators may consume sponsor running-project slots."
              : "Collaborators cannot consume sponsor running-project slots."
          }
          details="Project owners, the runtime sponsor, and administrators can still start the project when this is off. A collaborator can also make themself the runtime sponsor explicitly."
          action={
            <Switch
              checked={checked}
              loading={saving}
              disabled={!canEdit}
              checkedChildren="Allowed"
              unCheckedChildren="Blocked"
              onChange={setAllowCollaboratorStarts}
            />
          }
        />
        <SponsorRow
          icon={<Icon name="play" style={{ color: COLORS.BG_WARNING }} />}
          title="Automatic starts"
          summary={
            autostartChecked
              ? "SSH, HTTP/app access, terminals, Jupyter, and agents can wake the project."
              : "Only explicit Start actions can wake the project."
          }
          details="Automatic starts still use the runtime sponsor's simultaneous running-project slots. They never stop another project to make room."
          action={
            <Switch
              checked={autostartChecked}
              loading={savingAutostart}
              disabled={!canEditAutostart}
              checkedChildren="Allowed"
              unCheckedChildren="Blocked"
              onChange={setAutostartEnabled}
            />
          }
        />
        <SponsorRow
          icon={<Icon name="history" style={{ color: COLORS.BS_RED }} />}
          title="Storage history"
          summary={
            storageHistoryChecked
              ? "Collaborators may delete recovery history and move or archive the project."
              : "Only owners can delete recovery history or move/archive the project."
          }
          details="Collaborators can still edit and delete ordinary files. This protects snapshots, backups, archive, and move actions because those can remove recovery history."
          action={
            <Switch
              checked={storageHistoryChecked}
              loading={savingStorageHistory}
              disabled={!canEditStorageHistory}
              checkedChildren="Allowed"
              unCheckedChildren="Owner only"
              onChange={setAllowCollaboratorDestructiveStorageActions}
            />
          }
        />
      </Space>
      {!canEdit && (
        <Alert
          style={{ marginTop: 10 }}
          type="info"
          showIcon
          message="Only project owners, the runtime sponsor, and administrators can change this setting."
        />
      )}
      {canEdit && (!canEditAutostart || !canEditStorageHistory) && (
        <Alert
          style={{ marginTop: 10 }}
          type="info"
          showIcon
          message="Only project owners and administrators can change automatic start and storage-history settings."
        />
      )}
      {error && (
        <Alert
          style={{ marginTop: 10 }}
          type="error"
          showIcon
          message="Unable to save runtime start policy"
          description={error}
        />
      )}
    </section>
  );
}

export function RuntimeSponsorUsageSummary({
  project_id,
  refreshKey,
  compact = false,
}: {
  project_id: string;
  refreshKey?: string;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<ProjectRuntimeSponsorStatus | null>(
    null,
  );
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    setError("");
    void (async () => {
      try {
        const { webapp_client } =
          await import("@cocalc/frontend/webapp-client");
        const status =
          await webapp_client.conat_client.hub.projects.getProjectRuntimeSponsorStatus(
            { project_id },
          );
        if (mounted) setStatus(status);
      } catch (err) {
        if (mounted) setError(`${err}`);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [project_id, refreshKey]);

  if (error) {
    return compact ? null : (
      <Alert
        type="warning"
        showIcon
        message="Unable to load runtime sponsor usage"
        description={error}
      />
    );
  }
  if (status == null) return null;

  const limit = status.limit ?? undefined;
  const hiddenCount = status.active_projects.filter(
    (project) => project.visible === false,
  ).length;
  const visibleProjects = status.active_projects.filter(
    (project) => project.visible !== false,
  );
  const full = limit != null && status.current >= limit;

  if (compact) {
    return (
      <Space size={[4, 4]} wrap style={{ marginTop: 6 }}>
        <Tag color={full ? "orange" : "blue"} style={{ marginInlineEnd: 0 }}>
          {status.current}/{limit ?? "unlimited"} slots
        </Tag>
        {!status.allow_collaborator_starts_using_sponsor && (
          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
            collaborator starts blocked
          </Tag>
        )}
        {!status.autostart_enabled && (
          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
            automatic starts blocked
          </Tag>
        )}
        {hiddenCount > 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {hiddenCount} hidden
          </Text>
        )}
      </Space>
    );
  }

  return (
    <div>
      <Alert
        type={full ? "warning" : "info"}
        showIcon
        message={
          <span>
            Runtime sponsor usage:{" "}
            <Text strong>
              {status.current}/{limit ?? "unlimited"}
            </Text>{" "}
            sponsored running-project slots
          </span>
        }
        description={
          <div>
            <div>
              Sponsor:{" "}
              <User
                account_id={status.sponsor_account_id}
                show_avatar
                avatarSize={18}
              />
              {!status.allow_collaborator_starts_using_sponsor && (
                <Tag color="orange" style={{ marginLeft: 8 }}>
                  collaborator starts blocked
                </Tag>
              )}
              {!status.autostart_enabled && (
                <Tag color="orange" style={{ marginLeft: 8 }}>
                  automatic starts blocked
                </Tag>
              )}
            </div>
            {visibleProjects.length > 0 && (
              <List
                size="small"
                style={{ marginTop: 8 }}
                dataSource={visibleProjects}
                renderItem={(project) => (
                  <List.Item>
                    <Space>
                      <Tag>{project.state}</Tag>
                      <Text>
                        {`${project.title ?? ""}`.trim() || project.project_id}
                      </Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
            {hiddenCount > 0 && (
              <div style={{ color: COLORS.GRAY_M, marginTop: 4 }}>
                {hiddenCount} sponsored running{" "}
                {hiddenCount === 1 ? "project is" : "projects are"} hidden
                because you are not a collaborator.
              </div>
            )}
          </div>
        }
      />
    </div>
  );
}

export function CourseRuntimeSponsorSummary({
  project_id,
}: {
  project_id: string;
}) {
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={10}>
      <Alert
        type="info"
        showIcon
        message="Course runtime sponsorship"
        description="Course projects run on the runtime sponsor's membership. For teaching, this makes it explicit when student or shared projects consume instructor, team, or student running-project slots."
      />
      <RuntimeSponsorUsageSummary project_id={project_id} />
    </Space>
  );
}
