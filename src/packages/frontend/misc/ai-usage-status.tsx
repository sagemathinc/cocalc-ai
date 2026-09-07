import { Button, Popover, Space } from "antd";
import { BaseType } from "antd/es/typography/Base";

import { CSS } from "@cocalc/frontend/app-framework";
import { A, HelpIcon, Paragraph, Text } from "@cocalc/frontend/components";
import type {
  AIUsageStatus as AIUsageStatusResponse,
  AIUsageWindowStatus,
} from "@cocalc/conat/hub/api/purchases";
import type { LanguageModel } from "@cocalc/util/db-schema/ai-models";
import { round2down, round2up } from "@cocalc/util/misc";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useEffect, useState } from "react";
import { lite } from "@cocalc/frontend/lite";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  UsageWindowMeters,
  type UsageWindowMeter,
} from "@cocalc/frontend/account/usage-window-meters";

/*
NOTE: To get a quick idea about the numbers of how many completion tokens are returned, run this:

```sql
WITH data AS (
  SELECT model, (total_tokens - prompt_tokens) AS val
  FROM ai_usage_log
  WHERE  time >= NOW() - '1 week'::interval
    AND tag like 'app:%'
)
SELECT model, PERCENTILE_CONT(0.5) WITHIN GROUP(ORDER BY val) AS median
FROM data
GROUP BY model
ORDER BY median desc
```

This gives a range from about 100 to almost 700.
The maximum (just use the "MAX" function, easier than the median) is at almost the token limit (i.e. 2000).

That's the basis for the number 100 and 1000 below!
*/

export function AIUsageSummary({
  model: _model,
  tokens: _tokens, // Note: use the "await imported" numTokensUpperBound function to get the number of tokens
  type,
  maxOutputTokens: _maxOutputTokens,
  paragraph = false,
  textAlign,
}: {
  model: LanguageModel;
  tokens: number;
  type?: BaseType;
  maxOutputTokens?: number;
  paragraph?: boolean;
  textAlign?: CSS["textAlign"];
}) {
  return (
    <Wrapper type={type} paragraph={paragraph} textAlign={textAlign}>
      <AIUsageStatus />
    </Wrapper>
  );
}

function Wrapper({
  children,
  type,
  paragraph,
  textAlign = "right",
}: {
  children: React.ReactNode;
  type?: BaseType;
  paragraph?: boolean;
  textAlign?: CSS["textAlign"];
}) {
  const C = paragraph ? Paragraph : Text;
  const style: CSS = paragraph ? { textAlign, marginBottom: 0 } : {};
  return (
    <C style={style} type={type}>
      {children}
    </C>
  );
}

export function calculateUsageEstimateRange(
  tokens: number,
  _model,
  _ai_markup,
  maxTokens: number = 1000,
): { min: number; max: number } {
  const min = round2down(tokens * 0);
  const max = round2up(maxTokens * 0);
  return { min, max };
}

export function AIUsageHelpContent() {
  return (
    <>
      <Paragraph>
        Your CoCalc membership determines the site-provided AI allowance shown
        here. Usage resets automatically with the displayed windows.
      </Paragraph>
      <Paragraph>
        To use AI in CoCalc, sign up for a ChatGPT plan at{" "}
        <A href="https://chatgpt.com/pricing">chatgpt.com/pricing</A>, then
        connect it in <A href="/settings/account/ai">CoCalc AI settings</A>.
      </Paragraph>
    </>
  );
}

export function AIUsageStatus({
  variant = "full",
  showHelp = true,
  compactWidth,
  compactSingle = false,
}: {
  variant?: "full" | "compact";
  showHelp?: boolean;
  compactWidth?: number;
  compactSingle?: boolean;
}) {
  const [status, setStatus] = useState<AIUsageStatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result =
          await webapp_client.conat_client.hub.purchases.getAIUsage();
        if (!cancelled) {
          setStatus(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err as Error);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    load().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  if (lite) return null;

  if (error) {
    return <Text type="secondary">AI usage unavailable.</Text>;
  }
  if (loading || !status) {
    return <Text type="secondary">Loading usage…</Text>;
  }

  const window5h = status.windows.find((w) => w.window === "5h");
  const window7d = status.windows.find((w) => w.window === "7d");

  const content = (
    <>
      <AIUsageMeters status={status} />
      {showHelp && (
        <HelpIcon title="AI Usage Limits" placement={"topLeft"}>
          <AIUsageHelpContent />
        </HelpIcon>
      )}
    </>
  );

  if (variant === "compact") {
    const minWidth = compactWidth ?? 180;
    return (
      <Popover content={content} title="AI Usage" trigger="click">
        <Button
          size="small"
          style={{
            height: "auto",
            padding: "4px 6px",
            fontSize: "11px",
            minWidth: `${minWidth}px`,
          }}
        >
          {compactSingle ? (
            <CompactUsageBar label="5h" window={window5h} />
          ) : (
            <Space orientation="vertical" size={2} style={{ width: "100%" }}>
              <CompactUsageBar label="5h" window={window5h} />
              <CompactUsageBar label="7d" window={window7d} />
            </Space>
          )}
        </Button>
      </Popover>
    );
  }

  return content;
}

export function getAIUsageWindows(
  status?: AIUsageStatusResponse | null,
): UsageWindowMeter[] {
  if (!status) return [];
  return status.windows.map((window) => {
    const limit = window.limit;
    const remaining =
      window.remaining ??
      (typeof limit === "number"
        ? Math.max(0, limit - window.used)
        : undefined);
    const remainingPercent =
      typeof limit === "number" && limit > 0 && typeof remaining === "number"
        ? Math.max(0, Math.min(100, Math.round((100 * remaining) / limit)))
        : undefined;
    const resetAtValue = window.reset_at ?? window.resets_at;
    const resetAt = resetAtValue ? new Date(resetAtValue) : undefined;
    return {
      key: window.window,
      label: window.window === "5h" ? "5-hour limit" : "7-day limit",
      remainingPercent,
      resetAt:
        resetAt && Number.isFinite(resetAt.getTime()) ? resetAt : undefined,
    };
  });
}

export function AIUsageMeters({
  status,
  compact = false,
}: {
  status?: AIUsageStatusResponse | null;
  compact?: boolean;
}): React.JSX.Element | null {
  return (
    <UsageWindowMeters
      compact={compact}
      statusLabel="AI usage"
      windows={getAIUsageWindows(status)}
    />
  );
}

export function CompactUsageBar({
  label,
  window,
}: {
  label: string;
  window?: AIUsageWindowStatus;
}) {
  const limit = window?.limit ?? 0;
  const used = window?.used ?? 0;
  const known =
    !!window && Number.isFinite(limit) && limit > 0 && Number.isFinite(used);
  const percent = known ? Math.max(0, Math.min(100, (100 * used) / limit)) : 0;
  const usageLabel = !known
    ? "Unavailable"
    : percent > 0 && percent < 1
      ? "<1% used"
      : `${Math.round(percent)}% used`;
  const filled = Math.max(0, Math.min(4, Math.round((percent / 100) * 4)));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <Text type="secondary" style={{ width: "22px" }}>
        {label}
      </Text>
      <div
        role={known ? "meter" : undefined}
        aria-label={`${label} AI usage`}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? 100 : undefined}
        aria-valuenow={known ? percent : undefined}
        aria-valuetext={known ? usageLabel : undefined}
        style={{ display: "flex", gap: "4px", flex: 1, minWidth: 48 }}
      >
        {Array.from({ length: 4 }, (_, idx) => (
          <div
            key={`${label}-${idx}`}
            style={{
              flex: 1,
              height: "5px",
              borderRadius: "4px",
              background: idx < filled ? UI_COLORS.link : UI_COLORS.inset,
              border: `1px solid ${idx < filled ? UI_COLORS.link : UI_COLORS.border}`,
            }}
          />
        ))}
      </div>
      <span
        style={{
          color: UI_COLORS.text,
          minWidth: 65,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {usageLabel}
      </span>
    </div>
  );
}
