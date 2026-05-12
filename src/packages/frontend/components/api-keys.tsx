/*
React component for managing a list of api keys.

Applications:

 - the keys for an account
*/

import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
} from "antd";
import { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
const { Text, Paragraph } = Typography; // so can use from nextjs
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { CancelText } from "@cocalc/frontend/i18n/components";
import {
  API_KEY_CAPABILITIES,
  type ApiKey,
  type ApiKeyCapability,
} from "@cocalc/util/db-schema/api-keys";
import { A } from "./A";
import CopyToClipBoard from "./copy-to-clipboard";
import { Icon } from "./icon";
import { TimeAgo } from "./time-ago";

const { useForm } = Form;

const CAPABILITY_DESCRIPTIONS: Record<ApiKeyCapability, string> = {
  "account:read": "Read basic account-visible metadata, such as account names.",
  "project:create": "Create new projects owned by this account.",
  "project:list": "List projects visible to this account.",
  "project:read": "Read metadata for explicitly allowed projects.",
  "project:write":
    "Change metadata or settings for explicitly allowed projects.",
  "file:read": "Read files from explicitly allowed projects.",
  "file:write": "Write files in explicitly allowed projects.",
  "project:exec":
    "Run commands and project-host APIs in explicitly allowed projects.",
  "codex:run": "Start Codex/ACP agent turns in explicitly allowed projects.",
};

const PROJECT_SCOPED_CAPABILITIES = new Set<ApiKeyCapability>([
  "project:read",
  "project:write",
  "file:read",
  "file:write",
  "project:exec",
  "codex:run",
]);

function needsAllowedProjects(capabilities?: ApiKeyCapability[]): boolean {
  return (capabilities ?? []).some((capability) =>
    PROJECT_SCOPED_CAPABILITIES.has(capability),
  );
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function apiKeyTestCurl(secret: string): string {
  return [
    `curl -sS -u '${secret}:'`,
    `  -H 'Content-Type: application/json'`,
    `  -d '{"name":"system.ping","args":[]}'`,
    `  '${browserOrigin()}/api/conat/hub'`,
  ].join(" \\\n");
}

function dateValue(value: any): number {
  if (value == null) return 0;
  if (value instanceof Date) return value.valueOf();
  const n = new Date(value).valueOf();
  return Number.isFinite(n) ? n : 0;
}

interface ProjectOption {
  project_id: string;
  title: string;
  state?: string;
  lastActive: number;
  unknown?: boolean;
}

interface Props {
  // Manage is a function that lets you get all api keys, delete a single api key,
  // or create an api key.
  // - If you call manage with input "get" it will return a Javascript array ApiKey[]
  //   of all your api keys, with each api key represented as an object {name, id, trunc, last_active?}
  //   as defined above.  The actual key itself is not returned, and trunc is a truncated
  //   version of the key used for display.
  // - If you call manage with input "delete" and id set then that key will get deleted.
  // - If you call manage with input "create", then a new api key is created and returned
  //   as a single string. This is the one and only time the user can see this *secret*.
  // - If call with edit and both name and id set, changes the key determined by id
  //   to have the given name. Similar for expire.
  manage: (opts: {
    action: "get" | "delete" | "create" | "edit";
    id?: number;
    name?: string;
    expire?: Date;
    capabilities?: ApiKeyCapability[];
    allowed_project_ids?: string[];
  }) => Promise<ApiKey[] | undefined>;
  mode?: "page" | "flyout";
}

export default function ApiKeys({ manage, mode = "page" }: Props) {
  const isFlyout = mode === "flyout";
  const size = isFlyout ? "small" : undefined; // for e.g. buttons
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [editingKey, setEditingKey] = useState<number | undefined>(undefined);
  const [addModalVisible, setAddModalVisible] = useState<boolean>(false);
  const [editModalVisible, setEditModalVisible] = useState<boolean>(false);
  const [form] = useForm();
  const [error, setError] = useState<string | null>(null);
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const selectedCapabilities =
    (Form.useWatch("capabilities", form) as ApiKeyCapability[] | undefined) ??
    [];
  const selectedProjectIdsValue = Form.useWatch("allowed_project_ids", form);
  const selectedProjectIds = Array.isArray(selectedProjectIdsValue)
    ? (selectedProjectIdsValue as string[])
    : [];
  const allowedProjectsRequired = needsAllowedProjects(selectedCapabilities);
  const [projectFilter, setProjectFilter] = useState<string>("");

  const projectOptions = useMemo<ProjectOption[]>(() => {
    const selected = new Set(selectedProjectIds);
    const filter = projectFilter.trim().toLowerCase();
    const rows: ProjectOption[] = [];
    project_map?.forEach((project, project_id) => {
      const id = `${project_id}`;
      const title = `${project?.get?.("title") ?? "No Title"}`;
      if (
        filter &&
        !title.toLowerCase().includes(filter) &&
        !id.toLowerCase().includes(filter)
      ) {
        return;
      }
      rows.push({
        project_id: id,
        title,
        state: `${project?.getIn?.(["state", "state"]) ?? ""}` || undefined,
        lastActive: dateValue(
          project?.getIn?.(["last_active", account_id]) ??
            project?.get?.("last_edited"),
        ),
      });
    });
    for (const project_id of selected) {
      if (!rows.some((row) => row.project_id === project_id)) {
        rows.push({
          project_id,
          title: "Unknown or unloaded project",
          lastActive: 0,
          unknown: true,
        });
      }
    }
    return rows
      .sort(
        (a, b) => b.lastActive - a.lastActive || a.title.localeCompare(b.title),
      )
      .slice(0, 50);
  }, [account_id, projectFilter, project_map, selectedProjectIds]);

  useEffect(() => {
    getAllApiKeys();
  }, []);

  const getAllApiKeys = async () => {
    setLoading(true);
    try {
      const response = await manage({ action: "get" });
      setApiKeys(response as ApiKey[]);
      setLoading(false);
      setError(null);
    } catch (err) {
      setLoading(false);
      setError(`${err}`);
    }
  };

  const deleteApiKey = async (id: number) => {
    try {
      await manage({ action: "delete", id });
      getAllApiKeys();
    } catch (err) {
      setError(`${err}`);
    }
  };

  const deleteAllApiKeys = async () => {
    for (const { id } of apiKeys) {
      await deleteApiKey(id);
    }
  };

  const editApiKey = async (
    id: number,
    name: string,
    expire?: Date,
    capabilities?: ApiKeyCapability[],
    allowed_project_ids?: string[],
  ) => {
    try {
      await manage({
        action: "edit",
        id,
        name,
        expire,
        capabilities,
        allowed_project_ids,
      });
      getAllApiKeys();
    } catch (err) {
      setError(`${err}`);
    }
  };

  const createApiKey = async (
    name: string,
    expire?: Date,
    capabilities?: ApiKeyCapability[],
    allowed_project_ids?: string[],
  ) => {
    try {
      const response = await manage({
        action: "create",
        name,
        expire,
        capabilities,
        allowed_project_ids,
      });
      setAddModalVisible(false);
      getAllApiKeys();

      Modal.success({
        width: 760,
        title: "New Secret API Key",
        content: (() => {
          const secret = response?.[0].secret ?? "failed to get secret";
          return (
            <>
              <div>
                Save this secret key somewhere safe.{" "}
                <b>You won't be able to view it again here.</b> If you lose this
                secret key, you'll need to generate a new one.
              </div>
              <div style={{ marginTop: 16 }}>
                <strong>Secret API Key</strong>{" "}
                <CopyToClipBoard
                  style={{ marginTop: "16px" }}
                  outerStyle={{ width: "100%" }}
                  inputWidth="100%"
                  value={secret}
                />
              </div>
              <div style={{ marginTop: 16 }}>
                <strong>Test with curl</strong>
                <Paragraph type="secondary" style={{ marginTop: 5 }}>
                  This calls <Text code>system.ping</Text>, which only verifies
                  that the key is valid.
                </Paragraph>
                <CopyToClipBoard
                  outerStyle={{ width: "100%" }}
                  inputStyle={{ fontSize: "12px" }}
                  inputWidth="100%"
                  value={apiKeyTestCurl(secret)}
                />
              </div>
            </>
          );
        })(),
      });
      setError(null);
    } catch (err) {
      setError(`${err}`);
    }
  };

  const columns: ColumnsType<ApiKey> = [
    {
      dataIndex: "name",
      title: "Name/Key",
      render: (name, record) => {
        return (
          <>
            {name}
            <br />
            <Text type="secondary">({record.trunc})</Text>
          </>
        );
      },
    },
    {
      dataIndex: "capabilities",
      title: "Capabilities",
      render: (capabilities: string[]) =>
        capabilities?.length ? capabilities.join(", ") : "None",
    },
    {
      dataIndex: "allowed_project_ids",
      title: "Allowed Projects",
      render: (projectIds: string[]) =>
        projectIds?.length ? projectIds.join(", ") : "None",
    },
    {
      dataIndex: "last_active",
      title: "Last Used",
      render: (last_active) =>
        last_active ? <TimeAgo date={last_active} /> : "Never",
    },
    {
      dataIndex: "expire",
      title: "Expire",
      render: (expire) => (expire ? <TimeAgo date={expire} /> : "Never"),
    },
    {
      dataIndex: "operation",
      title: "Operation",
      align: "right",
      render: (_text, record) => (
        <Space.Compact orientation={isFlyout ? "vertical" : "horizontal"}>
          <Popconfirm
            title="Are you sure you want to delete this key?"
            onConfirm={() => deleteApiKey(record.id)}
          >
            <a>Delete</a>
          </Popconfirm>
          <a
            onClick={() => {
              // Set the initial form value as the current key name
              form.setFieldsValue({
                name: record.name,
                expire: record.expire ? dayjs(record.expire) : undefined,
                capabilities: record.capabilities ?? [],
                allowed_project_ids: record.allowed_project_ids ?? [],
              });
              setProjectFilter("");
              setEditModalVisible(true);
              setEditingKey(record.id);
            }}
            style={{ marginLeft: "1em" }}
          >
            Edit
          </a>
        </Space.Compact>
      ),
    },
  ];

  if (!isFlyout) {
    columns.splice(1, 0, { dataIndex: "id", title: "Id" });
  }

  const handleAdd = () => {
    form.resetFields();
    form.setFieldsValue({ capabilities: [], allowed_project_ids: [] });
    setProjectFilter("");
    setAddModalVisible(true);
  };

  const handleModalOK = async () => {
    let values;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const name = values.name;
    const expire = values.expire?.toDate();
    const capabilities = (values.capabilities ?? []) as ApiKeyCapability[];
    const allowed_project_ids = needsAllowedProjects(capabilities)
      ? ((values.allowed_project_ids ?? []) as string[])
      : [];
    if (editingKey != null) {
      editApiKey(editingKey, name, expire, capabilities, allowed_project_ids);
      setEditModalVisible(false);
      setEditingKey(undefined);
      form.resetFields();
    } else {
      createApiKey(name, expire, capabilities, allowed_project_ids);
      form.resetFields();
    }
  };

  const handleModalCancel = () => {
    setAddModalVisible(false);
    setEditModalVisible(false);
    setEditingKey(undefined);
    setProjectFilter("");
    form.resetFields();
  };

  return (
    <>
      {error && (
        <Alert
          title={error}
          type="error"
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}
      {apiKeys.length > 0 && (
        <Table
          style={{ marginBottom: 16 }}
          dataSource={apiKeys}
          columns={columns}
          loading={loading}
          rowKey="id"
          pagination={false}
        />
      )}
      <div style={isFlyout ? { padding: "5px" } : undefined}>
        <Space.Compact size={size}>
          <Button onClick={handleAdd} size={size}>
            <Icon name="plus-circle" /> Add API key...
          </Button>
          <Button onClick={getAllApiKeys} size={size}>
            Refresh
          </Button>
          {apiKeys.length > 0 && (
            <Popconfirm
              title="Are you sure you want to delete all these api keys?"
              onConfirm={deleteAllApiKeys}
            >
              <Button danger size={size}>
                Delete All...
              </Button>
            </Popconfirm>
          )}
        </Space.Compact>
        <Paragraph style={{ marginTop: "10px" }}>
          Read the <A href="https://doc.cocalc.com/api2/">API documentation</A>.
        </Paragraph>
        <Modal
          open={addModalVisible || editModalVisible}
          title={
            editingKey != null ? "Edit API Key Name" : "Create a New API Key"
          }
          okText={editingKey != null ? "Save" : "Create"}
          cancelText={<CancelText />}
          onCancel={handleModalCancel}
          onOk={handleModalOK}
          okButtonProps={{ disabled: selectedCapabilities.length === 0 }}
          width={760}
        >
          <Form form={form} layout="vertical">
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, message: "Please enter a name" }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="expire"
              label="Expire"
              rules={[
                {
                  required: false,
                  message:
                    "Optional date when key will be automatically deleted",
                },
              ]}
            >
              <DatePicker
                changeOnBlur
                showTime
                disabledDate={(current) => {
                  // disable all dates before today
                  return current && current < dayjs();
                }}
              />
            </Form.Item>
            <Form.Item
              name="capabilities"
              label="Capabilities"
              rules={[
                {
                  required: true,
                  message: "Select at least one explicit capability",
                },
              ]}
            >
              <Checkbox.Group style={{ width: "100%" }}>
                {API_KEY_CAPABILITIES.map((capability) => (
                  <div key={capability} style={{ marginBottom: 8 }}>
                    <Checkbox value={capability}>
                      <Text code>{capability}</Text>{" "}
                      <Text type="secondary">
                        - {CAPABILITY_DESCRIPTIONS[capability]}
                      </Text>
                    </Checkbox>
                  </div>
                ))}
              </Checkbox.Group>
            </Form.Item>
            {allowedProjectsRequired && (
              <Form.Item
                label="Allowed Projects"
                required
                extra={
                  <div style={{ marginTop: 5 }}>
                    Required for project, file, Codex, and exec capabilities.
                  </div>
                }
              >
                <Input
                  allowClear
                  placeholder="Filter projects by title or id..."
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  style={{ marginBottom: 8 }}
                />
                <Form.Item
                  name="allowed_project_ids"
                  noStyle
                  rules={[
                    {
                      validator: async (_, value) => {
                        if (!needsAllowedProjects(selectedCapabilities)) return;
                        if (value?.length) return;
                        throw Error("Select at least one allowed project");
                      },
                    },
                  ]}
                >
                  <Checkbox.Group style={{ width: "100%" }}>
                    <div
                      style={{
                        border: "1px solid #d9d9d9",
                        borderRadius: 6,
                        maxHeight: 260,
                        overflowY: "auto",
                        padding: "6px 10px",
                      }}
                    >
                      {projectOptions.length === 0 && (
                        <Text type="secondary">
                          No matching projects are loaded.
                        </Text>
                      )}
                      {projectOptions.map((project) => (
                        <div
                          key={project.project_id}
                          style={{ margin: "4px 0" }}
                        >
                          <Checkbox value={project.project_id}>
                            <Text strong>{project.title}</Text>{" "}
                            <Text code>{project.project_id.slice(0, 8)}</Text>
                            {project.state && (
                              <Text type="secondary"> {project.state}</Text>
                            )}
                            {project.unknown && (
                              <Text type="secondary"> selected</Text>
                            )}
                          </Checkbox>
                        </div>
                      ))}
                    </div>
                  </Checkbox.Group>
                </Form.Item>
              </Form.Item>
            )}
          </Form>
        </Modal>
      </div>
    </>
  );
}
