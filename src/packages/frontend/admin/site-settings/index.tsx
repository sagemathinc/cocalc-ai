/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Tag as AntdTag,
  Button,
  Col,
  Input,
  InputRef,
  Modal,
  Row,
  Switch,
} from "antd";
import { isEqual } from "lodash";
import { useEffect, useMemo, useRef, useState } from "react";
import { Well } from "@cocalc/frontend/antd-bootstrap";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import useCounter from "@cocalc/frontend/app-framework/counter-hook";
import { Gap, Icon, Loading, Paragraph } from "@cocalc/frontend/components";
import { query } from "@cocalc/frontend/frame-editors/generic/client";
import { TAGS, Tag, to_bool } from "@cocalc/util/db-schema/site-defaults";
import { EXTRAS } from "@cocalc/util/db-schema/site-settings-extras";
import { deep_copy, keys } from "@cocalc/util/misc";
import { site_settings_conf } from "@cocalc/util/schema";
import { RenderRow } from "./render-row";
import { Data, IsClearing, IsReadonly, IsSet, State } from "./types";
import GcpServiceAccountWizard from "./gcp-service-account-wizard";
import NebiusCliWizard from "./nebius-cli-wizard";
import CloudflareConfigWizard from "./cloudflare-config-wizard";
import LauncherDefaultsWizard from "./launcher-defaults-wizard";
import {
  toCustomOpenAIModel,
  toOllamaModel,
} from "@cocalc/util/db-schema/llm-utils";
import ShowError from "@cocalc/frontend/components/error";

const { CheckableTag } = AntdTag;

export default function SiteSettings({ close }) {
  const { inc: change } = useCounter();
  const cloudflareStatus = useTypedRedux(
    "customize",
    "launchpad_cloudflare_tunnel_status",
  );
  const testEmailRef = useRef<InputRef>(null);
  const [_, setDisableTests] = useState<boolean>(false);
  const [state, setState] = useState<State>("load");
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<Data | null>(null);
  const [isSet, setIsSet] = useState<IsSet | null>(null);
  const [filterStr, setFilterStr] = useState<string>("");
  const [filterTag, setFilterTag] = useState<Tag | null>(null);
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [expandAll, setExpandAll] = useState<boolean>(false);
  const [activeWizard, setActiveWizard] = useState<string | null>(null);
  const editedRef = useRef<Data | null>(null);
  const savedRef = useRef<Data | null>(null);
  const clearSecretsRef = useRef<IsClearing>({});
  const [isReadonly, setIsReadonly] = useState<IsReadonly | null>(null);
  const update = () => {
    setData(deep_copy(editedRef.current));
  };

  useEffect(() => {
    load();
  }, []);

  const prevExpandAllRef = useRef<boolean>(expandAll);

  useEffect(() => {
    const details = document.querySelectorAll(
      "details[data-admin-subgroup]",
    ) as NodeListOf<HTMLDetailsElement>;
    if (expandAll) {
      details.forEach((el) => {
        el.open = true;
      });
    } else if (prevExpandAllRef.current) {
      details.forEach((el) => {
        el.open = false;
      });
    }
    prevExpandAllRef.current = expandAll;
  }, [expandAll, filterStr, filterTag, showAdvanced, showHidden, data]);

  async function load(): Promise<void> {
    setState("load");
    let result: any;
    try {
      result = await query({
        query: {
          site_settings: [
            { name: null, value: null, readonly: null, is_set: null },
          ],
        },
      });
    } catch (err) {
      setState("error");
      setError(`${err} – query error, please try again…`);
      return;
    }
    const data: { [name: string]: string } = {};
    const isReadonly: IsReadonly = {};
    const isSet: IsSet = {};
    for (const x of result.query.site_settings) {
      data[x.name] = x.value;
      isReadonly[x.name] = !!x.readonly;
      isSet[x.name] = !!x.is_set;
    }
    if (!data.cloudflare_mode || `${data.cloudflare_mode}`.trim() === "") {
      data.cloudflare_mode = to_bool(
        data.project_hosts_cloudflare_tunnel_enabled,
      )
        ? "self"
        : "none";
    }
    setState("edit");
    setData(data);
    setIsReadonly(isReadonly);
    setIsSet(isSet);
    clearSecretsRef.current = {};
    editedRef.current = deep_copy(data);
    savedRef.current = deep_copy(data);
    setDisableTests(false);
  }

  // returns true if the given settings key is a header
  function isHeader(name: string): boolean {
    return (
      EXTRAS[name]?.type == "header" ||
      site_settings_conf[name]?.type == "header"
    );
  }

  function isModified(name: string) {
    if (data == null || editedRef.current == null || savedRef.current == null)
      return false;

    const edited = editedRef.current[name];
    const saved = savedRef.current[name];
    if (clearSecretsRef.current?.[name]) return true;
    return !isEqual(edited, saved);
  }

  function shouldShowSetting(name: string, conf): boolean {
    if (data == null) return false;
    if (conf.hidden && !showHidden) return false;
    if (conf.cocalc_only) {
      if (!document.location.host.endsWith("cocalc.com")) {
        return false;
      }
    }
    const isHiddenByShow = typeof conf.show == "function" && !conf.show(data);
    if (isHiddenByShow && !showHidden) {
      return false;
    }
    if (conf.advanced && !showAdvanced && !filterStr && !filterTag) {
      return false;
    }
    if (filterTag) {
      if (!conf.tags) return false;
      if (!conf.tags.includes(filterTag)) {
        return false;
      }
    }
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
        return false;
      }
    }
    return true;
  }

  function inferGroup(conf): string {
    const tags = conf.tags ?? [];
    if (tags.includes("Cloudflare")) return "Cloudflare";
    return tags[0] ?? "Other";
  }

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

  function isRequiredWhen(conf): boolean {
    const reqs = conf.required_when;
    if (!reqs || !data) return false;
    return reqs.every((req) => {
      const raw = data[req.key];
      if (req.equals !== undefined) {
        return matchesRequiredEquals(raw, req.equals);
      }
      if (req.present !== undefined) {
        return req.present ? !!raw : !raw;
      }
      return !!raw;
    });
  }

  function isMissingValue(name: string, conf): boolean {
    const rawValue = data?.[name] ?? conf.default ?? "";
    if (conf.password) {
      return !(isSet?.[name] ?? rawValue);
    }
    return `${rawValue}`.trim() === "";
  }

  function getModifiedSettings() {
    if (data == null || editedRef.current == null || savedRef.current == null)
      return [];

    const ret: { name: string; value: string }[] = [];
    for (const name in editedRef.current) {
      const value = editedRef.current[name];
      if (isHeader[name]) continue;
      if (isModified(name)) {
        ret.push({ name, value });
      }
    }
    ret.sort((a, b) => a.name.localeCompare(b.name));
    return ret;
  }

  async function store(): Promise<void> {
    if (data == null || editedRef.current == null || savedRef.current == null)
      return;
    for (const { name, value } of getModifiedSettings()) {
      const spec = site_settings_conf[name] ?? EXTRAS[name];
      const clearing = !!clearSecretsRef.current?.[name];
      const outgoingValue = clearing ? "" : value;
      try {
        await query({
          query: {
            site_settings: { name, value: outgoingValue },
          },
        });
        savedRef.current[name] = outgoingValue;
        if (clearing) {
          clearSecretsRef.current[name] = false;
        }
        if (spec?.password && isSet != null) {
          setIsSet((prev) => ({
            ...(prev ?? {}),
            [name]: outgoingValue !== "",
          }));
        }
      } catch (err) {
        setState("error");
        setError(err);
        return;
      }
    }
    // success save of everything, so clear error message
    setError("");
  }

  async function saveAll(): Promise<void> {
    // list the names of changed settings
    const content = (
      <Paragraph>
        <ul>
          {getModifiedSettings().map(({ name, value }) => {
            const spec = site_settings_conf[name] ?? EXTRAS[name];
            const label = spec?.name ?? name;
            const displayValue = spec?.password
              ? value
                ? "[updated]"
                : "[cleared]"
              : value;
            return (
              <li key={name}>
                <b>{label}</b>: <code>{displayValue}</code>
              </li>
            );
          })}
        </ul>
      </Paragraph>
    );

    setState("save");

    Modal.confirm({
      title: "Confirm changing the following settings?",
      icon: <Icon name="warning" />,
      width: 700,
      content,
      onOk() {
        return new Promise<void>(async (done, error) => {
          try {
            await store();
            setState("edit");
            await load();
            done();
          } catch (err) {
            error(err);
          }
        });
      },
      onCancel() {
        close();
      },
    });
  }

  // this is the small grene button, there is no confirmation
  async function saveSingleSetting(name: string): Promise<void> {
    if (data == null || editedRef.current == null || savedRef.current == null)
      return;
    const spec = site_settings_conf[name] ?? EXTRAS[name];
    const value = editedRef.current[name];
    const clearing = !!clearSecretsRef.current?.[name];
    const outgoingValue = clearing ? "" : value;
    setState("save");
    try {
      await query({
        query: {
          site_settings: { name, value: outgoingValue },
        },
      });
      savedRef.current[name] = outgoingValue;
      if (clearing) {
        clearSecretsRef.current[name] = false;
      }
      if (spec?.password && isSet != null) {
        setIsSet((prev) => ({
          ...(prev ?? {}),
          [name]: outgoingValue !== "",
        }));
      }
      setState("edit");
    } catch (err) {
      setState("error");
      setError(err);
      return;
    }
  }

  function SaveButton() {
    if (data == null || savedRef.current == null) return null;
    let disabled: boolean = true;
    for (const name in { ...savedRef.current, ...data }) {
      const value = savedRef.current[name];
      if (!isEqual(value, data[name])) {
        disabled = false;
        break;
      }
    }

    return (
      <Button type="primary" disabled={disabled} onClick={saveAll}>
        {state == "save" ? <Loading text="Saving" /> : "Save All"}
      </Button>
    );
  }

  function CancelButton() {
    return <Button onClick={close}>Cancel</Button>;
  }

  function onChangeEntry(name: string, val: string) {
    if (editedRef.current == null) return;
    clearSecretsRef.current[name] = false;
    editedRef.current[name] = val;
    if (name === "cloudflare_mode") {
      editedRef.current.project_hosts_cloudflare_tunnel_enabled =
        val === "self" ? "yes" : "no";
    }
    change();
    update();
  }

  function onClearSecret(name: string) {
    if (editedRef.current == null) return;
    editedRef.current[name] = "";
    clearSecretsRef.current[name] = true;
    change();
    update();
  }

  function onJsonEntryChange(name: string, new_val?: string) {
    if (editedRef.current == null) return;
    try {
      if (new_val == null) return;
      JSON.parse(new_val); // does it throw?
      editedRef.current[name] = new_val;
    } catch (err) {
      // TODO: obviously this should be visible to the user!  Gees.
      console.warn(`Error saving json of ${name}`, err.message);
    }
    change();
    update(); // without that, the "green save button" does not show up. this makes it consistent.
  }

  function Buttons() {
    return (
      <div>
        <CancelButton />
        <Gap />
        <SaveButton />
      </div>
    );
  }

  function openWizard(name: string) {
    setActiveWizard(name);
  }

  function closeWizard() {
    setActiveWizard(null);
  }

  async function applyWizardSettings(values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      onChangeEntry(name, value);
    }
    if (editedRef.current == null || savedRef.current == null) return;
    setState("save");
    try {
      await store();
      setState("edit");
      await load();
    } catch (err) {
      setState("error");
      setError(err);
    }
  }

  function Tests() {
    return (
      <div style={{ marginBottom: "1rem" }}>
        <strong>Tests:</strong>
        <Gap />
        Email:
        <Gap />
        <Input
          style={{ width: "auto" }}
          defaultValue={redux.getStore("account").get("email_address")}
          ref={testEmailRef}
        />
      </div>
    );
  }

  function Warning() {
    const showCloudflareWarning =
      cloudflareStatus?.enabled &&
      (!cloudflareStatus.running || cloudflareStatus.error);
    return (
      <div>
        {showCloudflareWarning && (
          <Alert
            type="warning"
            style={{
              maxWidth: "800px",
              margin: "0 auto 20px auto",
              border: "1px solid lightgrey",
            }}
            message={
              <div>
                <b>Cloudflare tunnel is not healthy.</b>{" "}
                {cloudflareStatus?.error
                  ? `Details: ${cloudflareStatus.error}`
                  : "Project hosts will not work until the tunnel is running."}
              </div>
            }
          />
        )}
        <Alert
          type="warning"
          style={{
            maxWidth: "800px",
            margin: "0 auto 20px auto",
            border: "1px solid lightgrey",
          }}
          message={
            <div>
              <i>
                <ul style={{ marginBottom: 0 }}>
                  <li>
                    Most settings will take effect within 1 minute of save;
                    however, some might require restarting the server.
                  </li>
                  <li>
                    If the box containing a setting has a red border, that means
                    the value that you entered is invalid.
                  </li>
                </ul>
              </i>
            </div>
          }
        />
      </div>
    );
  }

  const setupOverview = useMemo(() => {
    if (data == null) return [];
    const groupMap = new Map<
      string,
      { count: number; names: string[]; key: string }
    >();
    for (const configData of [site_settings_conf, EXTRAS]) {
      for (const name of keys(configData)) {
        const conf = configData[name];
        if (!conf.required_when) continue;
        if (!isRequiredWhen(conf)) continue;
        if (!isMissingValue(name, conf)) continue;
        const group = conf.group ?? inferGroup(conf);
        const entry =
          groupMap.get(group) ??
          ({
            count: 0,
            names: [] as string[],
            key: group,
          });
        entry.count += 1;
        entry.names.push(conf?.name ?? name);
        groupMap.set(group, entry);
      }
    }
    return [...groupMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, isSet, showHidden, showAdvanced]);

  const groupStatus = useMemo(() => {
    if (data == null) return new Map<string, boolean>();
    const status = new Map<string, boolean>();
    for (const configData of [site_settings_conf, EXTRAS]) {
      for (const name of keys(configData)) {
        const conf = configData[name];
        const group = conf.group ?? inferGroup(conf);
        if (!status.has(group)) status.set(group, true);
        if (!conf.required_when) continue;
        if (!isRequiredWhen(conf)) continue;
        if (isMissingValue(name, conf)) {
          status.set(group, false);
        }
      }
    }
    return status;
  }, [data, isSet, showHidden, showAdvanced]);

  const groupMissingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [group, info] of setupOverview) {
      counts.set(group, info.count);
    }
    return counts;
  }, [setupOverview]);

  const subgroupMissingCounts = useMemo(() => {
    if (data == null) return new Map<string, Map<string, number>>();
    const counts = new Map<string, Map<string, number>>();
    for (const configData of [site_settings_conf, EXTRAS]) {
      for (const name of keys(configData)) {
        const conf = configData[name];
        if (!conf.required_when) continue;
        if (!isRequiredWhen(conf)) continue;
        if (!isMissingValue(name, conf)) continue;
        const group = conf.group ?? inferGroup(conf);
        const subgroup = conf.subgroup ?? "General";
        const groupCounts =
          counts.get(group) ?? new Map<string, number>();
        groupCounts.set(subgroup, (groupCounts.get(subgroup) ?? 0) + 1);
        counts.set(group, groupCounts);
      }
    }
    return counts;
  }, [data, isSet, showHidden, showAdvanced]);

  const editRows = useMemo(() => {
    const allItems: { name: string; conf: any }[] = [];
    for (const configData of [site_settings_conf, EXTRAS]) {
      for (const name of keys(configData)) {
        const conf = configData[name];
        allItems.push({ name, conf });
      }
    }
    const visibleItems = allItems.filter(({ name, conf }) =>
      shouldShowSetting(name, conf),
    );
    const groupMap = new Map<
      string,
      Map<string, { name: string; conf: any }[]>
    >();
    for (const item of visibleItems) {
      const group = item.conf.group ?? inferGroup(item.conf);
      const subgroup = item.conf.subgroup ?? "General";
      const subMap =
        groupMap.get(group) ??
        new Map<string, { name: string; conf: any }[]>();
      const list = subMap.get(subgroup) ?? [];
      list.push(item);
      subMap.set(subgroup, list);
      groupMap.set(group, subMap);
    }
    const GROUP_ORDER = [
      "Setup Overview",
      "Networking",
      "Cloudflare",
      "Branding & UI",
      "Backups & Storage",
      "Compute / Project Hosts",
      "Access & Identity",
      "Messaging & Email",
      "AI & LLM",
      "Payments & Billing",
      "Support / Integrations",
      "System / Advanced",
      "Other",
    ];
    const groupEntries = [...groupMap.entries()].sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a[0]);
      const bi = GROUP_ORDER.indexOf(b[0]);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return a[0].localeCompare(b[0]);
    });

    return (
      <>
        {groupEntries.map(([groupName, subgroups]) => (
          <div key={groupName} style={{ marginTop: "16px" }}>
            <div
              id={`admin-settings-group-${groupName}`}
              style={{ display: "flex", alignItems: "center", gap: "8px" }}
            >
              <h3 style={{ marginBottom: "6px" }}>{groupName}</h3>
              {groupStatus.has(groupName) && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "22px",
                    height: "22px",
                    borderRadius: "50%",
                    background: groupStatus.get(groupName) ? "#d6f5d6" : "#ffe2e2",
                    color: groupStatus.get(groupName) ? "#1f7a1f" : "#a00",
                    fontWeight: 700,
                    fontSize: "12px",
                  }}
                  title={
                    groupStatus.get(groupName)
                      ? "All required settings present"
                      : "Missing required settings"
                  }
                >
                  {groupStatus.get(groupName) ? "✓" : "!"}
                </span>
              )}
              {groupMissingCounts.get(groupName) != null && (
                <span style={{ color: "#a00", fontSize: "85%" }}>
                  {groupMissingCounts.get(groupName)} missing
                </span>
              )}
            </div>
            {[...subgroups.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([subgroupName, items]) => (
                <details data-admin-subgroup key={`${groupName}-${subgroupName}`}>
                  <summary
                    style={{
                      margin: "10px 0 4px 0",
                      color: "#666",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    {subgroupName}
                    {subgroupMissingCounts
                      .get(groupName)
                      ?.get(subgroupName) ? (
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#a8071a",
                          background: "#fff1f0",
                          border: "1px solid #ffccc7",
                          borderRadius: "10px",
                          padding: "1px 8px",
                        }}
                      >
                        {subgroupMissingCounts.get(groupName)?.get(subgroupName)}{" "}
                        missing
                      </span>
                    ) : null}
                  </summary>
                  {items
                    .sort((a, b) => {
                      const orderA = a.conf.order ?? 1000;
                      const orderB = b.conf.order ?? 1000;
                      if (orderA !== orderB) return orderA - orderB;
                      return a.conf.name.localeCompare(b.conf.name);
                    })
                    .map(({ name, conf }) => {
                      // This is a weird special case, where the valid value depends on other values
                      if (name === "default_llm") {
                        const c = site_settings_conf.selectable_llms;
                        const llms =
                          c.to_val?.(data?.selectable_llms ?? c.default) ?? [];
                        const o = EXTRAS.ollama_configuration;
                        const oll = Object.keys(
                          o.to_val?.(data?.ollama_configuration) ?? {},
                        ).map(toOllamaModel);
                        const a = EXTRAS.ollama_configuration;
                        const oaic = data?.custom_openai_configuration;
                        const oai = (
                          oaic != null ? Object.keys(a.to_val?.(oaic) ?? {}) : []
                        ).map(toCustomOpenAIModel);
                        if (Array.isArray(llms)) {
                          conf.valid = [...llms, ...oll, ...oai];
                        }
                      }

                      return (
                        <RenderRow
                          filterStr={filterStr}
                          filterTag={filterTag}
                          key={name}
                          name={name}
                          conf={conf}
                          data={data}
                          isSet={isSet}
                          isClearing={clearSecretsRef.current}
                          update={update}
                          isReadonly={isReadonly}
                          onChangeEntry={onChangeEntry}
                          onJsonEntryChange={onJsonEntryChange}
                          isModified={isModified}
                          isHeader={isHeader(name)}
                          saveSingleSetting={saveSingleSetting}
                          onClearSecret={onClearSecret}
                          showHidden={showHidden}
                          showAdvanced={showAdvanced}
                          onOpenWizard={openWizard}
                        />
                      );
                    })}
                </details>
              ))}
          </div>
        ))}
      </>
    );
  }, [state, data, isSet, filterStr, filterTag, showHidden, showAdvanced]);

  const activeFilter = !filterStr.trim() || filterTag;

  return (
    <div>
      {state == "save" && (
        <Loading
          delay={1000}
          style={{ float: "right", fontSize: "15pt" }}
          text="Saving site configuration..."
        />
      )}
      {state == "load" && (
        <Loading
          delay={1000}
          style={{ float: "right", fontSize: "15pt" }}
          text="Loading site configuration..."
        />
      )}
      <Well
        style={{
          margin: "auto",
          maxWidth: "80%",
        }}
      >
        <Warning />
        <ShowError
          error={error}
          setError={setError}
          style={{ margin: "30px auto", maxWidth: "800px" }}
        />
        {setupOverview.length > 0 && (
          <Alert
            showIcon
            type="warning"
            style={{ maxWidth: "900px", margin: "20px auto" }}
            message="Setup overview"
            description={
              <ul style={{ marginBottom: 0 }}>
                {setupOverview.map(([group, info]) => (
                  <li key={group}>
                    <Button
                      type="link"
                      style={{ padding: 0 }}
                      onClick={() => {
                        const el = document.getElementById(
                          `admin-settings-group-${group}`,
                        );
                        if (el) {
                          el.scrollIntoView({ behavior: "smooth", block: "start" });
                        }
                      }}
                    >
                      {group}
                    </Button>
                    : {info.count} missing required setting
                    {info.count === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            }
          />
        )}
        <CloudflareConfigWizard
          open={activeWizard === "cloudflare-config"}
          onClose={closeWizard}
          data={data ?? {}}
          isSet={isSet ?? {}}
          onApply={applyWizardSettings}
        />
        <GcpServiceAccountWizard
          open={activeWizard === "gcp-service-account-json"}
          onClose={closeWizard}
          onApplyJson={(json) =>
            onJsonEntryChange("google_cloud_service_account_json", json)
          }
          currentJson={data?.google_cloud_service_account_json}
          domainName={data?.dns}
        />
        <NebiusCliWizard
          open={activeWizard === "nebius-cli"}
          onClose={closeWizard}
          onApply={applyWizardSettings}
          softwareBaseUrl={data?.project_hosts_software_base_url}
        />
        <LauncherDefaultsWizard
          open={activeWizard === "launcher-defaults"}
          onClose={closeWizard}
          data={data ?? {}}
          onApply={applyWizardSettings}
        />
        <Row key="filter">
          <Col span={12}>
            <Buttons />
          </Col>
          <Col span={12}>
            <Input.Search
              style={{ marginBottom: "5px" }}
              allowClear
              value={filterStr}
              placeholder="Filter Site Settings..."
              onChange={(e) => setFilterStr(e.target.value)}
            />
            {[...TAGS].sort().map((name) => (
              <CheckableTag
                key={name}
                style={{ cursor: "pointer" }}
                checked={filterTag === name}
                onChange={(checked) => {
                  if (checked) {
                    setFilterTag(name);
                  } else {
                    setFilterTag(null);
                  }
                }}
              >
                {name}
              </CheckableTag>
            ))}
            <div
              style={{
                marginTop: "8px",
                display: "flex",
                gap: "16px",
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <span>
                <Switch
                  checked={showHidden}
                  onChange={(value) => setShowHidden(value)}
                />{" "}
                Show hidden
              </span>
              <span>
                <Switch
                  checked={showAdvanced}
                  onChange={(value) => setShowAdvanced(value)}
                />{" "}
                Show advanced
              </span>
              <span>
                <Switch
                  checked={expandAll}
                  onChange={(value) => setExpandAll(value)}
                />{" "}
                Expand all
              </span>
            </div>
          </Col>
        </Row>
        {editRows}
        <Gap />
        {!activeFilter && <Tests />}
        {!activeFilter && <Buttons />}
        {activeFilter ? (
          <Alert
            showIcon
            type="warning"
            message={`Some items may be hidden by the search filter or a selected tag.`}
          />
        ) : undefined}
      </Well>
    </div>
  );
}
