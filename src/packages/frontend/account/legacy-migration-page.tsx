/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useState } from "react";
import { defineMessage } from "react-intl";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  LegacyMigrationImportProjectResult,
  LegacyMigrationProjectSummary,
} from "@cocalc/conat/hub/api/legacy-migration";
import type { SettingsPageDefinition } from "./settings-page";

const { Paragraph, Text } = Typography;

type LegacyMigrationState = {
  error: string;
  legacyAccountIds: string[];
  loading: boolean;
  projects: LegacyMigrationProjectSummary[];
};

function formatDate(value?: Date | string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unknown";
  return date.toLocaleString();
}

function restoreTag(project: LegacyMigrationProjectSummary) {
  const status = project.restore_status;
  if (!status) return <Tag>not started</Tag>;
  if (status === "restored") return <Tag color="green">files restored</Tag>;
  if (status === "pending") return <Tag color="gold">file restore pending</Tag>;
  if (status === "failed") return <Tag color="red">file restore failed</Tag>;
  if (status === "restoring") return <Tag color="blue">restoring files</Tag>;
  return <Tag>{status}</Tag>;
}

function importTag(project: LegacyMigrationProjectSummary) {
  if (project.import_status === "not-imported") {
    return <Tag>not imported</Tag>;
  }
  if (project.import_status === "imported") {
    return project.joined ? (
      <Tag color="green">imported for you</Tag>
    ) : (
      <Tag color="blue">already imported</Tag>
    );
  }
  if (project.import_status === "creating") {
    return <Tag color="gold">creating</Tag>;
  }
  return <Tag color="red">failed</Tag>;
}

function projectLink(project_id?: string | null) {
  if (!project_id) return null;
  return (
    <Button href={`/projects/${project_id}/files/`} size="small">
      Open
    </Button>
  );
}

function resultSummary(results: LegacyMigrationImportProjectResult[]): string {
  const imported = results.filter((result) => result.status === "imported");
  const joined = results.filter((result) => result.status === "joined");
  const failed = results.filter((result) => result.status === "failed");
  const creating = results.filter((result) => result.status === "creating");
  return [
    imported.length ? `${imported.length} imported` : "",
    joined.length ? `${joined.length} joined` : "",
    creating.length ? `${creating.length} still creating` : "",
    failed.length ? `${failed.length} failed` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export const LEGACY_MIGRATION_SETTINGS_PAGE = {
  component: LegacyMigrationPage,
  description: defineMessage({
    id: "account.settings.overview.legacy-migration",
    defaultMessage:
      "Import projects from legacy cocalc.com archives into CoCalc.",
  }),
  icon: "exchange",
  key: "legacy-migration",
  label: defineMessage({
    id: "account.settings.legacy-migration.label",
    defaultMessage: "Legacy migration",
  }),
  title: defineMessage({
    id: "account.settings.legacy-migration.title",
    defaultMessage: "Legacy cocalc.com migration",
  }),
} satisfies SettingsPageDefinition;

export function LegacyMigrationPage() {
  const account_id = useTypedRedux("account", "account_id");
  const [state, setState] = useState<LegacyMigrationState>({
    error: "",
    legacyAccountIds: [],
    loading: true,
    projects: [],
  });
  const [includeHidden, setIncludeHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [lastResults, setLastResults] = useState<
    LegacyMigrationImportProjectResult[]
  >([]);

  async function loadProjects(nextQuery = query) {
    if (!account_id) return;
    setState((prev) => ({ ...prev, error: "", loading: true }));
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.listProjects({
          include_hidden: includeHidden,
          query: nextQuery,
        });
      setState({
        error: "",
        legacyAccountIds: response.legacy_account_ids,
        loading: false,
        projects: response.projects,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: `${err}`,
        loading: false,
      }));
    }
  }

  useEffect(() => {
    void loadProjects();
  }, [account_id, includeHidden]);

  async function importSelected() {
    if (selected.length === 0) return;
    setImporting(true);
    setLastResults([]);
    try {
      const response =
        await webapp_client.conat_client.hub.legacyMigration.importProjects({
          legacy_project_ids: selected,
        });
      setLastResults(response.results);
      void message.info(
        resultSummary(response.results) || "No projects changed",
      );
      setSelected([]);
      await loadProjects();
    } catch (err) {
      void message.error(`${err}`);
    } finally {
      setImporting(false);
    }
  }

  const columns = [
    {
      title: "Project",
      dataIndex: "title",
      key: "title",
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={2}>
          <Text strong>{project.title}</Text>
          <Text type="secondary">{project.legacy_project_id}</Text>
          {project.description ? (
            <Text type="secondary" ellipsis>
              {project.description}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "Last edited",
      dataIndex: "last_edited",
      key: "last_edited",
      render: (value: Date | string | null) => formatDate(value),
      sorter: (
        left: LegacyMigrationProjectSummary,
        right: LegacyMigrationProjectSummary,
      ) =>
        new Date(left.last_edited ?? 0).getTime() -
        new Date(right.last_edited ?? 0).getTime(),
    },
    {
      title: "Import",
      key: "import",
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={4}>
          {importTag(project)}
          {projectLink(project.project_id)}
        </Space>
      ),
    },
    {
      title: "Files",
      key: "files",
      render: (_: unknown, project: LegacyMigrationProjectSummary) => (
        <Space direction="vertical" size={4}>
          {restoreTag(project)}
          {project.restore_error ? (
            <Text type="danger">{project.restore_error}</Text>
          ) : null}
          {project.artifact_status && !project.restore_status ? (
            <Text type="secondary">{project.artifact_status}</Text>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Paragraph type="secondary">
        Import selected projects from the archived legacy cocalc.com snapshot.
        Project metadata is created immediately. File archives are restored from
        R2 by a follow-up restore worker, so imported projects can temporarily
        show as file restore pending.
      </Paragraph>

      <Alert
        showIcon
        type="warning"
        message="Legacy migration is still being rolled out"
        description="This page lists projects for legacy accounts that match your verified email address or have already been linked by support."
      />

      {state.error ? (
        <Alert showIcon type="error" message={state.error} />
      ) : null}

      <Card
        title={
          <Space>
            <Icon name="exchange" />
            <span>cocalc.com projects</span>
          </Space>
        }
        extra={
          <Space wrap>
            <Checkbox
              checked={includeHidden}
              onChange={(event) => setIncludeHidden(event.target.checked)}
            >
              Include hidden
            </Checkbox>
            <Button loading={state.loading} onClick={() => void loadProjects()}>
              Refresh
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Input.Search
            allowClear
            enterButton="Search"
            onChange={(event) => setQuery(event.target.value)}
            onSearch={(value) => {
              setQuery(value);
              void loadProjects(value);
            }}
            placeholder="Search legacy projects"
            value={query}
          />

          {state.loading && state.projects.length === 0 ? (
            <Loading />
          ) : state.legacyAccountIds.length === 0 ? (
            <Alert
              showIcon
              type="info"
              message="No linked cocalc.com account found"
              description="Use the same verified email address as your old cocalc.com account, or contact support if your legacy account used another identity."
            />
          ) : (
            <>
              <Space wrap>
                <Text type="secondary">
                  Matched {state.legacyAccountIds.length} legacy account
                  {state.legacyAccountIds.length === 1 ? "" : "s"}.
                </Text>
                <Button
                  disabled={selected.length === 0}
                  loading={importing}
                  onClick={() => void importSelected()}
                  type="primary"
                >
                  Import selected
                </Button>
              </Space>
              {lastResults.length > 0 ? (
                <Alert
                  showIcon
                  type={
                    lastResults.some((result) => result.status === "failed")
                      ? "warning"
                      : "success"
                  }
                  message={resultSummary(lastResults)}
                />
              ) : null}
              <Table<LegacyMigrationProjectSummary>
                columns={columns}
                dataSource={state.projects}
                loading={state.loading}
                pagination={{ pageSize: 25, showSizeChanger: true }}
                rowKey="legacy_project_id"
                rowSelection={{
                  selectedRowKeys: selected,
                  onChange: (keys) => setSelected(keys.map((key) => `${key}`)),
                  getCheckboxProps: (project) => ({
                    disabled: project.import_status === "creating",
                  }),
                }}
              />
            </>
          )}
        </Space>
      </Card>
    </Space>
  );
}
