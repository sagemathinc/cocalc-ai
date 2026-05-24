/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";

import { Flex, message, Typography } from "antd";
import {
  DocsBrowser,
  DocsFontSizeFrame,
  DOCS_BROWSER_FLYOUT_STYLE,
  DOCS_BROWSER_MUTED_TITLE_STYLE,
  DOCS_BROWSER_PAGE_STYLE,
  type DocsBrowserAction,
} from "@cocalc/frontend/docs/browser";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  listDocsAppActions,
  revealDocsAction,
} from "@cocalc/frontend/project/docs-actions";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
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
  const accountFontSize =
    useTypedRedux("account", "font_size") ?? DEFAULT_FONT_SIZE;
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

  const isFlyout = layout === "flyout";

  return (
    <div
      style={
        layout === "page" ? DOCS_BROWSER_PAGE_STYLE : DOCS_BROWSER_FLYOUT_STYLE
      }
    >
      {contextHolder}
      <DocsFontSizeFrame defaultFontSize={accountFontSize} layout={layout}>
        <Flex gap={isFlyout ? "small" : "middle"} vertical>
          <div>
            <Text strong style={DOCS_BROWSER_MUTED_TITLE_STYLE}>
              CoCalc docs
            </Text>
            <Title
              level={layout === "page" ? 1 : 4}
              style={{
                lineHeight: 1.15,
                marginBottom: 0,
                marginTop: isFlyout ? 4 : 8,
              }}
            >
              Help for this project
            </Title>
          </div>
          <Paragraph
            style={{
              color: COLORS.GRAY_M,
              fontSize: isFlyout ? "0.93em" : undefined,
              lineHeight: isFlyout ? 1.4 : undefined,
              marginBottom: isFlyout ? 6 : 20,
            }}
          >
            Search current CoCalc-ai docs without leaving the project. Pages
            with implemented actions can open the relevant app panel directly.
          </Paragraph>
        </Flex>
        <DocsBrowser
          actionAvailability={actionAvailability}
          layout={layout}
          onRunAction={runAction}
        />
      </DocsFontSizeFrame>
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
