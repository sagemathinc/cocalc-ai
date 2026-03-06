/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon, Paragraph, Title } from "@cocalc/frontend/components";
import { ICON_NAME, ROOT_STYLE, TITLE } from "./consts";
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
        Managed applications run inside this project and can be opened
        privately, exposed publicly, or integrated more deeply with the
        workspace over time.
      </Paragraph>
      <AppServerPanel project_id={project_id} />
    </div>
  );
}
