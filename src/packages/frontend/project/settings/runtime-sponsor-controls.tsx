/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Space, Switch, Typography } from "antd";
import { useState } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Paragraph } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";

import type { Project } from "./types";

const { Text } = Typography;

interface Props {
  project: Project;
  project_id: string;
}

function accountIsProjectCollaborator(
  project: Project,
  account_id: string | undefined,
): boolean {
  if (!account_id) return false;
  const group = project.getIn(["users", account_id, "group"]);
  return group === "owner" || group === "collaborator";
}

function projectOwnerAccountId(project: Project): string | undefined {
  const users = project.get("users");
  if (!users) return undefined;
  return users
    .keySeq()
    .find((account_id) => users.getIn([account_id, "group"]) === "owner");
}

function runtimeSponsorAccountId(project: Project): string | undefined {
  const explicitSponsor = `${project.get("runtime_sponsor_account_id") ?? ""}`;
  if (accountIsProjectCollaborator(project, explicitSponsor)) {
    return explicitSponsor;
  }
  const usageSponsor = `${project.get("usage_account_id") ?? ""}`;
  if (accountIsProjectCollaborator(project, usageSponsor)) {
    return usageSponsor;
  }
  return projectOwnerAccountId(project);
}

export function RuntimeSponsorControls({ project, project_id }: Props) {
  const account_id = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const sponsorAccountId = runtimeSponsorAccountId(project);
  const isOwner = account_id === projectOwnerAccountId(project);
  const isSponsor = !!account_id && account_id === sponsorAccountId;
  const canEdit = isAdmin || isOwner || isSponsor;
  const checked =
    project.get("allow_collaborator_starts_using_sponsor") !== false;

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

  return (
    <section>
      <Space
        align="start"
        style={{
          width: "100%",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <Text strong>Collaborator Starts Using Sponsor</Text>
          <Paragraph style={{ color: COLORS.GRAY_D, margin: "4px 0 0" }}>
            Allow collaborators to start or restart this project using the
            runtime sponsor&apos;s membership. Turn this off when invited users
            should not consume the sponsor&apos;s simultaneous running-project
            slots.
          </Paragraph>
          <Paragraph style={{ color: COLORS.GRAY_M, margin: "4px 0 0" }}>
            Project owners, the runtime sponsor, and administrators can still
            start the project when this is off.
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
      {!canEdit && (
        <Alert
          style={{ marginTop: 10 }}
          type="info"
          showIcon
          message="Only project owners, the runtime sponsor, and administrators can change this setting."
        />
      )}
      {error && (
        <Alert
          style={{ marginTop: 10 }}
          type="error"
          showIcon
          message="Unable to save collaborator start policy"
          description={error}
        />
      )}
    </section>
  );
}
