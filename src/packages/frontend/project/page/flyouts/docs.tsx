/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";

import { message, Typography } from "antd";
import {
  DocsBrowser,
  DOCS_BROWSER_FLYOUT_STYLE,
  DOCS_BROWSER_MUTED_TITLE_STYLE,
  DOCS_BROWSER_PAGE_STYLE,
  type DocsBrowserAction,
} from "@cocalc/frontend/docs/browser";
import {
  listDocsAppActions,
  revealDocsAction,
} from "@cocalc/frontend/project/docs-actions";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;

export function ProjectDocsPanel({
  layout,
  project_id,
}: {
  layout: "flyout" | "page";
  project_id: string;
}) {
  const [messageApi, contextHolder] = message.useMessage();
  const actionAvailability = useMemo(
    () => listDocsAppActions({ projectId: project_id }),
    [project_id],
  );

  async function runAction(action: DocsBrowserAction): Promise<void> {
    try {
      await revealDocsAction({ actionId: action.id, projectId: project_id });
      await messageApi.success(action.label);
    } catch (err) {
      await messageApi.error(`${err}`);
    }
  }

  return (
    <div
      style={
        layout === "page" ? DOCS_BROWSER_PAGE_STYLE : DOCS_BROWSER_FLYOUT_STYLE
      }
    >
      {contextHolder}
      <Text strong style={DOCS_BROWSER_MUTED_TITLE_STYLE}>
        CoCalc docs
      </Text>
      <Title level={layout === "page" ? 1 : 3} style={{ marginTop: 8 }}>
        Help for this workspace
      </Title>
      <Paragraph style={{ color: COLORS.GRAY_M, marginBottom: 20 }}>
        Search current CoCalc-ai docs without leaving the project. Pages with
        implemented actions can open the relevant app panel directly.
      </Paragraph>
      <DocsBrowser
        actionAvailability={actionAvailability}
        onRunAction={runAction}
      />
    </div>
  );
}

export function DocsFlyout({
  project_id,
  wrap,
}: {
  project_id: string;
  wrap: (
    content: React.JSX.Element,
    style?: React.CSSProperties,
  ) => React.JSX.Element;
  flyoutWidth: number;
}) {
  return wrap(<ProjectDocsPanel layout="flyout" project_id={project_id} />);
}
