/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import humanizeList from "humanize-list";
import { Button, Select } from "antd";
import { useMemo } from "react";
import { CopyToClipBoard } from "@cocalc/frontend/components";
import { SERVER_SETTINGS_ENV_PREFIX } from "@cocalc/util/consts";
import { ConfigValid, RowType } from "@cocalc/util/db-schema/site-defaults";
import { version } from "@cocalc/util/smc-version";
import { ON_PREM_DEFAULT_QUOTAS, upgrades } from "@cocalc/util/upgrade-spec";
import { JsonEditor } from "../json-editor";
import { RowEntryInner, testIsInvalid } from "./row-entry-inner";
import { IsReadonly } from "./types";
import { useRootfsImages } from "@cocalc/frontend/rootfs/manifest";

const MAX_UPGRADES = upgrades.max_per_project;

const FIELD_DEFAULTS = {
  default_quotas: ON_PREM_DEFAULT_QUOTAS,
  max_upgrades: MAX_UPGRADES,
} as const;

export interface RowEntryInnerProps {
  name: string;
  value: string; // value is the rawValue (a string)
  valid?: ConfigValid;
  valid_labels?: Readonly<Record<string, string>>;
  password: boolean;
  isSet?: boolean;
  isClearing?: boolean;
  multiline?: number;
  isReadonly: IsReadonly | null;
  onChangeEntry: (name: string, value: string) => void;
  onDraftEntry: (name: string, value: string) => void;
  clearable?: boolean;
  onClearSecret?: (name: string) => void;
}

interface RowEntryProps extends RowEntryInnerProps {
  displayed_val?: string; // the processed rawValue
  hint?: React.JSX.Element;
  rowType?: RowType;
  onJsonEntryChange: (name: string, value?: string) => void;
  onChangeEntry: (name: string, value: string) => void;
  rootfsManifestUrls?: string[];
}

export function RowEntry({
  name,
  value,
  password,
  isSet,
  isClearing,
  displayed_val,
  valid,
  valid_labels,
  hint,
  rowType,
  multiline,
  isReadonly,
  onJsonEntryChange,
  onChangeEntry,
  onDraftEntry,
  clearable,
  onClearSecret,
  rootfsManifestUrls,
}: RowEntryProps) {
  if (isReadonly == null) return null; // typescript

  function ReadOnly({ readonly }) {
    if (readonly) {
      return (
        <>
          Value controlled via{" "}
          <code>
            ${SERVER_SETTINGS_ENV_PREFIX}_{name.toUpperCase()}
          </code>
          .
        </>
      );
    } else {
      return null;
    }
  }

  if (rowType == "header") {
    return <div />;
  } else {
    switch (name) {
      case "project_rootfs_prepull_images":
        return (
          <RootfsPrepullEntry
            name={name}
            value={value}
            isReadonly={isReadonly}
            onChangeEntry={onChangeEntry}
            manifestUrls={rootfsManifestUrls ?? []}
          />
        );
      case "default_quotas":
      case "max_upgrades":
        const ro: boolean = isReadonly[name];
        return (
          <>
            <JsonEntry
              name={name}
              data={value}
              readonly={ro}
              onJsonEntryChange={onJsonEntryChange}
            />
            <ReadOnly readonly={ro} />
          </>
        );
      default:
        const is_valid = !testIsInvalid(value, valid);
        return (
          <div>
            <RowEntryInner
              name={name}
              value={value}
              valid={valid}
              valid_labels={valid_labels}
              password={password}
              isSet={isSet}
              isClearing={isClearing}
              multiline={multiline}
              onChangeEntry={onChangeEntry}
              onDraftEntry={onDraftEntry}
              isReadonly={isReadonly}
              clearable={clearable}
              onClearSecret={onClearSecret}
            />
            <div style={{ fontSize: "90%", display: "inlineBlock" }}>
              {!Array.isArray(value) &&
              (name === "version_recommended_browser" ||
                name === "version_min_browser") ? (
                <VersionHint
                  name={name}
                  value={value}
                  readonly={!!isReadonly[name]}
                  onChangeEntry={onChangeEntry}
                />
              ) : undefined}
              {hint}
              <ReadOnly readonly={isReadonly[name]} />
              {displayed_val != null && !password && (
                <span>
                  {" "}
                  {is_valid ? "Interpreted as" : "Invalid:"}{" "}
                  <code>{displayed_val}</code>.{" "}
                </span>
              )}
              {valid != null && Array.isArray(valid) && (
                <span>Valid values: {humanizeList(valid)}.</span>
              )}
            </div>
          </div>
        );
    }
  }
}

// The required/recommended browser version: browsers whose frontend is older
// than it must (or are asked to) reload. It can be at most the version of the
// frontend that is being served, i.e. of this page once it has been reloaded
// after a deploy; the server caps it there (buildPublicSiteSettings), so a
// higher value would not lock out every browser, but it would not do what was
// intended either.
function VersionHint({
  name,
  value,
  readonly,
  onChangeEntry,
}: {
  name: string;
  value: string;
  readonly: boolean;
  onChangeEntry: (name: string, value: string) => void;
}) {
  const parsed = parseInt(value);
  let error;
  if (Number.isFinite(parsed) && parsed > version) {
    error = (
      <div
        style={{
          background: "red",
          color: "white",
          margin: "15px",
          padding: "15px",
        }}
      >
        Higher than the version of this page ({version}): no browser has a newer
        frontend than the one being served, so this is capped at the served
        version. Use the version of this page, after reloading it following a
        deploy.
      </div>
    );
  }
  return (
    <div style={{ marginTop: "15px", color: "#666" }}>
      Version of this page:{" "}
      <CopyToClipBoard
        style={{
          display: "inline-block",
          width: "50ex",
          margin: 0,
        }}
        value={`${version}`}
      />{" "}
      {!readonly && parsed !== version && (
        <Button size="small" onClick={() => onChangeEntry(name, `${version}`)}>
          Use this version
        </Button>
      )}
      {name === "version_min_browser" && (
        <div>
          Takes effect only up to the recommended version: set both to force
          every older browser to reload.
        </div>
      )}
      {error}
    </div>
  );
}

function RootfsPrepullEntry({
  name,
  value,
  isReadonly,
  onChangeEntry,
  manifestUrls,
}: {
  name: string;
  value: string;
  isReadonly: IsReadonly | null;
  onChangeEntry: (name: string, value: string) => void;
  manifestUrls: string[];
}) {
  const { images, loading, error } = useRootfsImages(manifestUrls);
  const selected = useMemo(
    () =>
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    [value],
  );
  const options = useMemo(
    () =>
      images.map((entry) => ({
        value: entry.image,
        label: entry.gpu ? `${entry.label} (GPU)` : entry.label || entry.image,
      })),
    [images],
  );
  const disabled = isReadonly?.[name] ?? false;

  return (
    <div>
      <Select
        mode="tags"
        style={{ width: "100%" }}
        placeholder="Select images to pre-pull"
        onChange={(vals) => onChangeEntry(name, vals.join(", "))}
        options={options}
        value={selected}
        disabled={disabled}
        loading={loading}
      />
      {error && (
        <div style={{ marginTop: "6px", color: "#a66", fontSize: "90%" }}>
          Manifest load issue: {error}
        </div>
      )}
    </div>
  );
}

// This is specific to on-premises kubernetes setups.
// The production site works differently.
// TODO: make this a more sophisticated data editor.
function JsonEntry({ name, data, readonly, onJsonEntryChange }) {
  const jsonValue = JSON.parse(data ?? "{}") ?? {};
  const quotas = { ...FIELD_DEFAULTS[name], ...jsonValue };
  const value = JSON.stringify(quotas);
  return (
    <JsonEditor
      value={value}
      readonly={readonly}
      rows={10}
      onSave={(value) => onJsonEntryChange(name, value)}
    />
  );
}
