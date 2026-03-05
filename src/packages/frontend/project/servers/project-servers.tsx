/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { FormattedMessage } from "react-intl";
import { A, Icon, Paragraph, Title } from "@cocalc/frontend/components";
import { ICON_NAME, ROOT_STYLE, TITLE } from "./consts";
import { ProjectServerTiles } from "./server-tiles";
import { Divider } from "antd";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { AppServerPanel } from "../app-server-panel";

export function ProjectServers() {
  const { project_id } = useProjectContext();

  return (
    <div style={ROOT_STYLE}>
      <Title level={2}>
        <Icon name={ICON_NAME} /> {TITLE}
      </Title>
      <Paragraph>
        <FormattedMessage
          id="project.servers.project-servers.description"
          defaultMessage={`Run various notebook servers inside this project.
            They run in the same environment, have access to the same files,
            and stop when the project stops.
            You can also <A>run your own web servers</A>.
            For deployable service/static apps, use Managed App Servers below.`}
          values={{
            A: (c) => (
              <A href={"https://doc.cocalc.com/howto/webserver.html"}>{c}</A>
            ),
          }}
        />
      </Paragraph>
      <ProjectServerTiles />
      <Divider />
      <Title level={3}>
        <Icon name="server" /> Managed App Servers
      </Title>
      <Paragraph>
        Create and manage service/static app specs, expose/unexpose public URLs,
        and run readiness audits from one panel.
      </Paragraph>
      <AppServerPanel project_id={project_id} />
    </div>
  );
}
