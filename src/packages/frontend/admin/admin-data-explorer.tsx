/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  message,
  type TableColumnsType,
} from "antd";
import { useEffect, useRef, useState } from "react";

import { React } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { ErrorDisplay, Loading } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  AdminDataDataset,
  AdminDataSqlRunResult,
  AdminDataSqlValidationResult,
  AdminDataView,
  AdminDataViewExport,
  AdminDataViewInput,
  AdminDataViewSummary,
} from "@cocalc/conat/hub/api/admin-data-explorer";
import { ADMIN_DATA_EXPLORER_SQL_CONSTRAINTS } from "@cocalc/util/admin-data-explorer";

const { Paragraph, Text } = Typography;
const { TextArea } = Input;

const DEFAULT_SQL = `select account_id, email_address, created, last_active
from accounts
order by created desc
limit 100`;

interface ResultRow {
  key: number;
  [key: string]: unknown;
}

function getHub() {
  return webapp_client.conat_client.hub;
}

function browserId(): string | null {
  return webapp_client.browser_id ?? null;
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderCellValue(value: unknown): React.ReactNode {
  if (value == null) {
    return <Text type="secondary">null</Text>;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "object") {
    return (
      <Text code style={{ whiteSpace: "pre-wrap" }}>
        {JSON.stringify(value)}
      </Text>
    );
  }
  return `${value}`;
}

function sqlFromView(view: AdminDataView): string | null {
  if (view.query_kind !== "sql") return null;
  const sql = (view.query as { sql?: unknown }).sql;
  return typeof sql === "string" ? sql : null;
}

function summarizeScope(view: AdminDataViewSummary): string {
  const scope = view.scope;
  switch (scope.kind) {
    case "bay":
      return `bay ${scope.bay_id ?? ""}`.trim();
    case "host":
      return `host ${scope.host_id ?? ""}`.trim();
    case "project":
      return `project ${scope.project_id ?? ""}`.trim();
    case "account":
      return `account ${scope.account_id ?? ""}`.trim();
    default:
      return scope.kind;
  }
}

function ValidationSummary({
  validation,
}: {
  validation: AdminDataSqlValidationResult | null;
}) {
  if (validation == null) return null;
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {validation.ok ? (
        <Alert type="success" showIcon message="SQL passed guardrail checks." />
      ) : (
        <Alert
          type="error"
          showIcon
          message="SQL did not pass guardrail checks."
          description={validation.errors.join("\n")}
        />
      )}
      {validation.warnings.length ? (
        <Alert
          type="warning"
          showIcon
          message="Warnings"
          description={validation.warnings.join("\n")}
        />
      ) : null}
      <Space wrap>
        <Tag color={validation.ok ? "green" : "red"}>
          enforced limit {validation.enforced_limit}
        </Tag>
        {validation.relations.map((relation) => (
          <Tag key={`relation-${relation}`} color="blue">
            {relation}
          </Tag>
        ))}
        {validation.functions.map((fn) => (
          <Tag key={`function-${fn}`}>{fn}()</Tag>
        ))}
      </Space>
    </Space>
  );
}

function ResultTable({ result }: { result: AdminDataSqlRunResult | null }) {
  if (result == null) return null;

  const columns: TableColumnsType<ResultRow> = result.columns.map((column) => ({
    title: column,
    dataIndex: column,
    key: column,
    render: renderCellValue,
  }));
  const dataSource = result.rows.map((row, index) => ({ key: index, ...row }));

  return (
    <Card
      title="Results"
      extra={
        <Space wrap>
          <Tag>{result.row_count.toLocaleString()} rows</Tag>
          <Tag>{result.duration_ms}ms</Tag>
          <Tag>{formatBytes(result.response_bytes)}</Tag>
          {result.truncated ? <Tag color="orange">truncated</Tag> : null}
        </Space>
      }
    >
      <Table
        bordered
        columns={columns}
        dataSource={dataSource}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        scroll={{ x: "max-content" }}
        size="small"
      />
    </Card>
  );
}

function Catalog({
  datasets,
  views,
  loadView,
  runView,
  deleteView,
}: {
  datasets: AdminDataDataset[];
  views: AdminDataViewSummary[];
  loadView: (view: AdminDataViewSummary) => void;
  runView: (view: AdminDataViewSummary) => void;
  deleteView: (view: AdminDataViewSummary) => void;
}) {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" title="Shared Views">
        {views.length === 0 ? (
          <Text type="secondary">No shared views are defined yet.</Text>
        ) : (
          <Space direction="vertical" style={{ width: "100%" }}>
            {views.map((view) => (
              <Card
                key={view.id}
                size="small"
                title={
                  <Flex align="center" gap="small" wrap>
                    <span>{view.title}</span>
                    <Tag>{view.query_kind}</Tag>
                    <Tag>{summarizeScope(view)}</Tag>
                  </Flex>
                }
                extra={
                  <Space>
                    <Button size="small" onClick={() => loadView(view)}>
                      Open
                    </Button>
                    {view.query_kind === "sql" ? (
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => runView(view)}
                      >
                        Run
                      </Button>
                    ) : null}
                    <Popconfirm
                      title="Delete shared view?"
                      description={`Delete "${view.title}" from the shared admin catalog?`}
                      okText="Delete"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => deleteView(view)}
                    >
                      <Button danger size="small">
                        Delete
                      </Button>
                    </Popconfirm>
                  </Space>
                }
              >
                <Space direction="vertical" size={4}>
                  <Text code>{view.slug}</Text>
                  {view.description ? (
                    <Text type="secondary">{view.description}</Text>
                  ) : null}
                  {view.tags.length ? (
                    <Space wrap size={[0, 4]}>
                      {view.tags.map((tag) => (
                        <Tag key={`${view.id}-${tag}`}>{tag}</Tag>
                      ))}
                    </Space>
                  ) : null}
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Card>
      <Card size="small" title="Datasets">
        {datasets.length === 0 ? (
          <Text type="secondary">No datasets are registered yet.</Text>
        ) : (
          <Space direction="vertical" style={{ width: "100%" }}>
            {datasets.map((dataset) => (
              <Card key={dataset.id} size="small" title={dataset.title}>
                <Space direction="vertical" size={4}>
                  <Text code>{dataset.id}</Text>
                  <Text type="secondary">{dataset.description}</Text>
                  <Space wrap size={[0, 4]}>
                    <Tag>{dataset.source}</Tag>
                    <Tag>default {dataset.default_limit}</Tag>
                    <Tag>max {dataset.max_limit}</Tag>
                    {dataset.scope_kinds.map((scope) => (
                      <Tag key={`${dataset.id}-${scope}`}>{scope}</Tag>
                    ))}
                  </Space>
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}

export function AdminDataExplorer() {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [datasets, setDatasets] = useState<AdminDataDataset[]>([]);
  const [views, setViews] = useState<AdminDataViewSummary[]>([]);
  const [selectedView, setSelectedView] = useState<AdminDataView | null>(null);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [limit, setLimit] = useState<number>(
    ADMIN_DATA_EXPLORER_SQL_CONSTRAINTS.default_limit,
  );
  const [viewSlug, setViewSlug] = useState("recent-accounts");
  const [viewTitle, setViewTitle] = useState("Recent Accounts");
  const [viewDescription, setViewDescription] = useState("");
  const [viewTags, setViewTags] = useState("accounts");
  const [importJson, setImportJson] = useState("");
  const [validation, setValidation] =
    useState<AdminDataSqlValidationResult | null>(null);
  const [result, setResult] = useState<AdminDataSqlRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    closeBeforeRetry: true,
    onUnhandledError: (err) => setError(`${err}`),
  });

  async function loadCatalog() {
    setLoading(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const hub = getHub();
        const opts = { browser_id: browserId() };
        const [nextDatasets, nextViews] = await Promise.all([
          hub.adminData.listDatasets(opts),
          hub.adminData.listViews(opts),
        ]);
        setDatasets(nextDatasets);
        setViews(nextViews);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  async function validateSql() {
    setRunning(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const nextValidation = await getHub().adminData.validateSql({
          browser_id: browserId(),
          sql,
          limit,
        });
        setValidation(nextValidation);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRunning(false);
    }
  }

  async function runSql() {
    setRunning(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const nextResult = await getHub().adminData.runSql({
          browser_id: browserId(),
          sql,
          limit,
        });
        setValidation(nextResult.validation);
        setResult(nextResult);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRunning(false);
    }
  }

  async function runSavedView(view: AdminDataViewSummary) {
    setRunning(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const nextRun = await getHub().adminData.runView({
          browser_id: browserId(),
          id: view.id,
          limit,
        });
        setValidation(nextRun.result.validation);
        setResult(nextRun.result);
        message.success(`Ran view "${nextRun.view.title}".`);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRunning(false);
    }
  }

  async function openView(view: AdminDataViewSummary) {
    setLoading(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const nextView = await getHub().adminData.getView({
          browser_id: browserId(),
          id: view.id,
        });
        const nextSql = sqlFromView(nextView);
        setSelectedView(nextView);
        setViewSlug(nextView.slug);
        setViewTitle(nextView.title);
        setViewDescription(nextView.description ?? "");
        setViewTags(nextView.tags.join(", "));
        setLimit(
          nextView.default_limit ??
            ADMIN_DATA_EXPLORER_SQL_CONSTRAINTS.default_limit,
        );
        if (nextSql != null) {
          setSql(nextSql);
          setValidation(null);
          setResult(null);
        }
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveView() {
    setSaving(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const saved = await getHub().adminData.saveView({
          browser_id: browserId(),
          view: {
            id: selectedView?.id,
            slug: viewSlug.trim(),
            title: viewTitle.trim(),
            description: viewDescription.trim() || null,
            tags: viewTags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
            query_kind: "sql",
            query: { sql },
            scope: { kind: "local" },
            default_limit: limit,
            visualization: "table",
          },
        });
        setSelectedView(saved);
        message.success("Saved admin data view.");
        await loadCatalog();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSavedView(view: AdminDataViewSummary) {
    setLoading(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const deleted = await getHub().adminData.deleteView({
          browser_id: browserId(),
          id: view.id,
        });
        if (selectedView?.id === view.id) {
          setSelectedView(null);
        }
        message.success(
          deleted.deleted
            ? `Deleted view "${view.title}".`
            : `View "${view.title}" was already gone.`,
        );
        await loadCatalog();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  async function exportViews() {
    setSaving(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const exported = await getHub().adminData.exportViews({
          browser_id: browserId(),
        });
        downloadJson("admin-data-views.json", exported);
        message.success(`Exported ${exported.views.length} admin data views.`);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function importViewsFromText(raw: string) {
    setSaving(true);
    setError("");
    try {
      const parsed = JSON.parse(raw) as
        | AdminDataViewInput[]
        | AdminDataViewExport;
      await runFreshAuthAction(async () => {
        const imported = await getHub().adminData.importViews({
          browser_id: browserId(),
          views: parsed,
          mode: "upsert",
        });
        message.success(
          `Imported ${imported.created} created, ${imported.updated} updated, ${imported.skipped} skipped views.`,
        );
        setImportJson("");
        await loadCatalog();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function importViewsFromFile(file: File | null | undefined) {
    if (!file) return;
    try {
      await importViewsFromText(await file.text());
    } catch (err) {
      setError(`${err}`);
    }
  }

  const constraints = ADMIN_DATA_EXPLORER_SQL_CONSTRAINTS;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="Admin Data Explorer is fresh-auth protected and audited."
        description="This first version supports shared admin SQL views through the same restricted SQL RPCs used by cocalc-cli. SQL must be read-only, single-statement, relation allowlisted, and bounded by server-side limits."
      />
      {error ? (
        <ErrorDisplay error={error} onClose={() => setError("")} />
      ) : null}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Card
              title="Restricted SQL"
              extra={
                <Space>
                  <Button onClick={validateSql} loading={running}>
                    Validate
                  </Button>
                  <Button type="primary" onClick={runSql} loading={running}>
                    Run
                  </Button>
                </Space>
              }
            >
              <Form layout="vertical">
                <Form.Item label="SQL">
                  <TextArea
                    value={sql}
                    onChange={(e) => setSql(e.target.value)}
                    autoSize={{ minRows: 10, maxRows: 24 }}
                    spellCheck={false}
                  />
                </Form.Item>
                <Form.Item label="Limit">
                  <InputNumber
                    min={1}
                    max={constraints.max_limit}
                    value={limit}
                    onChange={(value) =>
                      setLimit(
                        typeof value === "number"
                          ? value
                          : constraints.default_limit,
                      )
                    }
                  />
                </Form.Item>
              </Form>
              <ValidationSummary validation={validation} />
            </Card>
            <ResultTable result={result} />
          </Space>
        </Col>
        <Col xs={24} xl={8}>
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Card
              title="Save Current SQL View"
              extra={
                <Button type="primary" onClick={saveView} loading={saving}>
                  Save
                </Button>
              }
            >
              <Form layout="vertical">
                <Form.Item label="Slug">
                  <Input
                    value={viewSlug}
                    onChange={(e) => setViewSlug(e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Title">
                  <Input
                    value={viewTitle}
                    onChange={(e) => setViewTitle(e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Description">
                  <Input
                    value={viewDescription}
                    onChange={(e) => setViewDescription(e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Tags">
                  <Input
                    value={viewTags}
                    placeholder="comma, separated, tags"
                    onChange={(e) => setViewTags(e.target.value)}
                  />
                </Form.Item>
              </Form>
            </Card>
            <Card
              title="Import / Export Views"
              extra={
                <Space>
                  <Button onClick={exportViews} loading={saving}>
                    Export JSON
                  </Button>
                  <Button
                    type="primary"
                    onClick={() => importInputRef.current?.click()}
                    loading={saving}
                  >
                    Upload JSON
                  </Button>
                </Space>
              }
            >
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text type="secondary">
                  Upload accepts the same JSON produced by the CLI or Export
                  button. Paste import is also available for quick operator and
                  Codex-assisted workflows. Imports use upsert mode.
                </Text>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] ?? null;
                    event.currentTarget.value = "";
                    void importViewsFromFile(file);
                  }}
                />
                <TextArea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder='{"schema_version":1,"views":[...]}'
                  autoSize={{ minRows: 4, maxRows: 12 }}
                  spellCheck={false}
                />
                <Button
                  onClick={() => importViewsFromText(importJson)}
                  disabled={!importJson.trim()}
                  loading={saving}
                >
                  Import Pasted JSON
                </Button>
              </Space>
            </Card>
            <Card title="SQL Guardrails">
              <Space direction="vertical" style={{ width: "100%" }}>
                <Paragraph type="secondary">
                  Defaults: limit {constraints.default_limit}, timeout{" "}
                  {constraints.default_timeout_ms}ms, response cap{" "}
                  {formatBytes(constraints.default_max_bytes)}.
                </Paragraph>
                <Paragraph type="secondary">
                  Maximums: limit {constraints.max_limit}, timeout{" "}
                  {constraints.max_timeout_ms}ms, response cap{" "}
                  {formatBytes(constraints.max_bytes)}.
                </Paragraph>
                <Divider style={{ margin: "8px 0" }} />
                <Text strong>Allowed relations</Text>
                <Space wrap size={[0, 4]}>
                  {constraints.allowed_relations.map((relation) => (
                    <Tag key={relation} color="blue">
                      {relation}
                    </Tag>
                  ))}
                </Space>
                <Text strong>Allowed functions</Text>
                <Space wrap size={[0, 4]}>
                  {constraints.allowed_functions.map((fn) => (
                    <Tag key={fn}>{fn}()</Tag>
                  ))}
                </Space>
              </Space>
            </Card>
            {loading ? (
              <Card>
                <Loading />
              </Card>
            ) : (
              <Catalog
                datasets={datasets}
                views={views}
                loadView={openView}
                runView={runSavedView}
                deleteView={deleteSavedView}
              />
            )}
          </Space>
        </Col>
      </Row>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
