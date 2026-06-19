/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect, useState } from "react";

import {
  Alert,
  Button,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
} from "antd";

import { Icon, Paragraph } from "@cocalc/frontend/components";
import { openProjectAppStatus } from "@cocalc/frontend/project/app-server-open";
import DirectorySelector from "@cocalc/frontend/project/directory-selector";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { ensure_project_running } from "@cocalc/frontend/project/project-start-warning";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import { normalizeRootfsContentManifest } from "@cocalc/util/rootfs-images";

import type { AppSpec } from "@cocalc/conat/project/api/apps";
import type {
  RootfsContentAction,
  RootfsContentManifest,
  RootfsImageEntry,
} from "@cocalc/util/rootfs-images";

import { RuntimeAction, RuntimePanel } from "./rootfs-runtime-panel";

export type RootfsContentActionDraft = RootfsContentAction & {
  draft_id: string;
};

export type RootfsContentDraft = {
  title: string;
  subtitle: string;
  description: string;
  publisher_name: string;
  publisher_url: string;
  license_name: string;
  license_url: string;
  highlights: string[];
  actions: RootfsContentActionDraft[];
};

export type RootfsContentDirectoryPicker = {
  actionIndex: number;
  field: "path" | "source_path";
  pendingPath: string;
} | null;

export function RootfsContentManifestBuilder({
  draft,
  onChange,
  onPickDirectory,
  onSave,
  previewEntry,
  project_id,
  validation,
}: {
  draft: RootfsContentDraft;
  onChange: (
    value:
      | RootfsContentDraft
      | ((current: RootfsContentDraft) => RootfsContentDraft),
  ) => void;
  onPickDirectory: (
    actionIndex: number,
    field: "path" | "source_path",
    currentPath: string,
  ) => void;
  onSave?: () => Promise<void>;
  previewEntry: RootfsImageEntry;
  project_id: string;
  validation: ReturnType<typeof normalizeRootfsContentManifest>;
}): React.JSX.Element {
  const [saving, setSaving] = useState<boolean>(false);
  const [configuredAppSpecs, setConfiguredAppSpecs] = useState<AppSpec[]>([]);
  const [configuredAppsLoading, setConfiguredAppsLoading] =
    useState<boolean>(false);
  const [configuredAppsError, setConfiguredAppsError] = useState<string>("");
  const projectHome = getProjectHomeDirectory(project_id);

  useEffect(() => {
    let cancelled = false;
    async function loadConfiguredApps(): Promise<void> {
      try {
        setConfiguredAppsLoading(true);
        setConfiguredAppsError("");
        const api = webapp_client.conat_client.projectApi({ project_id });
        const records = await api.apps.listAppSpecs();
        if (cancelled) return;
        setConfiguredAppSpecs(
          records
            .map((record) => record.spec)
            .filter((spec): spec is AppSpec => spec != null)
            .sort((a, b) =>
              rootfsProjectAppSpecTitle(a).localeCompare(
                rootfsProjectAppSpecTitle(b),
              ),
            ),
        );
      } catch (err) {
        if (!cancelled) {
          setConfiguredAppsError(`${err}`);
        }
      } finally {
        if (!cancelled) {
          setConfiguredAppsLoading(false);
        }
      }
    }
    void loadConfiguredApps();
    return () => {
      cancelled = true;
    };
  }, [project_id]);

  function setField<K extends keyof RootfsContentDraft>(
    field: K,
    value: RootfsContentDraft[K],
  ): void {
    onChange((cur) => ({ ...cur, [field]: value }));
  }

  function updateAction(
    index: number,
    patch: Partial<RootfsContentActionDraft>,
  ): void {
    onChange((cur) => ({
      ...cur,
      actions: cur.actions.map((action, i) =>
        i === index
          ? normalizeRootfsContentActionDraft({ ...action, ...patch })
          : action,
      ),
    }));
  }

  function addAction(kind: RootfsContentAction["kind"]): void {
    const appSpec = kind === "project-app" ? configuredAppSpecs[0] : undefined;
    onChange((cur) => ({
      ...cur,
      actions: [
        ...cur.actions,
        defaultRootfsContentActionDraft(kind, undefined, appSpec),
      ],
    }));
  }

  async function save(): Promise<void> {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        The discovery config adds browse, copy-to-HOME, open, external link, and
        one-click project app launch actions to the RootFS component so users
        can quickly find and use the files and services bundled with this image.
      </Paragraph>

      <div style={{ position: "relative" }}>
        <Tag
          color="blue"
          style={{
            marginInlineEnd: 0,
            position: "absolute",
            right: 12,
            top: 12,
            zIndex: 1,
          }}
        >
          Preview
        </Tag>
        {validation.content ? (
          renderRootfsContentPanel({
            entry: previewEntry,
            onCopyToHome: async () => undefined,
            onLaunchProjectApp: async () => undefined,
            onOpenPath: () => undefined,
          })
        ) : (
          <Alert
            type="info"
            showIcon
            message="No preview yet."
            description="Add a title, description, highlight, or action to create the discovery panel."
          />
        )}
      </div>

      <RuntimePanel
        icon="book"
        title="Edit discovery config"
        subtitle="This saves to the RootFS catalog entry metadata. It is not written into the immutable image filesystem."
      >
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
            }}
          >
            <RootfsContentField label="Title">
              <Input
                value={draft.title}
                onChange={(e) => setField("title", e.target.value)}
                placeholder="e.g. Computational Biology Workshop"
              />
            </RootfsContentField>
            <RootfsContentField label="Subtitle">
              <Input
                value={draft.subtitle}
                onChange={(e) => setField("subtitle", e.target.value)}
                placeholder="A short one-line summary"
              />
            </RootfsContentField>
          </div>
          <RootfsContentField label="Description">
            <Input.TextArea
              rows={3}
              value={draft.description}
              onChange={(e) => setField("description", e.target.value)}
              placeholder="Explain what is included and how the image should be used."
            />
          </RootfsContentField>
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
            }}
          >
            <RootfsContentField label="Publisher">
              <Space direction="vertical" size={6} style={{ width: "100%" }}>
                <Input
                  value={draft.publisher_name}
                  onChange={(e) => setField("publisher_name", e.target.value)}
                  placeholder="Publisher name"
                />
                <Input
                  value={draft.publisher_url}
                  onChange={(e) => setField("publisher_url", e.target.value)}
                  placeholder="https://..."
                />
              </Space>
            </RootfsContentField>
            <RootfsContentField label="License">
              <Space direction="vertical" size={6} style={{ width: "100%" }}>
                <Input
                  value={draft.license_name}
                  onChange={(e) => setField("license_name", e.target.value)}
                  placeholder="License name"
                />
                <Input
                  value={draft.license_url}
                  onChange={(e) => setField("license_url", e.target.value)}
                  placeholder="https://..."
                />
              </Space>
            </RootfsContentField>
          </div>
          <RootfsContentField label="Highlights">
            <Select
              mode="tags"
              value={draft.highlights}
              onChange={(values) =>
                setField(
                  "highlights",
                  values.map((value) => `${value}`.trim()).filter(Boolean),
                )
              }
              tokenSeparators={[","]}
              placeholder="Add short highlights users should notice"
              style={{ width: "100%" }}
            />
          </RootfsContentField>

          <RootfsContentField
            label={
              <Space size={8}>
                <span>Actions</span>
                <Button size="small" onClick={() => addAction("browse")}>
                  Add browse
                </Button>
                <Button size="small" onClick={() => addAction("copy-to-home")}>
                  Add copy
                </Button>
                <Button size="small" onClick={() => addAction("open")}>
                  Add open
                </Button>
                <Button size="small" onClick={() => addAction("external-link")}>
                  Add link
                </Button>
                <Button
                  disabled={configuredAppSpecs.length === 0}
                  loading={configuredAppsLoading}
                  size="small"
                  onClick={() => addAction("project-app")}
                >
                  Add app
                </Button>
              </Space>
            }
          >
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              {configuredAppsError ? (
                <Alert
                  type="warning"
                  showIcon
                  message="Unable to load configured project apps."
                  description={configuredAppsError}
                />
              ) : null}
              {!configuredAppsLoading &&
              configuredAppSpecs.length === 0 &&
              draft.actions.some((action) => action.kind === "project-app") ? (
                <Alert
                  type="warning"
                  showIcon
                  message="No configured project apps found."
                  description="Configure and test an app in this project first, then add it to the manifest."
                />
              ) : null}
              {draft.actions.length === 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message="No actions yet."
                  description="Add a browse, copy, open, external link, or app action to help users find the bundled content."
                />
              ) : null}
              {draft.actions.map((action, index) => (
                <RootfsContentActionEditor
                  action={action}
                  configuredAppSpecs={configuredAppSpecs}
                  index={index}
                  key={action.draft_id}
                  onPickDirectory={onPickDirectory}
                  onRemove={() =>
                    onChange((cur) => ({
                      ...cur,
                      actions: cur.actions.filter((_, i) => i !== index),
                    }))
                  }
                  onUpdate={(patch) => updateAction(index, patch)}
                  projectHome={projectHome}
                />
              ))}
            </Space>
          </RootfsContentField>

          {validation.warnings.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="Discovery config warnings"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {validation.warnings.map((warning, index) => (
                    <li key={`${warning.code}-${index}`}>
                      {warning.path ? <code>{warning.path}: </code> : null}
                      {warning.message}
                    </li>
                  ))}
                </ul>
              }
            />
          ) : null}

          <Space wrap>
            {onSave ? (
              <Button
                icon={<Icon name="save" />}
                loading={saving}
                onClick={save}
              >
                Save discovery config
              </Button>
            ) : null}
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {onSave
                ? "This updates the catalog entry metadata used by the RootFS page and project RootFS panel."
                : "This config is saved into catalog metadata when you publish the live project RootFS."}
            </Paragraph>
          </Space>
        </Space>
      </RuntimePanel>
    </Space>
  );
}

function RootfsContentField({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <Paragraph strong style={{ marginBottom: 6 }}>
        {label}
      </Paragraph>
      {children}
    </div>
  );
}

function RootfsContentActionEditor({
  action,
  configuredAppSpecs,
  index,
  onPickDirectory,
  onRemove,
  onUpdate,
  projectHome,
}: {
  action: RootfsContentActionDraft;
  configuredAppSpecs: AppSpec[];
  index: number;
  onPickDirectory: (
    actionIndex: number,
    field: "path" | "source_path",
    currentPath: string,
  ) => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<RootfsContentActionDraft>) => void;
  projectHome: string;
}): React.JSX.Element {
  const pathField =
    action.kind === "copy-to-home" ? (
      <>
        <RootfsContentPathInput
          buttonLabel="Choose source..."
          label="Source path"
          onPick={() =>
            onPickDirectory(index, "source_path", action.source_path ?? "/")
          }
          onUpdate={(source_path) => onUpdate({ source_path })}
          placeholder="/usr/local/share/examples"
          value={action.source_path ?? ""}
        />
        <RootfsContentField label="Target path in HOME">
          <Input
            value={action.target_path ?? ""}
            onChange={(e) => onUpdate({ target_path: e.target.value })}
            placeholder="examples"
          />
        </RootfsContentField>
      </>
    ) : action.kind === "external-link" ? (
      <RootfsContentField label="URL">
        <Input
          value={action.url ?? ""}
          onChange={(e) => onUpdate({ url: e.target.value })}
          placeholder="https://..."
        />
      </RootfsContentField>
    ) : action.kind === "project-app" ? (
      <>
        <RootfsContentField label="Configured app">
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: "100%" }}
            value={rootfsProjectAppSpecId(action.app_spec) || undefined}
            placeholder="Choose a configured app"
            options={configuredAppSpecs.map((spec) => ({
              value: rootfsProjectAppSpecId(spec),
              label: rootfsProjectAppOptionLabel(spec),
            }))}
            onChange={(appId) => {
              const spec = configuredAppSpecs.find(
                (item) => rootfsProjectAppSpecId(item) === appId,
              );
              if (!spec) return;
              onUpdate(rootfsProjectAppActionPatch(spec));
            }}
          />
        </RootfsContentField>
        {rootfsProjectAppSpecHomeWarning(action.app_spec, projectHome) ? (
          <Alert
            type="warning"
            showIcon
            message="This app spec references HOME."
            description={rootfsProjectAppSpecHomeWarning(
              action.app_spec,
              projectHome,
            )}
          />
        ) : null}
      </>
    ) : (
      <RootfsContentPathInput
        buttonLabel="Choose directory..."
        label={action.kind === "browse" ? "Directory path" : "Path"}
        onPick={() => onPickDirectory(index, "path", action.path ?? "/")}
        onUpdate={(path) => onUpdate({ path })}
        placeholder={
          action.kind === "browse"
            ? "/usr/local/share/examples"
            : "/usr/local/share/examples/README.md"
        }
        value={action.path ?? ""}
      />
    );

  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Space
          wrap
          align="center"
          style={{ justifyContent: "space-between", width: "100%" }}
        >
          <Select
            value={action.kind}
            style={{ minWidth: 150 }}
            options={[
              { label: "Browse", value: "browse" },
              { label: "Copy to HOME", value: "copy-to-home" },
              { label: "Open", value: "open" },
              { label: "External link", value: "external-link" },
              {
                disabled: configuredAppSpecs.length === 0,
                label: "Project app",
                value: "project-app",
              },
            ]}
            onChange={(kind: RootfsContentAction["kind"]) =>
              onUpdate(
                defaultRootfsContentActionDraft(
                  kind,
                  action.draft_id,
                  kind === "project-app" ? configuredAppSpecs[0] : undefined,
                ),
              )
            }
          />
          <Popconfirm
            title="Remove this action?"
            description="This removes the action from the discovery config."
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={onRemove}
          >
            <Button danger size="small">
              Remove
            </Button>
          </Popconfirm>
        </Space>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
          }}
        >
          <RootfsContentField label="Label">
            <Input
              value={action.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
              placeholder="Button label"
            />
          </RootfsContentField>
          <RootfsContentField label="Description">
            <Input
              value={action.description ?? ""}
              onChange={(e) => onUpdate({ description: e.target.value })}
              placeholder="Optional short helper text"
            />
          </RootfsContentField>
        </div>
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
          }}
        >
          {pathField}
        </div>
      </Space>
    </div>
  );
}

function RootfsContentPathInput({
  buttonLabel,
  label,
  onPick,
  onUpdate,
  placeholder,
  value,
}: {
  buttonLabel: string;
  label: ReactNode;
  onPick: () => void;
  onUpdate: (value: string) => void;
  placeholder: string;
  value: string;
}): React.JSX.Element {
  return (
    <RootfsContentField label={label}>
      <Space.Compact style={{ width: "100%" }}>
        <Input
          value={value}
          onChange={(e) => onUpdate(e.target.value)}
          placeholder={placeholder}
        />
        <Button onClick={onPick}>{buttonLabel}</Button>
      </Space.Compact>
    </RootfsContentField>
  );
}

export function emptyRootfsContentDraft(): RootfsContentDraft {
  return {
    title: "",
    subtitle: "",
    description: "",
    publisher_name: "",
    publisher_url: "",
    license_name: "",
    license_url: "",
    highlights: [],
    actions: [],
  };
}

export function rootfsContentManifestToDraft(
  content?: RootfsContentManifest,
): RootfsContentDraft {
  if (!content) return emptyRootfsContentDraft();
  return {
    title: content.title ?? "",
    subtitle: content.subtitle ?? "",
    description: content.description ?? "",
    publisher_name: content.publisher?.name ?? "",
    publisher_url: content.publisher?.url ?? "",
    license_name: content.license?.name ?? "",
    license_url: content.license?.url ?? "",
    highlights: [...(content.highlights ?? [])],
    actions: (content.actions ?? []).map((action) =>
      normalizeRootfsContentActionDraft({
        ...action,
        draft_id: nextRootfsContentActionDraftId(),
      }),
    ),
  };
}

export function rootfsContentDraftToInput(draft: RootfsContentDraft): unknown {
  return {
    version: 1,
    title: draft.title,
    subtitle: draft.subtitle,
    description: draft.description,
    publisher:
      draft.publisher_name || draft.publisher_url
        ? {
            name: draft.publisher_name,
            url: draft.publisher_url,
          }
        : undefined,
    license:
      draft.license_name || draft.license_url
        ? {
            name: draft.license_name,
            url: draft.license_url,
          }
        : undefined,
    highlights: draft.highlights,
    actions: draft.actions.map(rootfsContentActionDraftToInput),
  };
}

export function rootfsContentCatalogPayload(
  result: ReturnType<typeof normalizeRootfsContentManifest>,
): {
  content: RootfsContentManifest | null;
  content_warnings: ReturnType<
    typeof normalizeRootfsContentManifest
  >["warnings"];
} {
  return {
    content: result.content ?? null,
    content_warnings: result.warnings,
  };
}

function rootfsContentActionDraftToInput(
  action: RootfsContentActionDraft,
): RootfsContentAction {
  const base = {
    kind: action.kind,
    label: action.label,
    description: action.description,
  };
  switch (action.kind) {
    case "external-link":
      return { ...base, url: action.url ?? "" };
    case "project-app":
      return { ...base, app_spec: action.app_spec ?? {} };
    case "copy-to-home":
      return {
        ...base,
        source_path: action.source_path ?? action.path ?? "",
        target_path: action.target_path ?? "",
      };
    default:
      return { ...base, path: action.path ?? "" };
  }
}

function defaultRootfsContentActionDraft(
  kind: RootfsContentAction["kind"],
  draft_id: string = nextRootfsContentActionDraftId(),
  appSpec?: AppSpec,
): RootfsContentActionDraft {
  switch (kind) {
    case "browse":
      return {
        draft_id,
        kind,
        label: "Browse content",
        path: "/",
      };
    case "copy-to-home":
      return {
        draft_id,
        kind,
        label: "Copy to HOME",
        source_path: "/",
        target_path: "rootfs-content",
      };
    case "external-link":
      return {
        draft_id,
        kind,
        label: "Open link",
        url: "",
      };
    case "project-app":
      return {
        draft_id,
        kind,
        label: appSpec
          ? `Launch ${rootfsProjectAppSpecTitle(appSpec)}`
          : "Launch app",
        app_spec: appSpec as unknown as Record<string, unknown>,
      };
    case "open":
    default:
      return {
        draft_id,
        kind: "open",
        label: "Open file",
        path: "/",
      };
  }
}

function normalizeRootfsContentActionDraft(
  action: RootfsContentActionDraft,
): RootfsContentActionDraft {
  const base = defaultRootfsContentActionDraft(
    action.kind,
    action.draft_id,
    action.app_spec as unknown as AppSpec | undefined,
  );
  return { ...base, ...action };
}

function rootfsProjectAppSpecId(spec: unknown): string {
  if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
    return "";
  }
  return `${(spec as any).id ?? ""}`.trim();
}

function rootfsProjectAppSpecTitle(spec: unknown): string {
  if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
    return "app";
  }
  return (
    `${(spec as any).title ?? ""}`.trim() ||
    rootfsProjectAppSpecId(spec) ||
    "app"
  );
}

function rootfsProjectAppOptionLabel(spec: AppSpec): string {
  const title = rootfsProjectAppSpecTitle(spec);
  const id = rootfsProjectAppSpecId(spec);
  return id && id !== title ? `${title} (${id})` : title;
}

function rootfsProjectAppActionPatch(
  spec: AppSpec,
): Partial<RootfsContentActionDraft> {
  return {
    app_spec: spec as unknown as Record<string, unknown>,
    label: `Launch ${rootfsProjectAppSpecTitle(spec)}`,
  };
}

function rootfsProjectAppSpecHomeWarning(
  spec: unknown,
  projectHome: string,
): string | undefined {
  if (spec == null || typeof spec !== "object" || Array.isArray(spec)) return;
  const home = `${projectHome ?? ""}`.replace(/\/+$/, "");
  if (!home) return;
  const value = spec as any;
  const referencedPaths: string[] = [];
  if (
    value.kind === "static" &&
    `${value.static?.root ?? ""}`.startsWith(home)
  ) {
    referencedPaths.push(`${value.static.root}`);
  }
  if (`${value.command?.cwd ?? ""}`.startsWith(home)) {
    referencedPaths.push(`${value.command.cwd}`);
  }
  const serialized = JSON.stringify(value);
  if (!referencedPaths.length && serialized.includes(`${home}/`)) {
    referencedPaths.push(home);
  }
  if (!referencedPaths.length) return;
  return `This app references ${referencedPaths.slice(0, 3).join(", ")}. It may not work in other projects unless those files are also copied into HOME or included somewhere stable in the RootFS.`;
}

function nextRootfsContentActionDraftId(): string {
  return `action-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function renderRootfsContentPreview(
  entry: RootfsImageEntry | undefined,
): React.JSX.Element | null {
  const content = entry?.content;
  if (!content) return null;
  if (!rootfsContentHasDisplay(content)) {
    return null;
  }
  const title = content.title?.trim();
  const subtitle = content.subtitle?.trim();
  const description = content.description?.trim();
  return (
    <div style={{ marginTop: 8 }}>
      {title ? (
        <div style={{ fontWeight: 600, marginBottom: 3 }}>{title}</div>
      ) : null}
      {subtitle || description ? (
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {subtitle || description}
        </Paragraph>
      ) : null}
      {content.highlights?.length ? (
        <Space wrap size={[4, 4]} style={{ marginTop: 6 }}>
          {content.highlights.slice(0, 4).map((highlight) => (
            <Tag key={highlight} style={{ marginInlineEnd: 0 }}>
              {highlight}
            </Tag>
          ))}
        </Space>
      ) : null}
    </div>
  );
}

export function renderRootfsContentPanel({
  entry,
  onCopyToHome,
  onLaunchProjectApp,
  onOpenPath,
  project_id,
}: {
  entry: RootfsImageEntry;
  onCopyToHome: (
    action: RootfsContentAction,
    targetPath?: string,
  ) => Promise<string | undefined>;
  onLaunchProjectApp: (action: RootfsContentAction) => Promise<void>;
  onOpenPath: (path: string) => void;
  project_id?: string;
}): React.JSX.Element | null {
  const content = entry.content;
  if (!content) return null;
  if (!rootfsContentHasDisplay(content)) return null;
  const title = content.title?.trim() || "Included content";
  const subtitle =
    content.subtitle?.trim() ||
    content.publisher?.name?.trim() ||
    "Files, examples, or links bundled with this runtime image.";
  const description = content.description?.trim();
  const publisher = renderRootfsContentLink(content.publisher);
  const license = renderRootfsContentLink(content.license);
  const actions = content.actions ?? [];

  return (
    <RuntimePanel icon="folder-open" title={title} subtitle={subtitle}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        {description ? (
          <Paragraph style={{ marginBottom: 0 }}>{description}</Paragraph>
        ) : null}
        {content.highlights?.length ? (
          <Space wrap size={[6, 6]}>
            {content.highlights.map((highlight) => (
              <Tag key={highlight}>{highlight}</Tag>
            ))}
          </Space>
        ) : null}
        {publisher || license ? (
          <Space wrap size={[10, 4]} style={{ color: COLORS.GRAY_M }}>
            {publisher ? <span>Publisher: {publisher}</span> : null}
            {license ? <span>License: {license}</span> : null}
          </Space>
        ) : null}
        {actions.length ? (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {actions.map((action, index) => (
              <RootfsContentActionRow
                key={`${action.kind}:${action.label}:${index}`}
                action={action}
                onCopyToHome={onCopyToHome}
                onLaunchProjectApp={onLaunchProjectApp}
                onOpenPath={onOpenPath}
                project_id={project_id}
              />
            ))}
          </Space>
        ) : null}
      </Space>
    </RuntimePanel>
  );
}

function rootfsContentHasDisplay(
  content: RootfsImageEntry["content"],
): boolean {
  if (!content) return false;
  return !!(
    content.title?.trim() ||
    content.subtitle?.trim() ||
    content.description?.trim() ||
    content.publisher?.name?.trim() ||
    content.publisher?.url?.trim() ||
    content.license?.name?.trim() ||
    content.license?.url?.trim() ||
    content.highlights?.length ||
    content.actions?.length
  );
}

function renderRootfsContentLink(
  ref: { name?: string; url?: string } | undefined,
): ReactNode {
  const name = ref?.name?.trim();
  const url = ref?.url?.trim();
  if (!name && !url) return null;
  if (!url) return name;
  return (
    <a href={url} rel="noreferrer" target="_blank">
      {name || url}
    </a>
  );
}

function RootfsContentActionRow({
  action,
  onCopyToHome,
  onLaunchProjectApp,
  onOpenPath,
  project_id,
}: {
  action: RootfsContentAction;
  onCopyToHome: (
    action: RootfsContentAction,
    targetPath?: string,
  ) => Promise<string | undefined>;
  onLaunchProjectApp: (action: RootfsContentAction) => Promise<void>;
  onOpenPath: (path: string) => void;
  project_id?: string;
}): React.JSX.Element {
  const [copying, setCopying] = useState<boolean>(false);
  const [copyChooserOpen, setCopyChooserOpen] = useState<boolean>(false);
  const [copyTargetPath, setCopyTargetPath] = useState<string>("");
  const [launching, setLaunching] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string>("");
  const label = action.label.trim();
  const description = action.description?.trim();
  const openPath = rootfsContentActionOpenPath(action);
  const configuredTarget = rootfsCopyTargetRelativePath(action);
  const defaultTarget = rootfsCopyDefaultTargetPath(action);
  const normalizedCopyTarget = rootfsNormalizeHomeTargetPath(copyTargetPath);
  const canCopyToHome =
    action.kind === "copy-to-home" &&
    !!(action.source_path?.trim() || action.path?.trim());

  function openCopyChooser(): void {
    setCopyTargetPath(configuredTarget ?? defaultTarget ?? "");
    setCopyChooserOpen(true);
  }

  async function copyToHome(targetPath?: string): Promise<boolean> {
    setCopying(true);
    setActionError("");
    try {
      const copiedPath = await onCopyToHome(action, targetPath);
      if (copiedPath) {
        onOpenPath(copiedPath);
        return true;
      }
      return false;
    } catch (err) {
      const error = `Could not copy RootFS content: ${rootfsActionErrorMessage(err)}`;
      setActionError(error);
      message.error(error);
      return false;
    } finally {
      setCopying(false);
    }
  }

  async function copyToChosenTarget(): Promise<void> {
    if (!normalizedCopyTarget) {
      setActionError("Choose a HOME-relative destination path.");
      return;
    }
    if (await copyToHome(normalizedCopyTarget)) {
      setCopyChooserOpen(false);
    }
  }

  async function launchProjectApp(): Promise<void> {
    setLaunching(true);
    setActionError("");
    try {
      await onLaunchProjectApp(action);
    } catch (err) {
      const error = `Could not launch app: ${rootfsActionErrorMessage(err)}`;
      setActionError(error);
      message.error(error);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <>
      <RuntimeAction
        title={
          <Space wrap size={[6, 4]}>
            <span>{label}</span>
            <Tag style={{ marginInlineEnd: 0 }}>
              {rootfsContentActionKindLabel(action.kind)}
            </Tag>
          </Space>
        }
        description={
          <Space direction="vertical" size={2} style={{ width: "100%" }}>
            {description ? <span>{description}</span> : null}
            {rootfsContentActionPathLabel(action) ? (
              <code style={{ overflowWrap: "anywhere" }}>
                {rootfsContentActionPathLabel(action)}
              </code>
            ) : null}
            {actionError ? (
              <Alert
                message={actionError}
                showIcon
                style={{ marginTop: 4 }}
                type="error"
              />
            ) : null}
          </Space>
        }
        action={
          action.kind === "external-link" && action.url ? (
            <Button
              href={action.url}
              icon={<Icon name="external-link" />}
              rel="noreferrer"
              target="_blank"
            >
              Open
            </Button>
          ) : openPath && action.kind !== "copy-to-home" ? (
            <Button
              icon={
                <Icon
                  name={action.kind === "browse" ? "folder-open" : "file"}
                />
              }
              onClick={() => onOpenPath(openPath)}
            >
              {action.kind === "browse" ? "Browse" : "Open"}
            </Button>
          ) : action.kind === "copy-to-home" ? (
            <Space wrap>
              <Button
                disabled={!canCopyToHome}
                icon={<Icon name="copy" />}
                loading={copying}
                onClick={() => void copyToHome()}
              >
                Copy to HOME
              </Button>
              {project_id ? (
                <Button
                  disabled={!canCopyToHome}
                  icon={<Icon name="folder-open" />}
                  onClick={openCopyChooser}
                >
                  Copy...
                </Button>
              ) : null}
            </Space>
          ) : action.kind === "project-app" ? (
            <Button
              disabled={!action.app_spec}
              icon={<Icon name="rocket" />}
              loading={launching}
              onClick={launchProjectApp}
            >
              Launch
            </Button>
          ) : null
        }
      />
      {copyChooserOpen && project_id ? (
        <Modal
          open
          destroyOnHidden
          title="Copy RootFS content"
          okText="Copy"
          onCancel={() => setCopyChooserOpen(false)}
          onOk={() => void copyToChosenTarget()}
          okButtonProps={{
            disabled: !normalizedCopyTarget,
            loading: copying,
          }}
        >
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Choose or type the destination path under HOME. The copy will not
              overwrite existing content.
            </Paragraph>
            <Input
              addonBefore="HOME /"
              value={copyTargetPath}
              onChange={(e) => setCopyTargetPath(e.target.value)}
              placeholder={defaultTarget ?? "rootfs-content"}
            />
            <Space wrap>
              <Button
                size="small"
                onClick={() => setCopyTargetPath(defaultTarget ?? "")}
              >
                Home
              </Button>
              <Button
                disabled={!configuredTarget}
                size="small"
                onClick={() => setCopyTargetPath(configuredTarget ?? "")}
              >
                Configured
              </Button>
              <Button
                disabled={!copyTargetPath.trim()}
                size="small"
                onClick={() =>
                  setCopyTargetPath(rootfsParentTargetPath(copyTargetPath))
                }
              >
                Parent
              </Button>
            </Space>
            <DirectorySelector
              project_id={project_id}
              startingPath={copyTargetPath}
              onSelect={(path) => setCopyTargetPath(path)}
              style={{ width: "100%" }}
              bodyStyle={{ maxHeight: 280 }}
              closable={false}
            />
          </Space>
        </Modal>
      ) : null}
    </>
  );
}

export function rootfsCopyTargetPath(
  action: RootfsContentAction,
  projectHome: string,
  targetOverride?: string,
): string | undefined {
  const relativeTarget = rootfsCopyTargetRelativePath(action, targetOverride);
  if (!relativeTarget) return;
  return `${projectHome.replace(/\/+$/, "")}/${relativeTarget}`;
}

function rootfsCopyTargetRelativePath(
  action: RootfsContentAction,
  targetOverride?: string,
): string | undefined {
  const target = targetOverride?.trim() || action.target_path?.trim();
  if (target) {
    return rootfsNormalizeHomeTargetPath(target);
  }
  return rootfsCopyDefaultTargetPath(action);
}

function rootfsCopyDefaultTargetPath(
  action: RootfsContentAction,
): string | undefined {
  const source = action.source_path?.trim() || action.path?.trim();
  const fallbackName = source
    ?.replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .at(-1);
  return rootfsNormalizeHomeTargetPath(fallbackName);
}

function rootfsNormalizeHomeTargetPath(path?: string): string | undefined {
  const relativePath = path?.trim().replace(/^\/+/, "");
  if (!relativePath) return;
  if (relativePath.includes("\0")) return;
  if (relativePath.split("/").includes("..")) return;
  return relativePath.replace(/\/+$/, "") || undefined;
}

function rootfsParentTargetPath(path: string): string {
  const parts = rootfsNormalizeHomeTargetPath(path)?.split("/") ?? [];
  parts.pop();
  return parts.join("/");
}

function rootfsContentActionOpenPath(
  action: RootfsContentAction,
): string | undefined {
  const path =
    action.path?.trim() ||
    action.source_path?.trim() ||
    action.target_path?.trim();
  if (!path) return;
  if (action.kind === "browse" && !path.endsWith("/")) {
    return `${path}/`;
  }
  return path;
}

function rootfsContentActionPathLabel(
  action: RootfsContentAction,
): string | undefined {
  if (action.kind === "copy-to-home") {
    const source = action.source_path?.trim() || action.path?.trim();
    const target = action.target_path?.trim();
    if (source && target) return `${source} -> ${target}`;
    return source || target;
  }
  return (
    action.path?.trim() ||
    action.source_path?.trim() ||
    action.url?.trim() ||
    rootfsProjectAppSpecId(action.app_spec)
  );
}

function rootfsContentActionKindLabel(
  kind: RootfsContentAction["kind"],
): string {
  switch (kind) {
    case "browse":
      return "Browse";
    case "copy-to-home":
      return "Copy";
    case "external-link":
      return "Link";
    case "project-app":
      return "App";
    case "open":
    default:
      return "Open";
  }
}

export async function launchRootfsProjectAppAction({
  action,
  project_id,
}: {
  action: RootfsContentAction;
  project_id: string;
}): Promise<void> {
  const embeddedSpec = action.app_spec as unknown as AppSpec | undefined;
  const appId = rootfsProjectAppSpecId(embeddedSpec);
  if (!embeddedSpec || !appId) {
    message.error("App action is missing an app spec.");
    return;
  }
  const running = await ensure_project_running(project_id, "launch this app");
  if (!running) {
    throw new Error("project must be running to launch this app");
  }
  const api = webapp_client.conat_client.projectApi({ project_id });
  const saved = await api.apps.upsertAppSpec(embeddedSpec);
  const spec = saved.spec;
  const status =
    spec.kind === "service"
      ? await api.apps.ensureRunning(appId, {
          timeout: 90_000,
          interval: 1000,
        })
      : await api.apps.statusApp(appId);
  await openProjectAppStatus({
    getSpec: async (id) => api.apps.getAppSpec(id),
    project_id,
    spec,
    status,
  });
}

function rootfsActionErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : `${err}`;
}
