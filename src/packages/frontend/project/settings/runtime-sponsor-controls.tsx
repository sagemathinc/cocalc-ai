/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Popconfirm,
  Popover,
  Space,
  Switch,
  Typography,
} from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";

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
}: {
  icon: ReactNode;
  title: ReactNode;
  summary: ReactNode;
  details?: ReactNode;
  action?: ReactNode;
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
  const canSelfSponsor = isCollaborator && !isSponsor;
  const canStopSponsoring = isSponsor && !isOwner && !!ownerAccountId;
  const checked =
    project.get("allow_collaborator_starts_using_sponsor") !== false;
  const autostartChecked = project.get("autostart_enabled") !== false;

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

  const sponsor = sponsorAccountId ? (
    <User account_id={sponsorAccountId} show_avatar avatarSize={18} />
  ) : (
    "the project owner"
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
          summary={
            <>
              Starts use {sponsor}
              {"'s"} membership.
            </>
          }
          details="The sponsor's simultaneous running-project limit, shared-compute priority, and RAM limits apply while this project is running."
          action={sponsorAction}
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
      </Space>
      {!canEdit && (
        <Alert
          style={{ marginTop: 10 }}
          type="info"
          showIcon
          message="Only project owners, the runtime sponsor, and administrators can change this setting."
        />
      )}
      {canEdit && !canEditAutostart && (
        <Alert
          style={{ marginTop: 10 }}
          type="info"
          showIcon
          message="Only project owners and administrators can change automatic start settings."
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
