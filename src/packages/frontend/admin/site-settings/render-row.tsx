/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Popover } from "antd";
import { CSSProperties } from "react";
import { Icon, LabeledRow, Markdown } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { managedRootfsCatalogUrl } from "@cocalc/frontend/rootfs/manifest";
import {
  evaluateSignupEmailDomainPolicy,
  normalizeSignupEmailDomainPolicy,
  publicSignupEmailDomainPolicy,
} from "@cocalc/util/accounts/signup-email-domain-policy";
import {
  Config,
  RowType,
  Tag,
  to_bool,
} from "@cocalc/util/db-schema/site-defaults";
import { COLORS } from "@cocalc/util/theme";
import { Data, IsReadonly, IsSet } from "./types";
import { RowEntry } from "./row-entry";

interface RenderRowProps {
  name: string;
  conf: Config;
  data: Data | null;
  isSet: IsSet | null;
  isClearing: { [name: string]: boolean };
  update: () => void;
  isReadonly: IsReadonly | null;
  onChangeEntry: (name: string, value: string) => void;
  onJsonEntryChange: (name: string, value: string) => void;
  filterStr: string;
  filterTag: Tag | null;
  isModified: (name: string) => boolean;
  isHeader: boolean;
  saveSingleSetting: (name: string) => void;
  onClearSecret: (name: string) => void;
  showHidden: boolean;
  showAdvanced: boolean;
  onOpenWizard?: (name: string) => void;
}

export function RenderRow({
  name,
  conf,
  data,
  isSet,
  isClearing,
  update,
  isReadonly,
  onChangeEntry,
  onJsonEntryChange,
  filterStr,
  filterTag,
  isModified,
  isHeader,
  saveSingleSetting,
  onClearSecret,
  showHidden,
  showAdvanced,
  onOpenWizard,
}: RenderRowProps) {
  const rootfsManifestUrls = [managedRootfsCatalogUrl()];
  if (data == null) return null;

  function matchesRequiredEquals(raw: any, equals: string | string[]) {
    if (Array.isArray(equals)) {
      return equals.some((value) => matchesRequiredEquals(raw, value));
    }
    if (
      equals === "yes" ||
      equals === "no" ||
      equals === "true" ||
      equals === "false"
    ) {
      return to_bool(raw) === to_bool(equals);
    }
    return raw === equals;
  }

  const requiredWhen = conf.required_when;
  const requiredActive =
    requiredWhen &&
    requiredWhen.every((req) => {
      const raw = data[req.key];
      if (req.equals !== undefined) {
        return matchesRequiredEquals(raw, req.equals);
      }
      if (req.present !== undefined) {
        return req.present ? !!raw : !raw;
      }
      return !!raw;
    });

  if (conf.hidden && !showHidden) return null;
  if (conf.advanced && !showAdvanced && !filterStr && !filterTag) {
    return null;
  }
  // if tags are used, we're strictly filtering by them
  if (filterTag) {
    if (!conf.tags) return null;
    if (!conf.tags.includes(filterTag)) {
      return null;
    }
  }
  // otherwise we're (additionally) filtering by the search string
  if (filterStr) {
    const { tags, name: title, desc } = conf;
    const f = filterStr.toLowerCase();
    const match_any_tag = tags && tags.includes(f as any);
    const x = [name, title, desc]
      .join(" ")
      .toLowerCase()
      .replace(/-/g, " ")
      .replace(/_/g, " ");
    if (!x.includes(f) && !match_any_tag) {
      return null;
    }
  }
  if (conf.cocalc_only) {
    if (!document.location.host.endsWith("cocalc.com")) {
      return null;
    }
  }
  // don't show certain fields, i.e. where show evals to false
  const isHiddenByShow = typeof conf.show == "function" && !conf.show(data);
  if (isHiddenByShow && !showHidden) {
    return null;
  }

  const rawValue = data[name] ?? conf.default;
  const hasSecret = isSet?.[name] ?? false;
  const isCleared = isClearing?.[name] ?? false;
  const rowType: RowType = conf.type ?? "setting";
  const missingValue = conf.password
    ? !(hasSecret || rawValue)
    : `${rawValue ?? ""}`.trim() === "";
  const requiredMissing = requiredActive && missingValue;

  // fallbacks: to_display? → to_val? → undefined
  const parsed_value: string | undefined =
    typeof conf.to_display == "function"
      ? `${conf.to_display(rawValue)}`
      : typeof conf.to_val == "function"
        ? `${conf.to_val(rawValue, data)}`
        : undefined;

  // not currently supported.
  // const clearable = conf.clearable ?? false;

  const label = (
    <div style={{ paddingRight: "15px" }}>
      <strong>{conf.name}</strong>{" "}
      {isHiddenByShow && (
        <span style={{ color: COLORS.GRAY_M, fontSize: "85%" }}>(hidden)</span>
      )}{" "}
      {requiredMissing && (
        <span style={{ color: "#a00", fontSize: "85%" }}>(required)</span>
      )}{" "}
      {conf.managed_by_wizard && (
        <span style={{ color: COLORS.GRAY_M, fontSize: "85%" }}>(wizard)</span>
      )}{" "}
      <RowHelp help={conf.help} />
      <br />
      <StaticMarkdown style={{ color: COLORS.GRAY_M }} value={conf.desc} />
    </div>
  );

  const hint = <RowHint conf={conf} rawValue={rawValue} />;

  let style = { marginTop: "15px", paddingLeft: "10px" } as CSSProperties;
  // indent optional fields
  if (typeof conf.show == "function" && rowType == "setting") {
    style = {
      ...style,
      borderLeft: `2px solid ${COLORS.GRAY}`,
      marginLeft: "0px",
      marginTop: "0px",
    } as CSSProperties;
  }

  function renderRowExtra() {
    if (isHeader) return null;
    const modified = isModified(name);
    return (
      <Button
        type={modified ? "primary" : "default"}
        disabled={!modified}
        size="middle"
        icon={<Icon name="save" />}
        onClick={() => saveSingleSetting(name)}
      />
    );
  }

  return (
    <LabeledRow
      label={label}
      key={name}
      style={style}
      label_cols={6}
      extra={renderRowExtra()}
    >
      {(() => {
        const wizard = conf.wizard;
        if (!wizard || !onOpenWizard) return null;
        return (
          <div style={{ marginBottom: "8px" }}>
            <Button
              size="middle"
              icon={<Icon name="magic" />}
              onClick={() => onOpenWizard(wizard.name)}
            >
              {wizard.label}
            </Button>
          </div>
        );
      })()}
      <RowEntry
        name={name}
        value={rawValue}
        password={conf.password ?? false}
        isSet={hasSecret}
        isClearing={isCleared}
        displayed_val={parsed_value}
        valid={conf.valid}
        valid_labels={conf.valid_labels}
        hint={hint}
        rowType={rowType}
        multiline={conf.multiline}
        isReadonly={isReadonly}
        onJsonEntryChange={onJsonEntryChange}
        onChangeEntry={onChangeEntry}
        clearable={conf.clearable}
        update={update}
        onClearSecret={onClearSecret}
        rootfsManifestUrls={rootfsManifestUrls}
      />
      {name === "signup_email_domain_policy_mode" && (
        <SignupEmailDomainPolicyPreview data={data} />
      )}
    </LabeledRow>
  );
}

function SignupEmailDomainPolicyPreview({ data }: { data: Data }) {
  const policy = normalizeSignupEmailDomainPolicy(data);
  const publicPolicy = publicSignupEmailDomainPolicy(data);
  const allowedSample =
    policy.allowRules[0] != null
      ? `student@${policy.allowRules[0].domain}`
      : "student@example.edu";
  const blockedSample =
    policy.mode === "deny_list" && policy.denyRules[0] != null
      ? `spammer@${policy.denyRules[0].domain}`
      : "student@not-approved.example";
  const allowedDecision = evaluateSignupEmailDomainPolicy({
    email_address: allowedSample,
    settings: data,
  });
  const blockedDecision = evaluateSignupEmailDomainPolicy({
    email_address: blockedSample,
    settings: data,
  });

  let message = "All verified email domains can create accounts.";
  let description =
    "No signup email domain restrictions are currently configured.";
  let type: "info" | "warning" = "info";

  if (policy.mode === "allow_only") {
    type = policy.allowRules.length === 0 ? "warning" : "info";
    message =
      policy.allowRules.length === 0
        ? "Allow-list mode has no allowed domains."
        : `Allow-list mode: ${policy.allowRules.length} domain rule${
            policy.allowRules.length === 1 ? "" : "s"
          } configured.`;
    description = [
      policy.allowRules.length === 0
        ? "New account creation and email-address changes will be blocked until at least one allowed domain is configured."
        : `${allowedSample} is ${
            allowedDecision.allowed ? "allowed" : "blocked"
          }; ${blockedSample} is ${
            blockedDecision.allowed ? "allowed" : "blocked"
          }.`,
      policy.showAllowedDomains
        ? "The allowed domain list is visible in public signup metadata."
        : "The allowed domain list is hidden from public signup metadata.",
      `Public message: ${publicPolicy.message ?? "(generic)"}`,
    ].join(" ");
  } else if (policy.mode === "deny_list") {
    message = `Deny-list mode: ${policy.denyRules.length} domain rule${
      policy.denyRules.length === 1 ? "" : "s"
    } configured.`;
    description = [
      `${blockedSample} is ${blockedDecision.allowed ? "allowed" : "blocked"}.`,
      "The deny list is never exposed through public customize data.",
      `Public message: ${publicPolicy.message ?? "(generic blocked message)"}`,
    ].join(" ");
  }

  return (
    <Alert
      type={type}
      showIcon
      message={message}
      description={description}
      style={{ marginTop: "12px" }}
    />
  );
}

function RowHint({ conf, rawValue }: { conf: Config; rawValue: string }) {
  if (typeof conf.hint == "function") {
    return <Markdown value={conf.hint(rawValue)} />;
  } else {
    return null;
  }
}

function RowHelp({ help }: { help?: string }) {
  if (typeof help !== "string") return null;
  return (
    <Popover
      content={
        <StaticMarkdown
          className={"admin-site-setting-popover-help"}
          style={{ fontSize: "90%" }}
          value={help}
        />
      }
      trigger={["hover", "click"]}
      placement="right"
      styles={{ root: { maxWidth: "500px" } }}
    >
      <Icon style={{ color: COLORS.GRAY }} name="question-circle" />
    </Popover>
  );
}
