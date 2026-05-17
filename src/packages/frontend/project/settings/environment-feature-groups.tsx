/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Card, Input, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import { Loading } from "@cocalc/frontend/components";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";
import { tool2display } from "@cocalc/util/code-formatter";
import { to_human_list } from "@cocalc/util/misc";
import {
  buildFormatterAgentPrompt,
  buildProjectCapabilityAgentPrompt,
  PROJECT_CAPABILITY_SPECS,
  type ProjectCapabilitySpec,
} from "@cocalc/util/project-capabilities";
import { COLORS } from "@cocalc/util/theme";

type Mode = "project" | "flyout";

interface Props {
  expanded?: boolean;
  mode?: Mode;
  onExpandedChange?: (expanded: boolean) => void;
  onDetails?: () => void;
  project_id: string;
}

type FeatureRow = {
  available: boolean;
  category: string;
  key: string;
  label: string;
  probeSummary: string;
  spec: ProjectCapabilitySpec;
};

type FormatterRow = {
  available: boolean;
  key: string;
  label: string;
  languages: string[];
};

const CATEGORY_ORDER = [
  "Languages",
  "Notebooks",
  "Terminals",
  "Publishing",
  "Developer Tools",
  "System",
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

  sshd: "Terminals",
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
    probeSummary: spec.probeSummary,
    spec,
  }));
}

function formatterRows(formatter: any): FormatterRow[] {
  if (typeof formatter !== "object" || formatter == null) return [];
  return Object.keys(formatter)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((tool) => {
      const languages = tool2display[tool];
      if (languages == null || languages.length === 0) return [];
      return [
        {
          available: !!formatter[tool],
          key: tool,
          label: tool,
          languages,
        },
      ];
    });
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
  expanded,
  mode = "project",
  onExpandedChange,
  onDetails,
  project_id,
}: Props) {
  const isFlyout = mode === "flyout";
  const [uncontrolledShowAll, setUncontrolledShowAll] = useState(false);
  const [search, setSearch] = useState("");
  const [sendingAgentTarget, setSendingAgentTarget] = useState<string | null>(
    null,
  );
  const availableFeatures = useTypedRedux({ project_id }, "available_features");
  const configurationLoading = useTypedRedux(
    { project_id },
    "configuration_loading",
  );
  const avail = availableFeatures?.toJS?.();
  const showAll = expanded ?? uncontrolledShowAll;
  const rows = useMemo(() => featureRows(avail), [avail]);
  const formatters = useMemo(() => formatterRows(avail?.formatting), [avail]);
  const query = search.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    if (!showAll && !row.available) return false;
    if (!query) return true;
    return (
      row.label.toLowerCase().includes(query) ||
      row.key.toLowerCase().includes(query) ||
      row.category.toLowerCase().includes(query) ||
      row.probeSummary.toLowerCase().includes(query)
    );
  });
  const visibleFormatters = formatters.filter((row) => {
    if (!query) return true;
    return (
      row.label.toLowerCase().includes(query) ||
      row.key.toLowerCase().includes(query) ||
      row.languages.some((language) => language.toLowerCase().includes(query))
    );
  });
  const groups = groupedRows(visibleRows);
  const availableCount = rows.filter((row) => row.available).length;
  const availableFormatterCount = formatterCount(avail?.formatting);

  function reload(): void {
    redux.getProjectActions(project_id).reload_configuration();
  }

  function setShowAll(next: boolean): void {
    if (expanded == null) {
      setUncontrolledShowAll(next);
    }
    onExpandedChange?.(next);
  }

  async function sendInstallPrompt(opts: {
    key: string;
    prompt: string;
    tag: string;
    title: string;
    visiblePrompt: string;
  }): Promise<void> {
    try {
      setSendingAgentTarget(opts.key);
      const sent = await submitNavigatorPromptInWorkspaceChat({
        forceCodex: true,
        openFloating: true,
        project_id,
        prompt: opts.prompt,
        tag: opts.tag,
        title: opts.title,
        visiblePrompt: opts.visiblePrompt,
        waitForAgent: false,
      });
      if (!sent) {
        throw new Error("Unable to submit request to Agent.");
      }
    } catch (err) {
      alert_message({
        type: "error",
        message: `Unable to ask Agent for help: ${err}`,
      });
    } finally {
      setSendingAgentTarget((current) =>
        current === opts.key ? null : current,
      );
    }
  }

  function renderFeatureRow(row: FeatureRow) {
    const agentKey = `feature:${row.key}`;
    return (
      <div
        key={row.key}
        style={{
          alignItems: "center",
          borderTop: `1px solid ${COLORS.GRAY_LL}`,
          display: "grid",
          gap: 10,
          gridTemplateColumns: "18px minmax(0, 1fr) auto",
          padding: "8px 0",
        }}
      >
        {row.available ? (
          <CheckCircleOutlined style={{ color: COLORS.BS_GREEN_D }} />
        ) : (
          <CloseCircleOutlined style={{ color: COLORS.GRAY_M }} />
        )}
        <div style={{ minWidth: 0 }}>
          <Space size={6} wrap>
            <Typography.Text strong>{row.label}</Typography.Text>
            <Tag
              color={row.available ? "green" : undefined}
              style={{ marginInlineEnd: 0 }}
            >
              {row.available ? "Available" : "Missing"}
            </Tag>
          </Space>
          <div
            style={{
              color: COLORS.GRAY_M,
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={row.probeSummary}
          >
            {row.probeSummary}
          </div>
        </div>
        {!row.available ? (
          <Button
            loading={sendingAgentTarget === agentKey}
            onClick={() =>
              void sendInstallPrompt({
                key: agentKey,
                prompt: buildProjectCapabilityAgentPrompt(row.spec),
                tag: `intent:project-capability:${row.key}`,
                title: `Install ${row.label}`,
                visiblePrompt: `Install ${row.label}`,
              })
            }
            size="small"
          >
            Agent
          </Button>
        ) : undefined}
      </div>
    );
  }

  function renderFormatterRow(row: FormatterRow) {
    const agentKey = `formatter:${row.key}`;
    return (
      <div
        key={row.key}
        style={{
          alignItems: "center",
          borderTop: `1px solid ${COLORS.GRAY_LL}`,
          display: "grid",
          gap: 10,
          gridTemplateColumns: "18px minmax(0, 1fr) auto",
          padding: "8px 0",
        }}
      >
        {row.available ? (
          <CheckCircleOutlined style={{ color: COLORS.BS_GREEN_D }} />
        ) : (
          <CloseCircleOutlined style={{ color: COLORS.GRAY_M }} />
        )}
        <div style={{ minWidth: 0 }}>
          <Space size={6} wrap>
            <Typography.Text strong>{row.label}</Typography.Text>
            <Tag
              color={row.available ? "green" : undefined}
              style={{ marginInlineEnd: 0 }}
            >
              {row.available ? "Available" : "Missing"}
            </Tag>
          </Space>
          <div style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
            Formatter for {to_human_list(row.languages)}
          </div>
        </div>
        {!row.available ? (
          <Button
            loading={sendingAgentTarget === agentKey}
            onClick={() =>
              void sendInstallPrompt({
                key: agentKey,
                prompt: buildFormatterAgentPrompt({
                  languages: row.languages,
                  tool: row.key,
                }),
                tag: `intent:project-formatter:${row.key}`,
                title: `Install formatter ${row.key}`,
                visiblePrompt: `Install formatter ${row.key}`,
              })
            }
            size="small"
          >
            Agent
          </Button>
        ) : undefined}
      </div>
    );
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
              : `${availableCount} available${availableFormatterCount ? `, ${availableFormatterCount} formatter${availableFormatterCount === 1 ? "" : "s"}` : ""}`}
          </div>
        </div>
        <Space size={6}>
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
      ) : groups.length === 0 &&
        (!showAll || visibleFormatters.length === 0) ? (
        <Typography.Text type="secondary">
          No matching features to show.
        </Typography.Text>
      ) : showAll ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {groups.map(([category, rows]) => (
            <div key={category}>
              <Typography.Text
                type="secondary"
                style={{ display: "block", fontSize: 12 }}
              >
                {category}
              </Typography.Text>
              {rows.map(renderFeatureRow)}
            </div>
          ))}
          {visibleFormatters.length > 0 ? (
            <div>
              <Typography.Text
                type="secondary"
                style={{ display: "block", fontSize: 12 }}
              >
                Formatters
              </Typography.Text>
              {visibleFormatters.map(renderFormatterRow)}
            </div>
          ) : undefined}
          {onDetails != null ? (
            <Button size="small" type="link" onClick={onDetails}>
              Open technical feature probe
            </Button>
          ) : undefined}
        </Space>
      ) : (
        <div
          style={{
            display: "grid",
            gap: isFlyout ? 8 : 10,
            gridTemplateColumns: isFlyout
              ? "1fr"
              : "repeat(auto-fit, minmax(170px, 1fr))",
          }}
        >
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
        </div>
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
