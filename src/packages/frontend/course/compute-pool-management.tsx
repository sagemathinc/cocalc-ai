import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Space,
  Table,
  Typography,
} from "antd";
import type {
  ComputeFundingApi,
  CourseFundingAllocationStatus,
  CourseFundingPoolChangePreview,
  CourseFundingPoolSummary,
  FundingApprovalReadiness,
} from "@cocalc/conat/hub/api/compute-funding";
import { Icon } from "@cocalc/frontend/components/icon";
import { FinancialApprovalLink } from "@cocalc/frontend/purchases/financial-approval-link";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { uuid } from "@cocalc/util/misc";
import {
  moneyToCurrency,
  moneyToDbString,
  toDecimal,
} from "@cocalc/util/money";
import { localDateTime } from "./compute-budget-model";
import type { BudgetStudent } from "./compute-budget-model";
import {
  poolChangeDraft,
  usableCeiling,
} from "./compute-pool-management-model";

type Action = "revise" | "revoke" | "close";
type Api = Pick<
  ComputeFundingApi,
  "previewPoolChange" | "proposePoolChange" | "getAllocationStatus"
>;

export function ComputePoolManagement({
  pool,
  course_project_id,
  course_instance_id,
  students,
  api,
  onUpdated,
  financialApproval,
  pollIntervalMs = 5000,
}: {
  pool: CourseFundingPoolSummary;
  course_project_id: string;
  course_instance_id: string;
  students: BudgetStudent[];
  api: Api;
  onUpdated: () => Promise<void>;
  financialApproval?: FundingApprovalReadiness;
  pollIntervalMs?: number;
}) {
  const [snapshot, setSnapshot] = useState(pool);
  const [action, setAction] = useState<Action>();
  const [amount, setAmount] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState("");
  const [preview, setPreview] = useState<CourseFundingPoolChangePreview>();
  const [intent, setIntent] = useState<CourseFundingAllocationStatus>();
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const operation = useRef<{ terms: string; id: string } | undefined>(
    undefined,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const statusRegion = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const updated = useRef(onUpdated);
  updated.current = onUpdated;
  const pending = intent?.status === "pending";
  const stale = action !== undefined && pool.version !== snapshot.version;
  const editable =
    !!pool.version && ["active", "scheduled", "suspended"].includes(pool.state);
  const name = (id: string) =>
    students.find((s) => s.account_id === id)?.name ?? id;

  useEffect(() => {
    if (action) heading.current?.focus();
    else if (!pending) opener.current?.focus();
  }, [action, pending]);
  useEffect(() => {
    if (intent) statusRegion.current?.focus();
  }, [intent?.id]);
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!pending || !intent) return;
    let active = true,
      fetching = false;
    const id = intent.id;
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const result = await api.getAllocationStatus({ intent_id: id });
        if (!active) return;
        setIntent(result);
        setStatusError("");
        if (result.status === "approved") await updated.current();
      } catch (err) {
        if (active)
          setStatusError(String(err instanceof Error ? err.message : err));
      } finally {
        fetching = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), pollIntervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, pending, intent?.id, pollIntervalMs]);

  function invalidate() {
    generation.current++;
    setPreview(undefined);
    setError("");
    setBusy(false);
  }
  function open(next: Action) {
    opener.current = document.activeElement as HTMLElement;
    invalidate();
    operation.current = undefined;
    setIntent(undefined);
    setSnapshot(pool);
    setAmount(usableCeiling(pool));
    setStarts(localDateTime(new Date(pool.starts_at)));
    setEnds(localDateTime(new Date(pool.ends_at)));
    setAmounts(
      Object.fromEntries(pool.grants.map((g) => [g.id, usableCeiling(g)])),
    );
    setSelected([]);
    setBulk("");
    setAction(next);
  }
  function cancel() {
    invalidate();
    setAction(undefined);
    opener.current?.focus();
  }
  async function review() {
    if (!action || stale || busy) return;
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const terms = poolChangeDraft({
        pool: snapshot,
        action,
        amount,
        starts,
        ends,
        amounts,
        selected,
        course_project_id,
        course_instance_id,
      });
      const result = await api.previewPoolChange({ terms });
      if (generation.current === version) setPreview(result);
    } catch (err) {
      if (generation.current === version)
        setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  async function propose() {
    if (
      !preview ||
      busy ||
      stale ||
      (preview.requires_financial_approval &&
        financialApproval?.state !== "ready")
    )
      return;
    const version = ++generation.current,
      terms = JSON.stringify(preview.terms);
    if (operation.current?.terms !== terms)
      operation.current = { terms, id: uuid() };
    setBusy(true);
    setError("");
    try {
      const result = await api.proposePoolChange({
        terms: preview.terms,
        operation_id: operation.current.id,
      });
      if (generation.current !== version) return;
      setIntent(result);
      setAction(undefined);
      setPreview(undefined);
      opener.current?.focus();
      if (result.status === "approved") await updated.current();
    } catch (err) {
      if (generation.current === version)
        setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  const studentTotal = snapshot.grants.reduce(
    (sum, g) => sum.plus(amounts[g.id] || "0"),
    toDecimal(0),
  );
  return (
    <div style={{ marginTop: 12 }}>
      <Space wrap>
        <Button
          icon={<Icon name="pencil" />}
          disabled={!editable || pending || !!action}
          onClick={() => open("revise")}
        >
          Adjust budget
        </Button>
        <Button
          icon={<Icon name="ban" />}
          disabled={!editable || pending || !!action}
          onClick={() => open("revoke")}
        >
          Revoke grants
        </Button>
        <Button
          danger
          icon={<Icon name="stop" />}
          disabled={!editable || pending || !!action}
          onClick={() => open("close")}
        >
          Close pool
        </Button>
      </Space>
      {intent && (
        <div
          role="status"
          aria-live="polite"
          tabIndex={-1}
          ref={statusRegion}
          style={{ marginTop: 12 }}
        >
          <Alert
            showIcon
            type={
              intent.status === "approved"
                ? "success"
                : intent.status === "rejected"
                  ? "error"
                  : "warning"
            }
            title={
              intent.status === "approved"
                ? "Pool updated"
                : intent.status === "pending"
                  ? "Authorization required"
                  : intent.status === "expired"
                    ? "Authorization expired"
                    : "Authorization rejected"
            }
            description={
              <>
                {pending && intent.approval_url && (
                  <FinancialApprovalLink
                    approvalUrl={intent.approval_url}
                    buttonProps={{ type: "primary" }}
                  >
                    Authorize
                  </FinancialApprovalLink>
                )}
              </>
            }
          />
        </div>
      )}
      {statusError && <Alert type="error" showIcon title={statusError} />}
      {action && (
        <KeyboardBoundary
          boundary="course-pool-management"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.stopPropagation();
              cancel();
            }
          }}
        >
          <section aria-label="Pool management" style={{ marginTop: 16 }}>
            <h4 tabIndex={-1} ref={heading}>
              {action === "close"
                ? "Close pool"
                : action === "revoke"
                  ? "Revoke student grants"
                  : "Adjust pool budget"}
            </h4>
            {stale && (
              <Alert
                type="warning"
                showIcon
                title="The pool changed. Cancel and reopen to review current totals."
              />
            )}
            {action === "close" ? (
              <Alert
                type="warning"
                showIcon
                title="New spending will stop. Unused credit returns to your balance; outstanding VM and storage costs remain reserved until settled."
              />
            ) : (
              <>
                {action === "revise" && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
                      gap: 12,
                    }}
                  >
                    <label>
                      Total pool ceiling (USD)
                      <InputNumber
                        aria-label="Total pool ceiling (USD)"
                        stringMode
                        precision={2}
                        min="0.01"
                        value={amount}
                        onChange={(value) => {
                          setAmount(String(value ?? ""));
                          invalidate();
                        }}
                        style={{ width: "100%" }}
                      />
                    </label>
                    <label>
                      Pool starts (local time)
                      <Input
                        type="datetime-local"
                        aria-label="Pool starts (local time)"
                        value={starts}
                        onChange={(e) => {
                          setStarts(e.target.value);
                          invalidate();
                        }}
                      />
                    </label>
                    <label>
                      Pool ends (local time)
                      <Input
                        type="datetime-local"
                        aria-label="Pool ends (local time)"
                        value={ends}
                        onChange={(e) => {
                          setEnds(e.target.value);
                          invalidate();
                        }}
                      />
                    </label>
                  </div>
                )}
                {action === "revise" && (
                  <Space wrap style={{ margin: "12px 0" }}>
                    <label>
                      Selected student ceiling (USD)
                      <InputNumber
                        aria-label="Selected student ceiling (USD)"
                        stringMode
                        precision={2}
                        min="0.01"
                        value={bulk}
                        onChange={(v) => setBulk(String(v ?? ""))}
                      />
                    </label>
                    <Button
                      disabled={!selected.length || !bulk}
                      onClick={() => {
                        setAmounts((old) => ({
                          ...old,
                          ...Object.fromEntries(
                            selected.map((id) => [id, bulk]),
                          ),
                        }));
                        invalidate();
                      }}
                    >
                      Apply to selected
                    </Button>
                    <Button
                      onClick={() => {
                        setAmount(moneyToDbString(studentTotal));
                        invalidate();
                      }}
                    >
                      Match student total
                    </Button>
                  </Space>
                )}
                <div
                  role="region"
                  aria-label="Student grant budgets"
                  tabIndex={0}
                  style={{ overflowX: "auto" }}
                >
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    style={{ minWidth: 500 }}
                    dataSource={snapshot.grants}
                    columns={[
                      {
                        title: (
                          <Checkbox
                            aria-label="Select all grants"
                            checked={
                              selected.length > 0 &&
                              selected.length ===
                                snapshot.grants.filter(
                                  (g) => g.state !== "revoked",
                                ).length
                            }
                            onChange={(e) => {
                              setSelected(
                                e.target.checked
                                  ? snapshot.grants
                                      .filter((g) => g.state !== "revoked")
                                      .map((g) => g.id)
                                  : [],
                              );
                              invalidate();
                            }}
                          />
                        ),
                        width: 48,
                        render: (_, g) => (
                          <Checkbox
                            aria-label={`Select grant for ${name(g.beneficiary_account_id)}`}
                            disabled={g.state === "revoked"}
                            checked={selected.includes(g.id)}
                            onChange={(e) => {
                              setSelected((old) =>
                                e.target.checked
                                  ? [...old, g.id]
                                  : old.filter((id) => id !== g.id),
                              );
                              invalidate();
                            }}
                          />
                        ),
                      },
                      {
                        title: "Student",
                        dataIndex: "beneficiary_account_id",
                        render: name,
                      },
                      { title: "State", dataIndex: "state" },
                      {
                        title: "Ceiling (USD)",
                        render: (_, g) =>
                          action === "revise" && g.state !== "revoked" ? (
                            <InputNumber
                              aria-label={`Ceiling for ${name(g.beneficiary_account_id)} (USD)`}
                              stringMode
                              precision={2}
                              min="0.01"
                              value={amounts[g.id]}
                              onChange={(v) => {
                                setAmounts((old) => ({
                                  ...old,
                                  [g.id]: String(v ?? ""),
                                }));
                                invalidate();
                              }}
                            />
                          ) : (
                            moneyToCurrency(usableCeiling(g))
                          ),
                      },
                    ]}
                  />
                </div>
                {action === "revise" && (
                  <Typography.Paragraph>
                    Student ceilings: {moneyToCurrency(studentTotal)}. Pool
                    ceiling: {moneyToCurrency(amount || "0")}.
                  </Typography.Paragraph>
                )}
              </>
            )}
            {error && <Alert type="error" showIcon title={error} />}
            <Space wrap style={{ marginTop: 12 }}>
              <Button
                icon={<Icon name="eye" />}
                loading={busy}
                disabled={stale}
                onClick={() => void review()}
              >
                Preview pool change
              </Button>
              <Button onClick={cancel} disabled={busy}>
                Cancel
              </Button>
            </Space>
            {preview && (
              <section
                aria-label="Pool change preview"
                style={{ marginTop: 16 }}
              >
                <h4 tabIndex={-1} ref={previewHeading}>
                  Pool change preview
                </h4>
                <p>
                  {preview.pool.state}: ceiling{" "}
                  {moneyToCurrency(usableCeiling(preview.pool))}; spent{" "}
                  {moneyToCurrency(preview.pool.spent_usd)}; reserved{" "}
                  {moneyToCurrency(preview.pool.reserved_usd)}; released{" "}
                  {moneyToCurrency(preview.pool.released_usd)}.
                </p>
                <p>
                  {new Date(preview.pool.starts_at).toLocaleString()} to{" "}
                  {new Date(preview.pool.ends_at).toLocaleString()}
                </p>
                {preview.available_backing_usd !== undefined && (
                  <p>
                    Available backing:{" "}
                    {moneyToCurrency(preview.available_backing_usd)}
                  </p>
                )}
                <ul>
                  {preview.pool.grants.map((g) => (
                    <li key={g.id}>
                      {name(g.beneficiary_account_id)}: {g.state}, ceiling{" "}
                      {moneyToCurrency(usableCeiling(g))}
                    </li>
                  ))}
                </ul>
                <Button
                  icon={
                    <Icon
                      name={
                        preview.requires_financial_approval
                          ? "external-link"
                          : "save"
                      }
                    />
                  }
                  loading={busy}
                  disabled={
                    stale ||
                    (preview.requires_financial_approval &&
                      financialApproval?.state !== "ready")
                  }
                  onClick={() => void propose()}
                >
                  {preview.requires_financial_approval
                    ? "Authorize"
                    : "Save changes"}
                </Button>
                <Typography.Paragraph type="secondary">
                  {preview.requires_financial_approval
                    ? financialApproval?.state === "ready"
                      ? "This increases the course spending envelope and requires secure authorization."
                      : (financialApproval?.reason ??
                        "Secure financial authorization is not ready. You can still reduce or close this budget.")
                    : "This stays within the amount and dates you already authorized."}
                </Typography.Paragraph>
              </section>
            )}
          </section>
        </KeyboardBoundary>
      )}
    </div>
  );
}
