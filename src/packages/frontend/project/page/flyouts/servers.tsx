/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Divider, Space } from "antd";

import { Icon, Paragraph, Title } from "@cocalc/frontend/components";
import { ServerLink } from "@cocalc/frontend/project/named-server-panel";
import { NAMED_SERVER_NAMES } from "@cocalc/util/types/servers";
import { FLYOUT_PADDING } from "./consts";
import { AppServerPanel } from "@cocalc/frontend/project/app-server-panel";

export function ServersFlyout({ project_id, wrap }) {
  const servers = NAMED_SERVER_NAMES.map((name) => (
    <ServerLink
      key={name}
      name={name}
      project_id={project_id}
      mode={"flyout"}
    />
  )).filter((s) => s != null);

  function renderEmbeddedServers() {
    return (
      <div style={{ padding: FLYOUT_PADDING }}>
        <Title level={5}>
          <Icon name="server" /> Notebook and Code Editing Servers
        </Title>
        <Paragraph>
          When launched, these servers run inside this project. They should open
          up in a new browser tab and get access to all files in this project.
          For deployable service/static apps, use Managed App Servers below.
        </Paragraph>
        <Space orientation="vertical">
          {servers}
          {servers.length === 0 && (
            <Paragraph>
              No available server has been detected in this project environment.
            </Paragraph>
          )}
        </Space>
        <Divider />
        <Title level={5}>
          <Icon name="server" /> Managed App Servers
        </Title>
        <Paragraph>
          Create and manage service/static app specs for this workspace.
        </Paragraph>
        <AppServerPanel project_id={project_id} />
      </div>
    );
  }

  return wrap(renderEmbeddedServers());
}
