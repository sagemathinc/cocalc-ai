/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { DeleteOutlined } from "@ant-design/icons";
import {
  Button,
  Checkbox,
  Divider,
  Input,
  Radio,
  Space,
  Typography,
} from "antd";
import type {
  ApiKeyCapability,
  ApiKeyProjectGrant,
  ApiKeyScope,
} from "@cocalc/util/db-schema/api-keys";
import {
  FULL_PROJECT_API_KEY_CAPABILITIES,
  VIEWER_PROJECT_API_KEY_CAPABILITIES,
} from "@cocalc/util/api-key-scope";
import { SelectProject } from "@cocalc/frontend/projects/select-project";

const { Text } = Typography;

export const EMPTY_API_KEY_SCOPE: ApiKeyScope = {
  version: 1,
  account: [],
  projects: [],
};

const ACCOUNT_OPTIONS: Array<{
  capability: ApiKeyCapability;
  label: string;
}> = [
  { capability: "account:read", label: "Read basic account information" },
  { capability: "project:list", label: "List my projects" },
  { capability: "project:create", label: "Create projects" },
  {
    capability: "api-key:revoke:request",
    label: "Request API key revocation (requires your approval)",
  },
];

function sameCapabilities(
  actual: ApiKeyCapability[],
  expected: readonly ApiKeyCapability[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((capability) => actual.includes(capability))
  );
}

function modeForGrant(
  grant: Omit<ApiKeyProjectGrant, "project_id">,
): "full" | "viewer" | "custom" {
  if (
    sameCapabilities(grant.capabilities, FULL_PROJECT_API_KEY_CAPABILITIES) &&
    grant.viewer_read_roots == null
  ) {
    return "full";
  }
  if (
    sameCapabilities(grant.capabilities, VIEWER_PROJECT_API_KEY_CAPABILITIES) &&
    grant.viewer_read_roots != null
  ) {
    return "viewer";
  }
  return "custom";
}

export function ApiKeyScopeSummary({
  scope,
  projectTitle,
}: {
  scope: ApiKeyScope;
  projectTitle?: (project_id: string) => string | undefined;
}) {
  const account = ACCOUNT_OPTIONS.filter(({ capability }) =>
    scope.account.includes(capability),
  ).map(({ label }) => label);
  return (
    <Space orientation="vertical" size={0}>
      <Text>
        {account.length ? account.join(", ") : "No account privileges"}
      </Text>
      {scope.all_projects && (
        <Text type="secondary">
          All current and future projects:{" "}
          {modeForGrant(scope.all_projects) === "full"
            ? "full runtime"
            : modeForGrant(scope.all_projects) === "viewer"
              ? "read-only files"
              : scope.all_projects.capabilities.join(", ")}
        </Text>
      )}
      {scope.projects.length === 0 && !scope.all_projects && (
        <Text type="secondary">No project access</Text>
      )}
      {scope.projects.map((grant, index) => {
        const mode = modeForGrant(grant);
        const title =
          projectTitle?.(grant.project_id) || `Selected project ${index + 1}`;
        return (
          <Text type="secondary" key={grant.project_id}>
            {title}:{" "}
            {mode === "viewer"
              ? "read-only files"
              : mode === "full"
                ? "full runtime"
                : grant.capabilities.join(", ")}
          </Text>
        );
      })}
    </Space>
  );
}

export function ApiKeyScopeEditor({
  value,
  onChange,
  projectTitle,
  excludeProjectIds = [],
  disabled = false,
}: {
  value: ApiKeyScope;
  onChange: (scope: ApiKeyScope) => void;
  projectTitle?: (project_id: string) => string | undefined;
  excludeProjectIds?: string[];
  disabled?: boolean;
}) {
  const updateGrant = (project_id: string, next: ApiKeyProjectGrant) => {
    onChange({
      ...value,
      projects: value.projects.map((grant) =>
        grant.project_id === project_id ? next : grant,
      ),
    });
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <Text strong>Account privileges</Text>
        <div>
          {ACCOUNT_OPTIONS.map(({ capability, label }) => (
            <div key={capability}>
              <Checkbox
                disabled={disabled}
                checked={value.account.includes(capability)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    account: event.target.checked
                      ? [...value.account, capability]
                      : value.account.filter((item) => item !== capability),
                  })
                }
              >
                {label}
              </Checkbox>
            </div>
          ))}
        </div>
      </div>
      <div>
        <Text strong>Project access</Text>
        <div>
          <Checkbox
            disabled={disabled}
            checked={!!value.all_projects}
            onChange={(event) => {
              const { all_projects: _previous, ...rest } = value;
              onChange(
                event.target.checked
                  ? {
                      ...rest,
                      all_projects: {
                        capabilities: [...VIEWER_PROJECT_API_KEY_CAPABILITIES],
                        viewer_read_roots: ["."],
                      },
                    }
                  : rest,
              );
            }}
          >
            All projects
          </Checkbox>
        </div>
        {value.all_projects && (
          <Space orientation="vertical">
            <Text type="secondary">
              Includes current and future projects where you are a full
              collaborator. Individual project settings below override this
              default.
            </Text>
            <Radio.Group
              aria-label="Default access for all projects"
              optionType="button"
              buttonStyle="solid"
              disabled={disabled}
              value={modeForGrant(value.all_projects)}
              onChange={(event) =>
                onChange({
                  ...value,
                  all_projects:
                    event.target.value === "full"
                      ? { capabilities: [...FULL_PROJECT_API_KEY_CAPABILITIES] }
                      : {
                          capabilities: [
                            ...VIEWER_PROJECT_API_KEY_CAPABILITIES,
                          ],
                          viewer_read_roots: ["."],
                        },
                })
              }
            >
              {modeForGrant(value.all_projects) === "custom" && (
                <Radio.Button value="custom">Custom</Radio.Button>
              )}
              <Radio.Button value="viewer">Read-only files</Radio.Button>
              <Radio.Button value="full">Full runtime</Radio.Button>
            </Radio.Group>
          </Space>
        )}
        {value.projects.map((grant, index) => {
          const mode = modeForGrant(grant);
          const directoryInputId = `api-key-roots-${index}`;
          return (
            <div key={grant.project_id}>
              <Divider style={{ margin: "12px 0" }} />
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  width: "100%",
                }}
              >
                <SelectProject
                  ariaLabel={`Project ${index + 1}`}
                  value={grant.project_id}
                  fullCollaboratorOnly
                  disabled={disabled}
                  exclude={[
                    ...excludeProjectIds,
                    ...value.projects
                      .filter((other) => other.project_id !== grant.project_id)
                      .map((other) => other.project_id),
                  ]}
                  onChange={(project_id) => {
                    if (!project_id) return;
                    updateGrant(grant.project_id, { ...grant, project_id });
                  }}
                  style={{ minWidth: 0, flex: "1 1 220px" }}
                />
                <Button
                  aria-label={`Remove project ${index + 1}`}
                  title="Remove project"
                  icon={<DeleteOutlined />}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...value,
                      projects: value.projects.filter(
                        (entry) => entry.project_id !== grant.project_id,
                      ),
                    })
                  }
                />
              </div>
              <Radio.Group
                aria-label={`Access for project ${index + 1}`}
                optionType="button"
                buttonStyle="solid"
                disabled={disabled}
                value={mode}
                onChange={(event) => {
                  const nextMode = event.target.value as "full" | "viewer";
                  updateGrant(
                    grant.project_id,
                    nextMode === "full"
                      ? {
                          project_id: grant.project_id,
                          capabilities: [...FULL_PROJECT_API_KEY_CAPABILITIES],
                        }
                      : {
                          project_id: grant.project_id,
                          capabilities: [
                            ...VIEWER_PROJECT_API_KEY_CAPABILITIES,
                          ],
                          viewer_read_roots: ["."],
                        },
                  );
                }}
                style={{ marginTop: 8 }}
              >
                {mode === "custom" && (
                  <Radio.Button value="custom">Custom</Radio.Button>
                )}
                <Radio.Button value="viewer">Read-only files</Radio.Button>
                <Radio.Button value="full">Full runtime</Radio.Button>
              </Radio.Group>
              {mode === "custom" && (
                <div>
                  <Text type="secondary">
                    Existing privileges retained:{" "}
                    {grant.capabilities.join(", ")}
                  </Text>
                </div>
              )}
              {mode === "viewer" && (
                <div style={{ marginTop: 8 }}>
                  <Checkbox
                    disabled={disabled}
                    checked={grant.viewer_read_roots?.includes(".") ?? false}
                    onChange={(event) =>
                      updateGrant(grant.project_id, {
                        ...grant,
                        viewer_read_roots: event.target.checked ? ["."] : [""],
                      })
                    }
                  >
                    Whole project
                  </Checkbox>
                  {!grant.viewer_read_roots?.includes(".") && (
                    <div>
                      <label htmlFor={directoryInputId}>
                        Allowed directories
                      </label>
                      <Input.TextArea
                        id={directoryInputId}
                        disabled={disabled}
                        rows={3}
                        placeholder="One project-relative directory per line"
                        value={(grant.viewer_read_roots ?? []).join("\n")}
                        onChange={(event) =>
                          updateGrant(grant.project_id, {
                            ...grant,
                            viewer_read_roots: event.target.value.split("\n"),
                          })
                        }
                      />
                      <Text type="secondary">
                        Hidden and protected paths remain excluded.
                      </Text>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ marginTop: 12 }}>
          <SelectProject
            ariaLabel="Add project access"
            value={null}
            fullCollaboratorOnly
            disabled={disabled}
            exclude={[
              ...excludeProjectIds,
              ...value.projects.map((grant) => grant.project_id),
            ]}
            onChange={(project_id) => {
              if (!project_id) return;
              onChange({
                ...value,
                projects: [
                  ...value.projects,
                  {
                    project_id,
                    capabilities: [...VIEWER_PROJECT_API_KEY_CAPABILITIES],
                    viewer_read_roots: ["."],
                  },
                ],
              });
            }}
          />
        </div>
      </div>
      <ApiKeyScopeSummary scope={value} projectTitle={projectTitle} />
    </Space>
  );
}
