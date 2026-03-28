/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import {
  Alert,
  Button,
  Divider,
  Input,
  Segmented,
  Space,
  Typography,
} from "antd";

import type { AuthView } from "@cocalc/frontend/auth/types";
import api from "@cocalc/frontend/client/api";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { currency } from "@cocalc/util/misc";
import { joinUrlPath } from "@cocalc/util/url-path";

import { PublicSignInForm, PublicSignUpForm } from "./forms";
import { pathForRedeem } from "./routes";

const { Paragraph, Text } = Typography;

type CreatedItem = {
  amount?: number;
  purchase_id?: number;
  type: "cash" | string;
};

function DisplayCreatedItem({ item }: { item: CreatedItem }) {
  if (item.type === "cash") {
    return (
      <li>
        {currency(Number(item.amount ?? 0))} was credited to your account via
        purchase {item.purchase_id}.
      </li>
    );
  }
  return <li>{JSON.stringify(item)}</li>;
}

function DisplayCreatedItems({
  createdItems,
}: {
  createdItems: CreatedItem[];
}) {
  return (
    <ol style={{ marginBottom: 0, paddingLeft: "20px" }}>
      {createdItems.map((item, index) => (
        <DisplayCreatedItem item={item} key={index} />
      ))}
    </ol>
  );
}

export default function PublicRedeemVoucherView({
  initialCode,
  isAuthenticated = false,
  onNavigate,
}: {
  initialCode?: string;
  isAuthenticated?: boolean;
  onNavigate: (view: AuthView) => void;
}) {
  const [code, setCode] = useState(initialCode ?? "");
  const [error, setError] = useState("");
  const [state, setState] = useState<"input" | "redeeming" | "redeemed">(
    "input",
  );
  const [createdItems, setCreatedItems] = useState<CreatedItem[]>([]);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");

  useEffect(() => {
    setCode(initialCode ?? "");
  }, [initialCode]);

  const redeemPath = useMemo(() => pathForRedeem(code.trim()), [code]);

  async function redeemCode() {
    const normalized = code.split("/").filter(Boolean).at(-1)?.trim() ?? "";
    if (normalized.length < 8) {
      setError("Enter a valid voucher code.");
      return;
    }
    setError("");
    setState("redeeming");
    try {
      const result = await api("vouchers/redeem", { code: normalized });
      if (result?.error) {
        throw Error(result.error);
      }
      setCreatedItems(result ?? []);
      setState("redeemed");
    } catch (err) {
      setError(`${err}`);
      setState("input");
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Redeem a voucher code to add account credit that you can use for
        memberships and other purchases inside CoCalc.
      </Paragraph>

      <div>
        <Text strong>Voucher code</Text>
        <Input
          allowClear
          autoFocus={isAuthenticated}
          disabled={state === "redeeming"}
          placeholder="Paste voucher code or redeem URL"
          size="large"
          style={{ marginTop: "8px" }}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError("");
            if (state === "redeemed") {
              setState("input");
              setCreatedItems([]);
            }
          }}
          onPressEnter={isAuthenticated ? redeemCode : undefined}
        />
      </div>

      {error && <Alert message={error} type="error" />}

      {!isAuthenticated ? (
        <>
          <Alert
            message="Sign in or create an account to redeem this voucher"
            showIcon
            type="info"
          />
          <Segmented
            block
            options={[
              { label: "Sign in", value: "sign-in" },
              { label: "Create account", value: "sign-up" },
            ]}
            value={authMode}
            onChange={(value) => setAuthMode(value as "sign-in" | "sign-up")}
          />
          {authMode === "sign-in" ? (
            <PublicSignInForm
              onNavigate={(view) => {
                if (view === "sign-up") {
                  setAuthMode("sign-up");
                  return;
                }
                onNavigate(view);
              }}
              redirectToPath={() => redeemPath}
            />
          ) : (
            <PublicSignUpForm
              onNavigate={(view) => {
                if (view === "sign-in") {
                  setAuthMode("sign-in");
                  return;
                }
                onNavigate(view);
              }}
              redirectToPath={() => redeemPath}
            />
          )}
        </>
      ) : (
        <>
          <Button
            disabled={code.trim().length < 8 || state === "redeeming"}
            size="large"
            type="primary"
            onClick={redeemCode}
          >
            {state === "redeeming" ? "Redeeming..." : "Redeem voucher"}
          </Button>

          {state === "redeemed" && (
            <Alert
              description={<DisplayCreatedItems createdItems={createdItems} />}
              message="Success! Your voucher was redeemed."
              showIcon
              type="success"
            />
          )}

          {state === "redeemed" && (
            <Button
              onClick={() => {
                setCode("");
                setCreatedItems([]);
                setError("");
                setState("input");
              }}
            >
              Redeem another voucher
            </Button>
          )}
        </>
      )}

      <Divider style={{ margin: "8px 0" }} />

      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Need help? Read the{" "}
        <a
          href="https://doc.cocalc.com/vouchers.html"
          rel="noreferrer"
          target="_blank"
        >
          voucher documentation
        </a>
        , open the{" "}
        <a href={joinUrlPath(appBasePath, "settings", "vouchers")}>
          Voucher Center
        </a>
        , or contact <a href={joinUrlPath(appBasePath, "support")}>support</a>.
      </Paragraph>
    </Space>
  );
}
