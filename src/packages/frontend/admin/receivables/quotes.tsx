/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Radio,
  Tag,
  Typography,
} from "antd";
import { useId, useState } from "react";

import type {
  CommercialQuotePreview,
  CommercialStripeQuotePreview,
} from "@cocalc/conat/hub/api/commercial-orders";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { ErrorDisplay, Icon } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  CommercialOrder,
  CommercialQuote,
  CommercialQuoteProvider,
} from "@cocalc/util/commercial-orders";
import { COLORS } from "@cocalc/util/theme";
import {
  formatDate,
  downloadBase64Pdf,
  formatMoney,
  formatReceivablesError,
  humanizeKey,
} from "./shared";

const { Paragraph, Text } = Typography;

interface IssueQuoteFormValues {
  valid_until: string;
  reason: string;
}

type QuotePreview = CommercialQuotePreview | CommercialStripeQuotePreview;
type StripeQuoteAction = "finalize" | "accept" | "cancel" | "reconcile";

interface StripeActionFormValues {
  reason: string;
  customer_acceptance_confirmed?: boolean;
}

function localDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function quoteProvider(quote: CommercialQuote): CommercialQuoteProvider {
  return quote.provider ?? "local";
}

function quoteDisplayStatus(quote: CommercialQuote): string {
  if (quote.status === "issued" && new Date(quote.valid_until) < new Date()) {
    return "expired";
  }
  return quote.status;
}

function localStatusColor(status: string): string | undefined {
  switch (status) {
    case "accepted":
      return "success";
    case "expired":
    case "void":
      return "default";
    case "draft":
      return "warning";
    default:
      return "processing";
  }
}

function providerStatusColor(status?: string | null): string | undefined {
  switch (status) {
    case "accepted":
      return "success";
    case "canceled":
      return "default";
    case "draft":
      return "warning";
    default:
      return "processing";
  }
}

function stripeDashboardUrl(quote: CommercialQuote): string | undefined {
  if (!quote.provider_quote_id) return;
  const { livemode } = quote.provider_snapshot ?? {};
  if (typeof livemode !== "boolean") return;
  const mode = livemode ? "" : "test/";
  return `https://dashboard.stripe.com/${mode}quotes/${encodeURIComponent(
    quote.provider_quote_id,
  )}`;
}

function stripeActionTitle(
  action: StripeQuoteAction,
  quoteNumber: string,
): string {
  switch (action) {
    case "finalize":
      return `Finalize ${quoteNumber}`;
    case "accept":
      return `Confirm customer acceptance of ${quoteNumber}`;
    case "cancel":
      return `Cancel ${quoteNumber}`;
    case "reconcile":
      return `Reconcile ${quoteNumber} with Stripe`;
  }
}

function stripeActionButtonText(action: StripeQuoteAction): string {
  switch (action) {
    case "finalize":
      return "Finalize quote (fresh authentication required)";
    case "accept":
      return "Accept quote (fresh authentication required)";
    case "cancel":
      return "Cancel quote (fresh authentication required)";
    case "reconcile":
      return "Reconcile quote (fresh authentication required)";
  }
}

function StripeActionExplanation({ action }: { action: StripeQuoteAction }) {
  switch (action) {
    case "finalize":
      return (
        <Alert
          showIcon
          type="info"
          title="Finalization creates the customer-facing Stripe quote"
          description="CoCalc will retain the finalized Stripe PDF. This does not accept the quote or send an invoice."
        />
      );
    case "accept":
      return (
        <Alert
          showIcon
          type="warning"
          title="Confirm acceptance outside CoCalc first"
          description="Accepting the Stripe quote creates a draft invoice for review. The invoice remains unsent and must be sent separately."
        />
      );
    case "cancel":
      return (
        <Alert
          showIcon
          type="warning"
          title="Cancellation is reflected in Stripe"
          description="A retained finalized PDF remains part of the audit record, but the quote can no longer be accepted."
        />
      );
    case "reconcile":
      return (
        <Alert
          showIcon
          type="info"
          title="Stripe is authoritative for provider state"
          description="CoCalc will verify the Stripe quote identity and amount, then recover any missing local status, PDF, or accepted draft invoice."
        />
      );
  }
}

export function CommercialQuotesCard({
  order,
  onOrderChanged,
}: {
  order: CommercialOrder;
  onOrderChanged: (order: CommercialOrder) => Promise<void> | void;
}) {
  const api = webapp_client.conat_client.hub.commercialOrders;
  const providerLabelId = useId();
  const [issueForm] = Form.useForm<IssueQuoteFormValues>();
  const [voidForm] = Form.useForm<{ reason: string }>();
  const [stripeActionForm] = Form.useForm<StripeActionFormValues>();
  const acceptanceConfirmed =
    Form.useWatch("customer_acceptance_confirmed", stripeActionForm) ?? false;
  const [selectedProvider, setSelectedProvider] =
    useState<CommercialQuoteProvider>("local");
  const [previewProvider, setPreviewProvider] =
    useState<CommercialQuoteProvider>("local");
  const [preview, setPreview] = useState<QuotePreview | null>(null);
  const [voidQuote, setVoidQuote] = useState<CommercialQuote | null>(null);
  const [stripeAction, setStripeAction] = useState<{
    action: StripeQuoteAction;
    quote: CommercialQuote;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function openIssue() {
    setBusy(true);
    setError("");
    try {
      const nextPreview =
        selectedProvider === "stripe"
          ? await api.stripeQuotePreview({
              id: order.id,
              reason: "Preview Stripe commercial quote before draft creation",
            })
          : await api.quotePreview({
              id: order.id,
              reason: "Preview commercial quote before issuance",
            });
      setPreviewProvider(selectedProvider);
      setPreview(nextPreview);
    } catch (err) {
      setError(formatReceivablesError(err));
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    const values = await issueForm.validateFields();
    setBusy(true);
    setError("");
    let saved: CommercialOrder | undefined;
    try {
      const completed = await runFreshAuthAction(async () => {
        const common = {
          id: order.id,
          source: "admin-ui" as const,
          reason: values.reason.trim(),
          expected_version: order.version,
          valid_until: new Date(values.valid_until).toISOString(),
          browser_id: webapp_client.browser_id,
        };
        saved =
          previewProvider === "stripe"
            ? await api.createStripeQuote({
                ...common,
                idempotency_key:
                  "admin-ui:stripe-quote-create:" +
                  order.id +
                  ":v" +
                  order.version,
              })
            : await api.issueQuote({
                ...common,
                idempotency_key:
                  "admin-ui:quote-issue:" + order.id + ":v" + order.version,
              });
      });
      if (!completed || !saved) return;
      await onOrderChanged(saved);
      setPreview(null);
    } catch (err) {
      setError(formatReceivablesError(err));
    } finally {
      setBusy(false);
    }
  }

  async function download(quote: CommercialQuote) {
    setBusy(true);
    setError("");
    try {
      const document = await api.quoteDocument({
        id: order.id,
        commercial_quote_id: quote.id,
        reason: "Download stored quote " + quote.quote_number,
      });
      if (!document.quote.document_filename) {
        throw Error("the quote does not have a retained PDF");
      }
      downloadBase64Pdf(
        document.content_base64,
        document.quote.document_filename,
      );
    } catch (err) {
      setError(formatReceivablesError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmVoid() {
    if (!voidQuote) return;
    const values = await voidForm.validateFields();
    setBusy(true);
    setError("");
    let saved: CommercialOrder | undefined;
    try {
      const completed = await runFreshAuthAction(async () => {
        saved = await api.voidQuote({
          id: order.id,
          commercial_quote_id: voidQuote.id,
          source: "admin-ui",
          reason: values.reason.trim(),
          expected_version: order.version,
          idempotency_key:
            "admin-ui:quote-void:" + voidQuote.id + ":v" + order.version,
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed || !saved) return;
      await onOrderChanged(saved);
      setVoidQuote(null);
    } catch (err) {
      setError(formatReceivablesError(err));
    } finally {
      setBusy(false);
    }
  }

  function openStripeAction(action: StripeQuoteAction, quote: CommercialQuote) {
    setError("");
    setStripeAction({ action, quote });
  }

  async function runStripeAction() {
    if (!stripeAction) return;
    const values = await stripeActionForm.validateFields();
    const { action, quote } = stripeAction;
    setBusy(true);
    setError("");
    let saved: CommercialOrder | undefined;
    try {
      const completed = await runFreshAuthAction(async () => {
        const common = {
          id: order.id,
          commercial_quote_id: quote.id,
          source: "admin-ui" as const,
          reason: values.reason.trim(),
          expected_version: order.version,
          idempotency_key: `admin-ui:stripe-quote-${action}:${quote.id}:v${order.version}`,
          browser_id: webapp_client.browser_id,
        };
        switch (action) {
          case "finalize":
            saved = await api.finalizeStripeQuote(common);
            break;
          case "accept":
            saved = await api.acceptStripeQuote({
              ...common,
              customer_acceptance_confirmed:
                values.customer_acceptance_confirmed === true,
            });
            break;
          case "cancel":
            saved = await api.cancelStripeQuote(common);
            break;
          case "reconcile":
            saved = await api.reconcileStripeQuote(common);
            break;
        }
      });
      if (!completed || !saved) return;
      await onOrderChanged(saved);
      setStripeAction(null);
    } catch (err) {
      setError(formatReceivablesError(err));
    } finally {
      setBusy(false);
    }
  }

  const stripePreview =
    previewProvider === "stripe" && preview
      ? (preview as CommercialStripeQuotePreview)
      : null;
  const terminalOrder = ["complete", "cancelled"].includes(
    order.workflow_state,
  );

  return (
    <>
      <Card className="receivables-section-card" title="Quotes" size="small">
        <Flex vertical gap="middle">
          <Flex justify="space-between" align="end" gap="middle" wrap>
            <Flex
              vertical
              gap="small"
              style={{ flex: "1 1 420px", minWidth: 0 }}
            >
              <Paragraph type="secondary" style={{ margin: 0 }}>
                Local PDFs are immutable snapshots. Stripe quotes add a staged,
                provider-backed lifecycle: create a draft, finalize it, and
                separately record confirmed customer acceptance.
              </Paragraph>
              <Flex align="center" gap="small" wrap>
                <Text strong id={providerLabelId}>
                  Quote provider
                </Text>
                <Radio.Group
                  aria-labelledby={providerLabelId}
                  value={selectedProvider}
                  onChange={(event) => setSelectedProvider(event.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  disabled={terminalOrder || busy}
                >
                  <Radio.Button value="local">Local PDF</Radio.Button>
                  <Radio.Button value="stripe">Stripe</Radio.Button>
                </Radio.Group>
              </Flex>
            </Flex>
            <Button
              type="primary"
              icon={
                <Icon
                  name={
                    selectedProvider === "stripe" ? "credit-card" : "file-pdf"
                  }
                />
              }
              disabled={terminalOrder}
              loading={busy}
              onClick={() => void openIssue()}
            >
              {selectedProvider === "stripe"
                ? "Create Stripe quote"
                : "Generate quote"}
            </Button>
          </Flex>
          {error &&
          preview == null &&
          voidQuote == null &&
          stripeAction == null ? (
            <ErrorDisplay
              error={error}
              title="Quote action failed"
              onClose={() => setError("")}
            />
          ) : null}
          {order.quotes.length === 0 ? (
            <Empty description="No quotes have been created" />
          ) : (
            <Flex vertical gap="small">
              {order.quotes.map((quote) => {
                const provider = quoteProvider(quote);
                const displayStatus = quoteDisplayStatus(quote);
                const dashboardUrl = stripeDashboardUrl(quote);
                const hasDocument = Boolean(
                  quote.document_filename && quote.document_sha256,
                );
                const canFinalize =
                  provider === "stripe" &&
                  quote.status === "draft" &&
                  quote.provider_status === "draft" &&
                  Boolean(quote.provider_quote_id);
                const canRequestAcceptance =
                  provider === "stripe" &&
                  quote.status === "issued" &&
                  quote.provider_status === "open" &&
                  hasDocument;
                const canAccept =
                  canRequestAcceptance &&
                  Boolean(order.approved_at && order.approved_by_account_id);
                const canCancel =
                  provider === "stripe" &&
                  ["draft", "issued"].includes(quote.status) &&
                  ["draft", "open"].includes(quote.provider_status ?? "") &&
                  Boolean(quote.provider_quote_id);
                return (
                  <Card
                    key={quote.id}
                    size="small"
                    type="inner"
                    style={
                      provider === "stripe"
                        ? {
                            borderInlineStart: `4px solid ${COLORS.FEATURE_TEAL}`,
                          }
                        : undefined
                    }
                  >
                    <Flex
                      justify="space-between"
                      gap="middle"
                      align="center"
                      wrap
                    >
                      <Flex
                        vertical
                        gap={4}
                        style={{ flex: "1 1 300px", minWidth: 0 }}
                      >
                        <Flex align="center" gap="small" wrap>
                          <Text strong>{quote.quote_number}</Text>
                          <Tag
                            color={
                              provider === "stripe"
                                ? COLORS.FEATURE_TEAL
                                : undefined
                            }
                          >
                            {provider === "stripe" ? "Stripe" : "Local PDF"}
                          </Tag>
                          <Tag color={localStatusColor(displayStatus)}>
                            Local: {humanizeKey(displayStatus)}
                          </Tag>
                          {provider === "stripe" && quote.provider_status ? (
                            <Tag
                              color={providerStatusColor(quote.provider_status)}
                            >
                              Stripe: {humanizeKey(quote.provider_status)}
                            </Tag>
                          ) : null}
                        </Flex>
                        <Text type="secondary">
                          {formatMoney(quote.total, quote.currency)};{" "}
                          {quote.issued_at
                            ? `issued ${formatDate(quote.issued_at)}`
                            : `created ${formatDate(quote.created_at)}`}
                          ; valid through {formatDate(quote.valid_until)}
                        </Text>
                        {quote.provider_invoice_id ? (
                          <Text type="secondary" copyable>
                            Draft invoice: {quote.provider_invoice_id}
                          </Text>
                        ) : null}
                        {canRequestAcceptance && !canAccept ? (
                          <Text type="secondary">
                            Approve the commercial order before accepting this
                            quote.
                          </Text>
                        ) : null}
                      </Flex>
                      <Flex gap="small" wrap>
                        {dashboardUrl ? (
                          <Button
                            href={dashboardUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            icon={<Icon name="external-link" />}
                            aria-label={`Stripe Dashboard for ${quote.quote_number}`}
                          >
                            Stripe Dashboard
                          </Button>
                        ) : null}
                        {hasDocument ? (
                          <Button
                            icon={<Icon name="download" />}
                            loading={busy}
                            aria-label={`Download PDF for ${quote.quote_number}`}
                            onClick={() => void download(quote)}
                          >
                            Download PDF
                          </Button>
                        ) : null}
                        {canFinalize ? (
                          <Button
                            type="primary"
                            icon={<Icon name="file-pdf" />}
                            aria-label={`Finalize ${quote.quote_number}`}
                            onClick={() => openStripeAction("finalize", quote)}
                          >
                            Finalize
                          </Button>
                        ) : null}
                        {canAccept ? (
                          <Button
                            type="primary"
                            icon={<Icon name="check-circle" />}
                            aria-label={`Accept ${quote.quote_number}`}
                            onClick={() => openStripeAction("accept", quote)}
                          >
                            Accept
                          </Button>
                        ) : null}
                        {canCancel ? (
                          <Button
                            danger
                            aria-label={`Cancel ${quote.quote_number}`}
                            onClick={() => openStripeAction("cancel", quote)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                        {provider === "stripe" ? (
                          <Button
                            icon={<Icon name="refresh" />}
                            aria-label={`Reconcile ${quote.quote_number}`}
                            onClick={() => openStripeAction("reconcile", quote)}
                          >
                            Reconcile
                          </Button>
                        ) : null}
                        {provider === "local" && quote.status === "issued" ? (
                          <Button
                            danger
                            aria-label={`Void ${quote.quote_number}`}
                            onClick={() => {
                              setError("");
                              setVoidQuote(quote);
                            }}
                          >
                            Void quote
                          </Button>
                        ) : null}
                      </Flex>
                    </Flex>
                  </Card>
                );
              })}
            </Flex>
          )}
        </Flex>
      </Card>

      <Modal
        title={
          previewProvider === "stripe"
            ? "Review Stripe quote draft"
            : "Review and issue quote"
        }
        open={preview != null}
        width={720}
        okText={
          previewProvider === "stripe"
            ? "Create Stripe draft (fresh authentication required)"
            : "Issue and store quote (fresh authentication required)"
        }
        okButtonProps={{ loading: busy, disabled: !preview?.ready }}
        onCancel={() => {
          setPreview(null);
          setError("");
        }}
        onOk={() => void issue()}
        destroyOnHidden
      >
        {preview ? (
          <Flex vertical gap="middle">
            <Alert
              showIcon
              type={preview.ready ? "info" : "warning"}
              title={
                preview.ready
                  ? previewProvider === "stripe"
                    ? "Stripe draft is ready to create"
                    : "Quote is ready to issue"
                  : "Quote has blockers"
              }
              description={
                preview.ready
                  ? previewProvider === "stripe"
                    ? "This creates a recoverable Stripe draft. It does not finalize or email the quote, accept it, or send an invoice."
                    : "The generated PDF and exact recipient, address, items, amount, and service-term snapshot will be retained with this order."
                  : preview.blockers.join("; ")
              }
            />
            {error ? (
              <ErrorDisplay
                error={error}
                title={
                  previewProvider === "stripe"
                    ? "Stripe draft was not created"
                    : "Quote was not issued"
                }
                onClose={() => setError("")}
              />
            ) : null}
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="Provider">
                {previewProvider === "stripe" ? "Stripe" : "Local PDF"}
              </Descriptions.Item>
              <Descriptions.Item label="Organization">
                {preview.organization_name}
              </Descriptions.Item>
              <Descriptions.Item label="Recipient">
                {preview.billing_contacts[0]
                  ? preview.billing_contacts[0].name_snapshot +
                    " <" +
                    preview.billing_contacts[0].email_snapshot +
                    ">"
                  : "Missing billing contact"}
              </Descriptions.Item>
              <Descriptions.Item label="Total">
                {formatMoney(preview.total, preview.currency)}
              </Descriptions.Item>
              <Descriptions.Item label="Line items">
                {preview.items.length}
              </Descriptions.Item>
              {stripePreview ? (
                <>
                  <Descriptions.Item label="Stripe mode">
                    <Tag
                      color={
                        stripePreview.stripe_mode === "live"
                          ? "success"
                          : "warning"
                      }
                    >
                      {humanizeKey(stripePreview.stripe_mode)}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Stripe customer">
                    {stripePreview.stripe_customer_id ??
                      "A reviewed customer will be resolved when creating the draft"}
                  </Descriptions.Item>
                  <Descriptions.Item label="Payment terms">
                    {stripePreview.payment_terms_days} days after invoice
                  </Descriptions.Item>
                </>
              ) : null}
            </Descriptions>
            <Form
              form={issueForm}
              layout="vertical"
              clearOnDestroy
              initialValues={{
                valid_until: localDateTimeInputValue(
                  preview.default_valid_until,
                ),
                reason: "",
              }}
            >
              <Form.Item
                label="Valid through"
                name="valid_until"
                rules={[{ required: true }]}
              >
                <Input type="datetime-local" />
              </Form.Item>
              <Form.Item
                label="Audit reason"
                name="reason"
                rules={[{ required: true, min: 4, whitespace: true }]}
              >
                <Input.TextArea rows={2} maxLength={2000} />
              </Form.Item>
            </Form>
          </Flex>
        ) : null}
      </Modal>

      <Modal
        title={"Void " + (voidQuote?.quote_number ?? "quote")}
        open={voidQuote != null}
        okText="Void quote (fresh authentication required)"
        okButtonProps={{ danger: true, loading: busy }}
        onCancel={() => {
          setVoidQuote(null);
          setError("");
        }}
        onOk={() => void confirmVoid()}
        destroyOnHidden
      >
        <Flex vertical gap="middle">
          <Alert
            showIcon
            type="warning"
            title="The stored document will remain in the audit record"
            description="Voiding marks this quote as no longer valid. It does not delete or rewrite the PDF that was issued."
          />
          {error ? (
            <ErrorDisplay
              error={error}
              title="Quote was not voided"
              onClose={() => setError("")}
            />
          ) : null}
          <Form
            form={voidForm}
            layout="vertical"
            clearOnDestroy
            initialValues={{ reason: "" }}
          >
            <Form.Item
              label="Audit reason"
              name="reason"
              rules={[{ required: true, min: 4, whitespace: true }]}
            >
              <Input.TextArea rows={3} maxLength={2000} />
            </Form.Item>
          </Form>
        </Flex>
      </Modal>

      <Modal
        title={
          stripeAction
            ? stripeActionTitle(
                stripeAction.action,
                stripeAction.quote.quote_number,
              )
            : "Stripe quote action"
        }
        open={stripeAction != null}
        width={680}
        okText={
          stripeAction
            ? stripeActionButtonText(stripeAction.action)
            : "Continue"
        }
        okButtonProps={{
          loading: busy,
          danger: stripeAction?.action === "cancel",
          disabled: stripeAction?.action === "accept" && !acceptanceConfirmed,
        }}
        onCancel={() => {
          setStripeAction(null);
          setError("");
        }}
        onOk={() => void runStripeAction()}
        destroyOnHidden
      >
        {stripeAction ? (
          <Flex vertical gap="middle">
            <StripeActionExplanation action={stripeAction.action} />
            {error ? (
              <ErrorDisplay
                error={error}
                title="Stripe quote action failed"
                onClose={() => setError("")}
              />
            ) : null}
            <Form
              form={stripeActionForm}
              layout="vertical"
              clearOnDestroy
              initialValues={{
                reason: "",
                customer_acceptance_confirmed: false,
              }}
            >
              {stripeAction.action === "accept" ? (
                <Form.Item
                  name="customer_acceptance_confirmed"
                  valuePropName="checked"
                  rules={[
                    {
                      validator: async (_, value) => {
                        if (value === true) return;
                        throw Error(
                          "Confirm the customer's explicit acceptance before continuing.",
                        );
                      },
                    },
                  ]}
                >
                  <Checkbox>
                    I confirm that the customer explicitly accepted this exact
                    finalized quote.
                  </Checkbox>
                </Form.Item>
              ) : null}
              <Form.Item
                label="Audit reason"
                name="reason"
                rules={[{ required: true, min: 4, whitespace: true }]}
              >
                <Input.TextArea rows={3} maxLength={2000} />
              </Form.Item>
            </Form>
          </Flex>
        ) : null}
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
