/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon, Paragraph, Title } from "@cocalc/frontend/components";
import { FLYOUT_PADDING } from "./consts";
import { AppServerPanel } from "@cocalc/frontend/project/app-server-panel";

export function ServersFlyout({ project_id, wrap }) {
  function renderEmbeddedApps() {
    return (
      <div style={{ padding: FLYOUT_PADDING }}>
        <Title level={5}>
          <Icon name="server" /> Managed Applications
        </Title>
        <Paragraph>
          Create and manage private or deployable applications for this
          workspace from one panel.
        </Paragraph>
        <AppServerPanel project_id={project_id} />
      </div>
    );
  }

  return wrap(renderEmbeddedApps());
}
