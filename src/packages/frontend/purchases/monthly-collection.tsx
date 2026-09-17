import { Alert, Button, Checkbox } from "antd";
import { useEffect, useRef, useState } from "react";
import { uuid } from "@cocalc/util/misc";
import { Icon } from "@cocalc/frontend/components/icon";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { MONTHLY_COLLECTION_TERMS } from "@cocalc/util/monthly-collection";
import type {
  MonthlyCollectionApi,
  MonthlyCollectionApproval,
} from "@cocalc/util/monthly-collection";
import { FinancialApprovalLink } from "./financial-approval-link";

export default function MonthlyCollection({
  api = webapp_client.conat_client.hub.purchases,
}: {
  api?: MonthlyCollectionApi;
}) {
  const [data, setData] =
    useState<
      Awaited<ReturnType<MonthlyCollectionApi["getMonthlyCollection"]>>
    >();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<MonthlyCollectionApproval>();
  const request =
    useRef<Parameters<MonthlyCollectionApi["proposeMonthlyCollection"]>[0]>(
      undefined,
    );
  const heading = useRef<HTMLHeadingElement>(null);
  async function refresh() {
    try {
      setError("");
      setBusy(true);
      const next = await api.getMonthlyCollection();
      setData(next);
      if (
        proposal &&
        !next.pending.some((p) => p.intent_id === proposal.intent_id)
      ) {
        setProposal(undefined);
        request.current = undefined;
        setAccepted(false);
        heading.current?.focus();
      }
      if (
        request.current &&
        next.consent.version !== request.current.terms.expected_version
      ) {
        request.current = undefined;
        setProposal(undefined);
        setAccepted(false);
        heading.current?.focus();
      }
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [api]);
  const enabled = data?.consent.enabled || data?.legacy_enabled;
  async function propose() {
    if (!data || (!enabled && !accepted)) return;
    try {
      setBusy(true);
      setError("");
      request.current ??= {
        operation_id: uuid(),
        terms: {
          kind: "monthlyCollection",
          enabled: !enabled,
          expected_version: data.consent.version,
          terms_version: 1,
        },
      };
      setProposal(await api.proposeMonthlyCollection(request.current));
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }
  const pending = proposal ? [proposal] : (data?.pending ?? []);
  return (
    <section
      aria-labelledby="monthly-collection-heading"
      style={{ maxWidth: 680, overflowWrap: "anywhere" }}
    >
      <h4 id="monthly-collection-heading" ref={heading} tabIndex={-1}>
        Monthly collection
      </h4>
      {error && <Alert type="error" showIcon title={error} role="alert" />}
      <p role="status">
        {!data
          ? "Loading monthly collection settings..."
          : `Monthly collection is ${enabled ? "enabled" : "disabled"}${data.legacy_enabled ? " through legacy enrollment" : ""}.`}
      </p>
      <p>{MONTHLY_COLLECTION_TERMS}</p>
      {!!data?.attention_statement_ids?.length && (
        <Alert
          type="warning"
          showIcon
          role="status"
          title="Monthly payment needs attention"
          description={`Check statements ${data.attention_statement_ids.join(", ")} and contact support before paying again. Further postpaid spending is suspended until the payment is reconciled.`}
        />
      )}
      {data?.available && (
        <>
          {!enabled && (
            <Checkbox
              checked={accepted}
              disabled={busy || !!request.current}
              onChange={(e) => setAccepted(e.target.checked)}
            >
              I authorize monthly collection from my saved payment method.
            </Checkbox>
          )}
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}
          >
            {!pending.length && (
              <Button
                style={{
                  whiteSpace: "normal",
                  height: "auto",
                  minHeight: 32,
                  maxWidth: "100%",
                }}
                icon={<Icon name="lock" />}
                disabled={busy || (!enabled && !accepted)}
                onClick={propose}
              >
                {enabled
                  ? "Request disabling monthly collection"
                  : "Request monthly collection"}
              </Button>
            )}
            {pending.map((p) => (
              <FinancialApprovalLink
                key={p.intent_id}
                approvalUrl={p.approval_url}
              >
                Review monthly collection and authorize
              </FinancialApprovalLink>
            ))}
            <Button
              style={{
                whiteSpace: "normal",
                height: "auto",
                minHeight: 32,
                maxWidth: "100%",
              }}
              icon={<Icon name="refresh" />}
              onClick={refresh}
              disabled={busy}
            >
              Refresh monthly collection
            </Button>
          </div>
        </>
      )}
      {data && !data.available && (
        <p>Trusted financial approval is unavailable on this site.</p>
      )}
    </section>
  );
}
