/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Card, Input, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
import { PROJECT_CAPABILITY_SPECS } from "@cocalc/util/project-capabilities";
import { COLORS } from "@cocalc/util/theme";

type Mode = "project" | "flyout";

interface Props {
  mode?: Mode;
  onDetails?: () => void;
  project_id: string;
}

type FeatureRow = {
  available: boolean;
  category: string;
  key: string;
  label: string;
};

const CATEGORY_ORDER = [
  "Languages",
  "Notebooks",
  "Publishing",
  "Developer Tools",
  "System",
  "Access",
  "Other",
];

const FEATURE_CATEGORIES: Record<string, string> = {
  conda: "Languages",
  julia: "Languages",
  nodejs: "Languages",
  pip: "Languages",
  python: "Languages",
  rmd: "Languages",
  rserver: "Languages",
  sage: "Languages",
  uv: "Languages",

  jupyter_lab: "Notebooks",
  jupyter_notebook: "Notebooks",
  qmd: "Notebooks",

  html2pdf: "Publishing",
  latex: "Publishing",
  pandoc: "Publishing",
  typst: "Publishing",

  gitlfs: "Developer Tools",
  vscode: "Developer Tools",

  ffmpeg: "System",
  imagemagick: "System",
  spellcheck: "System",

  sshd: "Access",
};

function categoryFor(key: string): string {
  return FEATURE_CATEGORIES[key] ?? "Other";
}

function featureRows(avail: any): FeatureRow[] {
  return PROJECT_CAPABILITY_SPECS.map((spec) => ({
    available: !!avail?.[spec.key],
    category: categoryFor(spec.key),
    key: spec.key,
    label: spec.label,
  }));
}

function groupedRows(rows: FeatureRow[]): [string, FeatureRow[]][] {
  const grouped = new Map<string, FeatureRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.category) ?? [];
    group.push(row);
    grouped.set(row.category, group);
  }
  return CATEGORY_ORDER.filter((category) => grouped.has(category)).map(
    (category) => [
      category,
      grouped.get(category)!.sort((a, b) => a.label.localeCompare(b.label)),
    ],
  );
}

function formatterCount(formatter: any): number {
  if (formatter === true) return 1;
  if (typeof formatter !== "object" || formatter == null) return 0;
  return Object.values(formatter).filter(Boolean).length;
}

export function EnvironmentFeatureGroups({
  mode = "project",
  onDetails,
  project_id,
}: Props) {
  const isFlyout = mode === "flyout";
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");
  const availableFeatures = useTypedRedux({ project_id }, "available_features");
  const configurationLoading = useTypedRedux(
    { project_id },
    "configuration_loading",
  );
  const avail = availableFeatures?.toJS?.();
  const rows = useMemo(() => featureRows(avail), [avail]);
  const query = search.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    if (!showAll && !row.available) return false;
    if (!query) return true;
    return (
      row.label.toLowerCase().includes(query) ||
      row.key.toLowerCase().includes(query) ||
      row.category.toLowerCase().includes(query)
    );
  });
  const groups = groupedRows(visibleRows);
  const availableCount = rows.filter((row) => row.available).length;
  const formatters = formatterCount(avail?.formatting);

  function reload(): void {
    redux.getProjectActions(project_id).reload_configuration();
  }

  return (
    <Card
      size="small"
      style={{ borderColor: COLORS.GRAY_LL }}
      styles={{ body: { padding: isFlyout ? 10 : 12 } }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 8,
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div>
          <Typography.Text strong>Available Features</Typography.Text>
          <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
            {configurationLoading
              ? "Refreshing feature probe..."
              : `${availableCount} available${formatters ? `, ${formatters} formatter${formatters === 1 ? "" : "s"}` : ""}`}
          </div>
        </div>
        <Space size={6}>
          {onDetails != null ? (
            <Button size="small" type="link" onClick={onDetails}>
              Details
            </Button>
          ) : undefined}
          <Button
            aria-label="Refresh available features"
            disabled={configurationLoading}
            icon={<ReloadOutlined />}
            onClick={reload}
            size="small"
          />
        </Space>
      </div>

      {showAll ? (
        <Input
          allowClear
          placeholder="Search features..."
          size="small"
          style={{ marginBottom: 10 }}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : undefined}

      {avail == null && configurationLoading ? (
        <Loading />
      ) : groups.length === 0 ? (
        <Typography.Text type="secondary">
          No matching features to show.
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          {groups.map(([category, rows]) => (
            <div key={category}>
              <Typography.Text
                type="secondary"
                style={{ display: "block", fontSize: 12, marginBottom: 4 }}
              >
                {category}
              </Typography.Text>
              <Space size={[6, 6]} wrap>
                {rows.map((row) => (
                  <Tag
                    key={row.key}
                    color={row.available ? "green" : undefined}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {row.label}
                  </Tag>
                ))}
              </Space>
            </div>
          ))}
        </Space>
      )}

      <div style={{ marginTop: 10 }}>
        <Button
          size="small"
          type="link"
          style={{ paddingInline: 0 }}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show available only" : "Show all / search"}
        </Button>
      </div>
    </Card>
  );
}
