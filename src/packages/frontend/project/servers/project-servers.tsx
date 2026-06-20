/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Icon, Paragraph, Tip, Title } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import { Alert } from "antd";
import { ICON_NAME, ROOT_STYLE, TITLE } from "./consts";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { AppServerPanel } from "../app-server-panel";

const APPS_TECHNICAL_INFO = (
  <div>
    <div style={{ marginBottom: 6 }}>
      Apps help you open project work in a browser or publish selected project
      files.
    </div>
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      <li>Start tools like JupyterLab, Streamlit, APIs, or dashboards.</li>
      <li>Publish notebooks, Markdown, slides, and boards read-only.</li>
      <li>Detect and adopt servers you already started in the project.</li>
      <li>Apps are private by default; public sharing is explicit.</li>
    </ul>
  </div>
);

function AppsTitle() {
  return (
    <Title level={2}>
      <Icon name={ICON_NAME} /> {TITLE}
      <Tip
        title="What Apps do"
        tip={APPS_TECHNICAL_INFO}
        placement="right"
        trigger={["hover", "click"]}
        allow_touch
        ignore_hide_setting
        tip_style={{ maxWidth: 400 }}
      >
        <button
          aria-label="Technical information about Apps"
          type="button"
          style={{
            background: "transparent",
            border: 0,
            color: COLORS.ANTD_LINK_BLUE,
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            marginLeft: 8,
            padding: 0,
            verticalAlign: "middle",
          }}
        >
          <Icon name="info-circle" />
        </button>
      </Tip>
    </Title>
  );
}

export function ProjectServers() {
  const { project_id, projectAccess } = useProjectContext();

  if (!projectAccess.capabilities.useProjectRuntime) {
    return (
      <div style={ROOT_STYLE}>
        <AppsTitle />
        <Alert
          showIcon
          type="info"
          message="Viewer access is read-only"
          description="Viewers cannot start or open project app servers. Ask an owner or collaborator to upgrade your role if you need runtime access."
        />
      </div>
    );
  }

  return (
    <div style={ROOT_STYLE}>
      <AppsTitle />
      <Paragraph>
        Launch services, publish project files, and manage app access.
      </Paragraph>
      <AppServerPanel project_id={project_id} />
    </div>
  );
}
