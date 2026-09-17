/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import {
  Alert,
  Button,
  Form,
  Input,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components/icon";
import { FinancialApprovalLink } from "./financial-approval-link";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { uuid } from "@cocalc/util/misc";
import { moneyToCurrency } from "@cocalc/util/money";
import type {
  CreditTransferApi,
  CreditTransferApprovalStatus,
  CreditTransferList,
  CreditTransferPreview,
  CreditTransferPendingApproval,
} from "@cocalc/util/credit-transfers";

export default function CreditTransfers({
  api = webapp_client.conat_client.hub.purchases,
  onApplied,
}: {
  api?: CreditTransferApi;
  onApplied?: () => Promise<void> | void;
}) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [data, setData] = useState<CreditTransferList>();
  const [preview, setPreview] = useState<CreditTransferPreview>();
  const [status, setStatus] = useState<CreditTransferApprovalStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string>();
  const operationRef = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const recipientInput = useRef<React.ComponentRef<typeof Input>>(null);
  const mounted = useRef(true);

  async function load() {
    try {
      const next = await api.listCreditTransfers();
      if (mounted.current) setData(next);
    } catch (err) {
      if (mounted.current) setError(`${err}`);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [api]);
  useEffect(() => {
    if (preview) heading.current?.focus();
  }, [preview]);

  function edit(update: () => void) {
    revision.current++;
    update();
    setPreview(undefined);
    setError("");
  }
  async function requestPreview() {
    const version = ++revision.current;
    setBusy(true);
    setError("");
    setPreview(undefined);
    try {
      const result = await api.previewCreditTransfer({
        recipient_account_id: recipient.trim(),
        amount_usd: amount.trim(),
      });
      if (mounted.current && revision.current === version) setPreview(result);
    } catch (err) {
      if (mounted.current && revision.current === version) setError(`${err}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function propose() {
    if (!preview) return;
    const operation_id = operationRef.current ?? uuid();
    operationRef.current = operation_id;
    setOperation(operation_id);
    setBusy(true);
    setError("");
    try {
      setStatus(
        await api.proposeCreditTransfer({ operation_id, terms: preview.terms }),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }
  async function refreshStatus() {
    if (!operation) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.getCreditTransferStatus({
        operation_id: operation,
      });
      setStatus(result);
      if (["received", "compensated"].includes(result.state)) {
        await load();
        await onApplied?.();
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }
  const terminal =
    status &&
    ["received", "compensated", "expired", "rejected"].includes(status.state);
  function reset() {
    operationRef.current = undefined;
    setPreview(undefined);
    setStatus(undefined);
    setOperation(undefined);
    setAmount("");
    setRecipient("");
    setError("");
    setTimeout(() => recipientInput.current?.focus(), 0);
  }
  function resume(pending: CreditTransferPendingApproval) {
    revision.current++;
    operationRef.current = pending.operation_id;
    setOperation(pending.operation_id);
    setRecipient(pending.terms.recipient.account_id);
    setAmount(pending.terms.amount_usd);
    setPreview(pending);
    setStatus({
      operation_id: pending.operation_id,
      state: "approval_required",
      approval_url: pending.approval_url,
    });
    setError("");
  }

  return (
    <section
      aria-labelledby="credit-transfers-heading"
      style={{ width: "100%", minWidth: 0 }}
    >
      <Typography.Title id="credit-transfers-heading" level={4}>
        Credit transfers
      </Typography.Title>
      <Button
        aria-label="Refresh transfers"
        title="Refresh transfers"
        icon={<Icon name="refresh" />}
        onClick={load}
        disabled={busy}
      />
      {error && <Alert type="error" title={error} showIcon />}
      {data && !data.enabled && (
        <Alert
          type="info"
          title={data.unavailable_reason ?? "Credit transfers unavailable"}
        />
      )}
      {data?.enabled && !operation && !!data.pending_approvals?.length && (
        <ul aria-label="Pending transfer approvals" style={{ paddingLeft: 20 }}>
          {data.pending_approvals.map((pending) => (
            <li key={pending.operation_id} style={{ overflowWrap: "anywhere" }}>
              {moneyToCurrency(pending.terms.amount_usd)} USD to{" "}
              {pending.terms.recipient.display_name}{" "}
              <Button
                type="link"
                icon={<Icon name="lock" />}
                onClick={() => resume(pending)}
                disabled={busy}
                aria-label={`Resume transfer to ${pending.terms.recipient.email_address}`}
              >
                Resume transfer
              </Button>
            </li>
          ))}
        </ul>
      )}
      {data?.enabled && (
        <Form
          layout="vertical"
          onFinish={requestPreview}
          style={{ maxWidth: 600 }}
        >
          <Form.Item
            label="Recipient account ID"
            htmlFor="credit-transfer-recipient"
          >
            <Input
              ref={recipientInput}
              id="credit-transfer-recipient"
              value={recipient}
              autoComplete="off"
              disabled={!!operation}
              onChange={(event) => edit(() => setRecipient(event.target.value))}
            />
          </Form.Item>
          <Form.Item label="Amount (USD)" htmlFor="credit-transfer-amount">
            <Input
              id="credit-transfer-amount"
              value={amount}
              inputMode="decimal"
              autoComplete="off"
              disabled={!!operation}
              onChange={(event) => edit(() => setAmount(event.target.value))}
            />
          </Form.Item>
          <Button
            htmlType="submit"
            icon={<Icon name="search" />}
            disabled={busy || !!operation || !recipient || !amount}
            loading={busy && !operation}
          >
            Preview transfer
          </Button>
        </Form>
      )}
      {preview && (
        <section
          aria-labelledby="credit-transfer-preview-heading"
          style={{ marginTop: 16, overflowWrap: "anywhere" }}
        >
          <h5 id="credit-transfer-preview-heading" ref={heading} tabIndex={-1}>
            Transfer preview
          </h5>
          <dl>
            <dt>Recipient</dt>
            <dd>
              {preview.terms.recipient.display_name} (
              {preview.terms.recipient.email_address})
            </dd>
            <dt>Account</dt>
            <dd>{preview.terms.recipient.account_id}</dd>
            <dt>Transfer amount</dt>
            <dd>{moneyToCurrency(preview.terms.amount_usd)} USD</dd>
            <dt>Transferable credit remaining</dt>
            <dd>{moneyToCurrency(preview.remaining_transferable_usd)} USD</dd>
          </dl>
          <Space wrap>
            {!status && (
              <Button
                onClick={propose}
                loading={busy}
                icon={<Icon name="lock" />}
              >
                Authorize
              </Button>
            )}
            {status?.state === "approval_required" && status.approval_url && (
              <FinancialApprovalLink approvalUrl={status.approval_url}>
                Review transfer and authorize
              </FinancialApprovalLink>
            )}
            {operation && !terminal && (
              <Button
                onClick={refreshStatus}
                disabled={busy}
                icon={<Icon name="refresh" />}
              >
                Refresh transfer status
              </Button>
            )}
            {terminal && (
              <Button onClick={reset} icon={<Icon name="plus" />}>
                New transfer
              </Button>
            )}
          </Space>
          {status && <p role="status">{status.state.replace(/_/g, " ")}</p>}
        </section>
      )}
      {!!data?.receipts.length && (
        <div
          role="region"
          aria-label="Transfer receipts"
          tabIndex={0}
          style={{ overflowX: "auto", maxWidth: "100%", marginTop: 16 }}
        >
          <Table
            size="small"
            rowKey="purchase_id"
            dataSource={data.receipts}
            pagination={false}
            style={{ minWidth: 560 }}
            columns={[
              { title: "Direction", dataIndex: "direction" },
              {
                title: "Account",
                dataIndex: "counterpart_account_id",
                render: (value: string) => (
                  <span style={{ overflowWrap: "anywhere" }}>{value}</span>
                ),
              },
              {
                title: "Date",
                dataIndex: "created_at",
                render: (value: string) => new Date(value).toLocaleString(),
              },
              {
                title: "Transfer",
                dataIndex: "transfer_id",
                render: (value: string) => (
                  <span style={{ overflowWrap: "anywhere" }}>{value}</span>
                ),
              },
              {
                title: "Amount (USD)",
                dataIndex: "amount_usd",
                render: (value: string) => moneyToCurrency(value),
              },
              {
                title: "Status",
                dataIndex: "state",
                render: (value: string) => <Tag>{value}</Tag>,
              },
            ]}
          />
        </div>
      )}
    </section>
  );
}
