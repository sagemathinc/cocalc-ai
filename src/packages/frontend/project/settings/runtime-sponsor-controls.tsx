/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Popconfirm, Space, Switch, Typography } from "antd";
import { useState } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Paragraph } from "@cocalc/frontend/components";
import {
  accountIsProjectCollaborator,
  projectOwnerAccountId,
  runtimeSponsorAccountId,
} from "@cocalc/frontend/projects/runtime-start-policy";
import { User } from "@cocalc/frontend/users/user";
import { COLORS } from "@cocalc/util/theme";

import type { Project } from "./types";

const { Text } = Typography;

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

  return (
    <section>
      <div style={{ marginBottom: 14 }}>
        <Text strong>Runtime Sponsor</Text>
        <Paragraph style={{ color: COLORS.GRAY_D, margin: "4px 0 0" }}>
          This project starts and runs using{" "}
          {sponsorAccountId ? (
            <User account_id={sponsorAccountId} show_avatar avatarSize={18} />
          ) : (
            "the project owner's"
          )}{" "}
          membership. The sponsor&apos;s simultaneous running-project limit,
          shared-compute priority, and RAM limits apply while this project is
          running.
        </Paragraph>
        {canSelfSponsor && (
          <div style={{ marginTop: 8 }}>
            <Popconfirm
              title="Use your membership as runtime sponsor?"
              description="Future starts of this project will use your simultaneous running-project slots instead of the current sponsor's slots."
              okText="Use my membership"
              cancelText="Cancel"
              onConfirm={useMyMembership}
            >
              <Button size="small" loading={changingSponsor}>
                Use my membership for future starts
              </Button>
            </Popconfirm>
          </div>
        )}
        {canStopSponsoring && (
          <div style={{ marginTop: 8 }}>
            <Popconfirm
              title="Stop sponsoring this project?"
              description="Future starts will use the project owner's membership again. This does not stop the project if it is already running."
              okText="Stop sponsoring"
              cancelText="Cancel"
              onConfirm={stopSponsoring}
            >
              <Button size="small" loading={revertingSponsor}>
                Stop sponsoring this project
              </Button>
            </Popconfirm>
          </div>
        )}
      </div>
      <Space
        align="start"
        style={{
          width: "100%",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <Text strong>Collaborators may use sponsor slots</Text>
          <Paragraph style={{ color: COLORS.GRAY_D, margin: "4px 0 0" }}>
            When enabled, ordinary collaborators can start or restart this
            project using the runtime sponsor&apos;s membership. Turn this off
            when invited users should not consume the sponsor&apos;s
            simultaneous running-project slots.
          </Paragraph>
          <Paragraph style={{ color: COLORS.GRAY_M, margin: "4px 0 0" }}>
            Project owners, the runtime sponsor, and administrators can still
            start the project when this is off. A collaborator can also make
            themself the runtime sponsor explicitly.
          </Paragraph>
        </div>
        <Switch
          checked={checked}
          loading={saving}
          disabled={!canEdit}
          checkedChildren="Allowed"
          unCheckedChildren="Blocked"
          onChange={setAllowCollaboratorStarts}
        />
      </Space>
      <Space
        align="start"
        style={{
          width: "100%",
          justifyContent: "space-between",
          gap: 16,
          marginTop: 16,
        }}
      >
        <div>
          <Text strong>Automatic starts</Text>
          <Paragraph style={{ color: COLORS.GRAY_D, margin: "4px 0 0" }}>
            Allow SSH, HTTP/app access, terminals, Jupyter, Codex, and other
            wake-on-use paths to start this project automatically. Turn this off
            when starts should only happen from an explicit Start button.
          </Paragraph>
          <Paragraph style={{ color: COLORS.GRAY_M, margin: "4px 0 0" }}>
            Automatic starts still use the runtime sponsor&apos;s simultaneous
            running-project slots. They never stop another project to make room.
          </Paragraph>
        </div>
        <Switch
          checked={autostartChecked}
          loading={savingAutostart}
          disabled={!canEditAutostart}
          checkedChildren="Allowed"
          unCheckedChildren="Blocked"
          onChange={setAutostartEnabled}
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
