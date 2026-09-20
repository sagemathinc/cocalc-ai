/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Popover,
  Select,
  Space,
  Table,
  Typography,
} from "antd";
import type { ComputeFundingApi } from "@cocalc/conat/hub/api/compute-funding";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import { moneyToCurrency } from "@cocalc/util/money";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { uuid } from "@cocalc/util/misc";
import { Icon } from "@cocalc/frontend/components/icon";
import type { PanelProps } from "@cocalc/frontend/frame-editors/course-editor/course-panel-wrapper";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  allocationDraft,
  budgetCsv,
  budgetStudents,
  localDateTime,
} from "./compute-budget-model";
import { CourseVmRecommendationsEditor } from "./course-vm-recommendations";
import { ComputePoolManagement } from "./compute-pool-management";
import { usableCeiling } from "./compute-pool-management-model";
import { FinancialApprovalLink } from "@cocalc/frontend/purchases/financial-approval-link";
import { SponsoredComputeReminder } from "@cocalc/frontend/account/low-credit-notification-setting";
import HelpPopover from "./common/help-popover";

type Summary = Awaited<ReturnType<ComputeFundingApi["getCourseSummary"]>>;
type Preview = Awaited<ReturnType<ComputeFundingApi["previewAllocation"]>>;
type Intent = Awaited<ReturnType<ComputeFundingApi["proposeAllocation"]>>;

function BudgetColumnTitle({
  title,
  explanation,
}: {
  title: string;
  explanation: string;
}) {
  return (
    <Space size={2} wrap={false}>
      <span>{title}</span>
      <HelpPopover
        ariaLabel={`Explain ${title}`}
        title={title}
        content={explanation}
      />
    </Space>
  );
}

export function ComputeBudgetPanel(props: PanelProps) {
  const courseId = props.settings.get("course_id");
  useEffect(() => {
    if (!courseId) props.actions.ensure_course_id();
  }, [courseId, props.actions]);
  if (!courseId)
    return (
      <Alert type="warning" title="Course identity is not available yet." />
    );
  return (
    <ComputeBudget
      key={`${props.project_id}:${courseId}`}
      course_project_id={props.project_id}
      course_instance_id={courseId}
      students={budgetStudents(props.students)}
      api={webapp_client.conat_client.hub.computeFunding}
    />
  );
}

export function ComputeBudget({
  course_project_id,
  course_instance_id,
  students,
  api,
}: {
  course_project_id: string;
  course_instance_id: string;
  students: ReturnType<typeof budgetStudents>;
  api: ComputeFundingApi;
}) {
  const [form] = Form.useForm();
  const [selected, setSelected] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary>();
  const [preview, setPreview] = useState<Preview>();
  const [intent, setIntent] = useState<Intent>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const intentRef = useRef(intent);
  intentRef.current = intent;
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const defaults = useMemo(
    () => ({
      per_student_usd: "50",
      lane: "prepaid",
      starts_at: localDateTime(new Date()),
      ends_at: localDateTime(new Date(Date.now() + 7 * 86400_000)),
      allow_overcommit: false,
    }),
    [],
  );

  useEffect(() => {
    let active = true;
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const value = await api.getCourseSummary({
          course_project_id,
          course_instance_id,
        });
        if (!active) return;
        setSummary(value);
        setSummaryError("");
        const pending = intentRef.current;
        if (pending?.status === "pending") {
          const next = await api.getAllocationStatus({ intent_id: pending.id });
          if (active && intentRef.current?.id === pending.id) setIntent(next);
        }
      } catch (err) {
        if (active)
          setSummaryError(String(err instanceof Error ? err.message : err));
      } finally {
        fetching = false;
      }
    }
    refreshRef.current = refresh;
    void refresh();
    const interval = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 15_000);
    return () => {
      active = false;
      generation.current++;
      clearInterval(interval);
    };
  }, [api, course_project_id, course_instance_id]);

  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);

  function invalidatePreview() {
    generation.current++;
    setPreview(undefined);
    setError("");
    setBusy(false);
  }

  async function previewAllocation(values: {
    per_student_usd: string;
    lane: CourseFundingDraft["lane"];
    starts_at: string;
    ends_at: string;
    allow_overcommit: boolean;
    pool_usd?: string;
  }) {
    if (summary?.sponsorship?.available !== true) return;
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const terms = allocationDraft({
        ...values,
        course_project_id,
        course_instance_id,
        students,
        selected,
        pool_usd: values.allow_overcommit ? values.pool_usd : undefined,
      });
      const result = await api.previewAllocation({ terms });
      if (generation.current === version) setPreview(result);
    } catch (err) {
      if (generation.current === version)
        setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }

  const operation = useRef<{ terms: string; id: string } | undefined>(
    undefined,
  );
  async function propose() {
    if (
      !preview ||
      busy ||
      summary?.sponsorship?.available !== true ||
      summary.financial_approval?.state !== "ready"
    )
      return;
    const version = ++generation.current;
    const terms = JSON.stringify(preview.terms);
    if (operation.current?.terms !== terms)
      operation.current = { terms, id: uuid() };
    setBusy(true);
    setError("");
    try {
      const result = await api.proposeAllocation({
        operation_id: operation.current.id,
        terms: preview.terms,
      });
      if (generation.current === version) {
        setIntent(result);
        setPreview(undefined);
      }
    } catch (err) {
      if (generation.current === version)
        setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }

  function exportSummary() {
    if (!summary) return;
    const rows: Array<Array<string | number>> = [
      [
        "Pool",
        "Student account",
        "State",
        "Allocated USD",
        "Spent USD",
        "Reserved USD",
        "Returned USD",
        "As of",
      ],
    ];
    for (const pool of summary.pools)
      for (const grant of pool.grants)
        rows.push([
          pool.id,
          grant.beneficiary_account_id,
          grant.state,
          grant.authorized_usd,
          grant.spent_usd,
          grant.reserved_usd,
          grant.released_usd,
          summary.as_of,
        ]);
    const url = URL.createObjectURL(
      new Blob([budgetCsv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "course-compute-budget.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const pending = intent?.status === "pending";
  const financialApprovalReady = summary?.financial_approval?.state === "ready";
  const stale = summary && now - Date.parse(summary.as_of) > 45_000;
  return (
    <div
      className="smc-vfill"
      style={{
        overflowY: "auto",
        paddingBottom: 24,
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <Space
        wrap
        style={{
          justifyContent: "space-between",
          width: "100%",
          marginBottom: 12,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          Compute budget
        </Typography.Title>
        <Space wrap style={{ maxWidth: "100%" }}>
          <Button
            icon={<Icon name="refresh" />}
            onClick={() => void refreshRef.current()}
          >
            Refresh
          </Button>
          <Button
            icon={<Icon name="download" />}
            disabled={!summary?.pools.length}
            onClick={exportSummary}
          >
            Export CSV
          </Button>
        </Space>
      </Space>
      {summaryError && <Alert type="error" showIcon title={summaryError} />}
      {summary && summary.sponsorship?.available !== true && (
        <Alert
          type="warning"
          showIcon
          title={
            summary.sponsorship?.enabled === false
              ? "Course-funded compute is not available on this site"
              : "Course-funded compute is temporarily unavailable"
          }
          description={
            summary.sponsorship?.enabled === false
              ? "You can configure VM recommendations, but instructors cannot allocate course credit until this service is enabled."
              : "CoCalc could not verify that course credit can be allocated safely. Try again later or contact support."
          }
        />
      )}
      {summary?.sponsorship?.available === true && !financialApprovalReady && (
        <Alert
          type="warning"
          showIcon
          title="Secure financial authorization is not ready"
          description={
            summary.financial_approval?.reason ??
            "An administrator must finish configuring the secure authorization service before new course credit can be allocated."
          }
        />
      )}
      {stale && (
        <Alert
          type="warning"
          showIcon
          title="Budget information is out of date."
        />
      )}
      {summary && (
        <Typography.Paragraph type="secondary">
          Updated {new Date(summary.as_of).toLocaleString()}
        </Typography.Paragraph>
      )}
      <section
        aria-label="Sponsored compute alerts"
        style={{ marginBottom: 16 }}
      >
        <Typography.Title level={5}>Spending alert</Typography.Title>
        <SponsoredComputeReminder />
      </section>
      {summary?.pools.map((pool) => (
        <section
          key={pool.id}
          aria-label="Allocated compute budget"
          style={{ marginBottom: 24 }}
        >
          <Typography.Title level={5}>
            {moneyToCurrency(usableCeiling(pool))} {pool.lane} budget
          </Typography.Title>
          <p>
            {pool.state} · {new Date(pool.starts_at).toLocaleString()} to{" "}
            {new Date(pool.ends_at).toLocaleString()}
          </p>
          <p>
            Spent {moneyToCurrency(pool.spent_usd)} · Reserved{" "}
            {moneyToCurrency(pool.reserved_usd)} · Returned{" "}
            {moneyToCurrency(pool.released_usd)}
          </p>
          <div style={{ color: UI_COLORS.secondary, marginBottom: 16 }}>
            <div>Secure authorizations:</div>
            <ul style={{ marginBlock: 4 }}>
              {(
                pool.approval_rectangles ?? [
                  {
                    amount_usd: pool.approval_limit_usd,
                    starts_at: pool.approval_starts_at,
                    ends_at: pool.approval_ends_at,
                  },
                ]
              ).map((approval, index) => (
                <li
                  key={`${approval.amount_usd}-${approval.starts_at}-${approval.ends_at}-${index}`}
                >
                  Up to {moneyToCurrency(approval.amount_usd)} from{" "}
                  {new Date(approval.starts_at).toLocaleString()} through{" "}
                  {new Date(approval.ends_at).toLocaleString()}
                </li>
              ))}
            </ul>
            Changes covered by one of these authorizations do not require
            another secure authorization.
          </div>
          <div
            role="region"
            aria-label="Student budget details"
            tabIndex={0}
            style={{ overflowX: "auto", maxWidth: "100%" }}
          >
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={pool.grants}
              style={{ minWidth: 1050 }}
              columns={[
                {
                  title: "Student",
                  dataIndex: "beneficiary_account_id",
                  render: (id: string) =>
                    students.find((student) => student.account_id === id)
                      ?.name ?? id,
                },
                { title: "Status", dataIndex: "state" },
                {
                  title: "Running VMs",
                  render: (_, grant) => grant.running_vms ?? "Unknown",
                },
                {
                  title: "Usage observed",
                  render: (_, grant) =>
                    grant.usage_as_of
                      ? new Date(grant.usage_as_of).toLocaleString()
                      : "Unknown",
                },
                {
                  title: "Observed hourly cost",
                  render: (_, grant) =>
                    grant.hourly_usd === undefined
                      ? "Unknown"
                      : moneyToCurrency(grant.hourly_usd),
                },
                {
                  title: (
                    <BudgetColumnTitle
                      title="Projected funding cutoff"
                      explanation="When the student's currently running VMs are projected to exhaust their usable course funding at the observed hourly cost. This estimate can move as usage changes and is also capped by funding-window and course-budget end dates."
                    />
                  ),
                  render: (_, grant) =>
                    grant.forecast_exhausts_at
                      ? new Date(grant.forecast_exhausts_at).toLocaleString()
                      : "Unknown",
                },
                ...(
                  [
                    [
                      "Allocated",
                      "authorized_usd",
                      "The total course credit assigned to this student for this funding grant.",
                    ],
                    [
                      "Spent",
                      "spent_usd",
                      "Course credit already charged for the student's finalized compute usage.",
                    ],
                    [
                      "Reserved",
                      "reserved_usd",
                      "Credit committed to active VMs, retained storage, and bounded network usage but not yet finalized as spent. Reserved credit is not available to start additional resources.",
                    ],
                    [
                      "Returned",
                      "released_usd",
                      "Credit released from this student back to the course pool. It is no longer available to this student unless allocated again.",
                    ],
                  ] as const
                ).map(([title, dataIndex, explanation]) => ({
                  title: (
                    <BudgetColumnTitle
                      title={title}
                      explanation={explanation}
                    />
                  ),
                  dataIndex,
                  render: (value: string) => moneyToCurrency(value),
                })),
              ]}
            />
          </div>
          <ComputePoolManagement
            pool={pool}
            course_project_id={course_project_id}
            course_instance_id={course_instance_id}
            students={students}
            api={api}
            financialApproval={summary.financial_approval}
            onUpdated={() => refreshRef.current()}
          />
        </section>
      ))}
      {intent && (
        <div role="status" aria-live="polite" style={{ marginBottom: 16 }}>
          <Alert
            type={
              intent.status === "approved"
                ? "success"
                : intent.status === "rejected"
                  ? "error"
                  : "warning"
            }
            showIcon
            title={
              intent.status === "approved"
                ? "Course budget authorized"
                : intent.status === "pending"
                  ? "Authorization required"
                  : intent.status === "expired"
                    ? "Authorization expired"
                    : "Authorization rejected"
            }
            description={
              pending && intent.approval_url ? (
                <FinancialApprovalLink
                  approvalUrl={intent.approval_url}
                  buttonProps={{ type: "primary" }}
                >
                  Authorize
                </FinancialApprovalLink>
              ) : undefined
            }
          />
        </div>
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={defaults}
        onValuesChange={invalidatePreview}
        onFinish={previewAllocation}
        disabled={pending || summary?.sponsorship?.available !== true}
      >
        <Typography.Title level={5}>Allocate credit</Typography.Title>
        <Table
          rowKey="id"
          size="small"
          dataSource={students}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => {
              setSelected(keys.map(String));
              invalidatePreview();
            },
            getCheckboxProps: (student) => ({
              disabled:
                pending ||
                summary?.sponsorship?.available !== true ||
                !student.account_id,
              "aria-label": `Select ${student.name}`,
            }),
          }}
          columns={[
            { title: "Student", dataIndex: "name" },
            {
              title: "Account",
              render: (_, student) =>
                student.account_id
                  ? (student.email ?? "Account linked")
                  : "Waiting for student to join the course",
            },
          ]}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: "0 16px",
            marginTop: 16,
          }}
        >
          <Form.Item
            name="per_student_usd"
            label="Credit per student (USD)"
            rules={[{ required: true }]}
          >
            <InputNumber
              stringMode
              min="0.01"
              precision={2}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item name="lane" label="Funding" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "prepaid", label: "My prepaid credit" },
                { value: "postpaid", label: "My approved postpaid credit" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="starts_at"
            label="Starts (local time)"
            rules={[{ required: true }]}
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item
            name="ends_at"
            label="Ends (local time)"
            rules={[{ required: true }]}
          >
            <Input type="datetime-local" />
          </Form.Item>
        </div>
        <Form.Item name="allow_overcommit" valuePropName="checked">
          <Checkbox>Allow overcommit</Checkbox>
        </Form.Item>
        <Form.Item
          noStyle
          shouldUpdate={(before, after) =>
            before.allow_overcommit !== after.allow_overcommit
          }
        >
          {({ getFieldValue }) =>
            getFieldValue("allow_overcommit") ? (
              <>
                <Alert
                  type="warning"
                  showIcon
                  title="DANGER: not every student can use their full allowance."
                />
                <Form.Item
                  name="pool_usd"
                  label="Total backing (USD)"
                  rules={[{ required: true }]}
                >
                  <InputNumber stringMode min="0.01" precision={2} />
                </Form.Item>
              </>
            ) : null
          }
        </Form.Item>
        <Button
          htmlType="submit"
          type="primary"
          icon={<Icon name="eye" />}
          loading={busy}
          disabled={
            pending ||
            summary?.sponsorship?.available !== true ||
            !selected.length
          }
        >
          Preview allocation
        </Button>
      </Form>
      {error && (
        <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />
      )}
      {preview && (
        <section aria-label="Allocation preview" style={{ marginTop: 20 }}>
          <h4 tabIndex={-1} ref={previewHeading}>
            Allocation preview
          </h4>
          <p>
            {moneyToCurrency(preview.terms.amount_usd)} reserved from your{" "}
            {preview.terms.lane} credit;{" "}
            {moneyToCurrency(preview.available_backing_usd)} available before
            allocation.
          </p>
          <p>
            {new Date(preview.terms.starts_at).toLocaleString()} to{" "}
            {new Date(preview.terms.ends_at).toLocaleString()} (
            {Intl.DateTimeFormat().resolvedOptions().timeZone})
          </p>
          <ul>
            {preview.recipients.map((recipient) => (
              <li key={recipient.beneficiary_account_id}>
                {recipient.display_name}
                {recipient.email_address ? ` (${recipient.email_address})` : ""}
              </li>
            ))}
          </ul>
          <Alert
            type="warning"
            showIcon
            title="VM data is not backed up automatically."
            description={
              <Popover
                trigger="click"
                title="When a student's course credit runs out"
                content={
                  <div style={{ maxWidth: 440 }}>
                    <p>
                      A sponsored VM cannot start unless the student's unused
                      allowance can cover its initial running cost and reserve
                      the full cost of its boot disk for <strong>3 days</strong>{" "}
                      after compute stops.
                    </p>
                    <p>
                      CoCalc stops sponsored compute before it can spend the
                      storage reserve. The stopped boot disk is then retained
                      until its displayed deletion deadline, unless the student
                      deletes it sooner or explicitly switches to their own
                      funding.
                    </p>
                    <p style={{ marginBottom: 0 }}>
                      When retention ends, the VM and its boot-disk software and
                      data are permanently deleted. Notebooks and saved outputs
                      in the CoCalc project remain. VM files are not backed up
                      automatically.
                    </p>
                  </div>
                }
              >
                <Button type="link" style={{ height: "auto", padding: 0 }}>
                  What happens when the student runs out of money?
                </Button>
              </Popover>
            }
            style={{ marginBottom: 12 }}
          />
          <Typography.Paragraph>
            No credit is allocated yet. Continue to a separate page to review
            and authorize this allocation.
          </Typography.Paragraph>
          <Button
            type="primary"
            icon={<Icon name="external-link" />}
            loading={busy}
            disabled={
              summary?.sponsorship?.available !== true ||
              !financialApprovalReady
            }
            onClick={() => void propose()}
          >
            Authorize
          </Button>
        </section>
      )}
      <CourseVmRecommendationsEditor
        key={`${course_project_id}:${course_instance_id}`}
        course_project_id={course_project_id}
        course_instance_id={course_instance_id}
        api={api}
      />
    </div>
  );
}
