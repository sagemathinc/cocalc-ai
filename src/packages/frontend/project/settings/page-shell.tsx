/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Grid, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";

import { CopyToClipBoard, Icon } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import { Project } from "./types";
import {
  ProjectSettingsNavItem,
  ProjectSettingsSectionNav,
} from "./section-nav";
import { ProjectSettingsHealthRail } from "./health-rail";

const { Paragraph, Text, Title } = Typography;
const HEADER_LINK_IDS = [
  "resources",
  "location",
  "people",
  "recovery",
] as const;

interface Props {
  project_id: string;
  project: Project;
  navItems: ProjectSettingsNavItem[];
  children: ReactNode;
  showNoInternetWarning?: boolean;
  showNonMemberWarning?: boolean;
}

export function ProjectSettingsPageShell({
  project_id,
  project,
  navItems,
  children,
  showNoInternetWarning,
  showNonMemberWarning,
}: Props) {
  const title = project.get("title") || "Untitled Project";
  const hidden = !!project.get("hidden");
  const screens = Grid.useBreakpoint();
  const wide = !!screens.xl;
  const headerLinks = HEADER_LINK_IDS.flatMap((id) => {
    const item = navItems.find((item) => item.id === id);
    return item == null ? [] : [item];
  });

  return (
    <div
      style={{
        background:
          "linear-gradient(180deg, rgba(244, 247, 251, 0.9), rgba(255,255,255,0.95) 280px)",
        margin: "-15px",
        minHeight: "100%",
        padding: "20px",
      }}
    >
      <Card
        style={{
          border: "1px solid #d9e2ec",
          boxShadow: "0 10px 34px rgba(15, 23, 42, 0.07)",
          marginBottom: 18,
        }}
        styles={{ body: { padding: 20 } }}
      >
        <div
          style={{
            alignItems: "flex-start",
            display: "flex",
            gap: 18,
            justifyContent: "space-between",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Space size={8} wrap style={{ marginBottom: 8 }}>
              <Tag color={hidden ? "warning" : "green"}>
                {hidden ? "Hidden" : "Active"}
              </Tag>
              <Tag>Project</Tag>
            </Space>
            <Title
              level={2}
              style={{
                color: COLORS.GRAY_DD,
                margin: 0,
                overflowWrap: "anywhere",
              }}
            >
              <Icon name="wrench" /> Project Settings
            </Title>
            <Paragraph style={{ margin: "6px 0 0", fontSize: 16 }}>
              {title}
            </Paragraph>
            <div style={{ marginTop: 12 }}>
              <CopyToClipBoard
                value={project_id}
                display={project_id}
                size="small"
                inputWidth="300px"
                label={<Text type="secondary">Project ID</Text>}
              />
            </div>
          </div>
          <Space wrap>
            {headerLinks.map((item) => (
              <Button
                key={item.id}
                href={`#${item.id}`}
                danger={item.danger}
                icon={<Icon name={item.icon} />}
              >
                {item.label}
              </Button>
            ))}
          </Space>
        </div>
      </Card>
      <div
        style={{
          alignItems: "start",
          display: "grid",
          gap: 18,
          gridTemplateColumns: wide
            ? "220px minmax(0, 1fr) 310px"
            : "minmax(0, 1fr)",
        }}
      >
        <ProjectSettingsSectionNav items={navItems} />
        {!wide && (
          <ProjectSettingsHealthRail
            project_id={project_id}
            project={project}
            showNoInternetWarning={showNoInternetWarning}
            showNonMemberWarning={showNonMemberWarning}
          />
        )}
        <main>
          <Space direction="vertical" size={18} style={{ width: "100%" }}>
            {children}
          </Space>
        </main>
        {wide && (
          <ProjectSettingsHealthRail
            project_id={project_id}
            project={project}
            showNoInternetWarning={showNoInternetWarning}
            showNonMemberWarning={showNonMemberWarning}
          />
        )}
      </div>
    </div>
  );
}
