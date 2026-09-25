/*
React component for managing a list of api keys.

Applications:

 - the keys for an account
*/

import {
  Alert,
  Button,
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
import { useEffect, useState } from "react";
const { Text, Paragraph } = Typography; // so can use from nextjs
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { DocsLink } from "@cocalc/frontend/docs/link";
import { CancelText } from "@cocalc/frontend/i18n/components";
import { type ApiKey, type ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import {
  legacyApiKeyScope,
  normalizeApiKeyScopeV1,
} from "@cocalc/util/api-key-scope";
import {
  ApiKeyScopeEditor,
  ApiKeyScopeSummary,
  EMPTY_API_KEY_SCOPE,
} from "./api-key-scope-editor";
import CopyToClipBoard from "./copy-to-clipboard";
import { Icon } from "./icon";
import { TimeAgo } from "./time-ago";

const { useForm } = Form;

function scopeForKey(key: ApiKey): ApiKeyScope {
  return key.scope == null
    ? legacyApiKeyScope({
        capabilities: key.capabilities ?? [],
        allowed_project_ids: key.allowed_project_ids ?? [],
      })
    : normalizeApiKeyScopeV1(key.scope);
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
    expire?: Date | null;
    scope?: ApiKeyScope;
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
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [draftScope, setDraftScope] =
    useState<ApiKeyScope>(EMPTY_API_KEY_SCOPE);
  const projectMap = useTypedRedux("projects", "project_map");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

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
      const completed = await runFreshAuthAction(async () => {
        await manage({ action: "delete", id });
        await getAllApiKeys();
      });
      if (!completed) return;
    } catch (err) {
      setError(`${err}`);
    }
  };

  const deleteAllApiKeys = async () => {
    try {
      const completed = await runFreshAuthAction(async () => {
        for (const { id } of apiKeys) {
          await manage({ action: "delete", id });
        }
        await getAllApiKeys();
      });
      if (!completed) return;
    } catch (err) {
      setError(`${err}`);
    }
  };

  const editApiKey = async (
    id: number,
    name: string,
    expire: Date | null,
    scope: ApiKeyScope,
  ) => {
    try {
      const completed = await runFreshAuthAction(async () => {
        await manage({
          action: "edit",
          id,
          name,
          expire,
          scope,
        });
        await getAllApiKeys();
        setEditModalVisible(false);
        setEditingKey(undefined);
        setScopeError(null);
      });
      if (!completed) return;
    } catch (err) {
      setScopeError(`${err}`);
    }
  };

  const createApiKey = async (
    name: string,
    expire: Date | null,
    scope: ApiKeyScope,
  ) => {
    try {
      const completed = await runFreshAuthAction(async () => {
        const response = await manage({
          action: "create",
          name,
          expire,
          scope,
        });
        const secret = response?.[0]?.secret;
        if (!secret)
          throw Error("API key was created without a returned secret");
        setAddModalVisible(false);
        Modal.success({
          width: 760,
          title: "New Secret API Key",
          content: (
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
            </>
          ),
        });
        await getAllApiKeys();
        setError(null);
      });
      if (!completed) return;
    } catch (err) {
      setScopeError(`${err}`);
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
      title: "Permissions",
      render: (_value, record) => {
        try {
          return (
            <ApiKeyScopeSummary
              scope={scopeForKey(record)}
              projectTitle={(project_id) =>
                projectMap?.getIn([project_id, "title"]) as string | undefined
              }
            />
          );
        } catch {
          return <Text type="danger">Invalid permissions</Text>;
        }
      },
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
            <Button type="link" danger>
              Delete
            </Button>
          </Popconfirm>
          <Button
            type="link"
            onClick={() => {
              try {
                setDraftScope(scopeForKey(record));
              } catch {
                setError(
                  "This key has invalid permissions and cannot be edited.",
                );
                return;
              }
              setScopeError(null);
              // Set the initial form value as the current key name
              form.setFieldsValue({
                name: record.name,
                expire: record.expire ? dayjs(record.expire) : undefined,
              });
              setEditModalVisible(true);
              setEditingKey(record.id);
            }}
          >
            Edit
          </Button>
        </Space.Compact>
      ),
    },
  ];

  if (!isFlyout) {
    columns.splice(1, 0, { dataIndex: "id", title: "Id" });
  }

  const handleAdd = () => {
    form.resetFields();
    setDraftScope(EMPTY_API_KEY_SCOPE);
    setScopeError(null);
    setEditingKey(undefined);
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
    const expire = values.expire?.toDate() ?? null;
    let scope: ApiKeyScope;
    try {
      scope = normalizeApiKeyScopeV1(draftScope);
    } catch (err) {
      setScopeError(err instanceof Error ? err.message : `${err}`);
      return;
    }
    if (editingKey != null) {
      await editApiKey(editingKey, name, expire, scope);
    } else {
      await createApiKey(name, expire, scope);
    }
  };

  const handleModalCancel = () => {
    setAddModalVisible(false);
    setEditModalVisible(false);
    setEditingKey(undefined);
    setDraftScope(EMPTY_API_KEY_SCOPE);
    setScopeError(null);
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
          Read the <DocsLink slug="api/http-api">API documentation</DocsLink>.
          CoCalc-ai API keys are intentionally scoped; prefer the CoCalc CLI for
          many automation workflows.
        </Paragraph>
        <Modal
          open={addModalVisible || editModalVisible}
          title={editingKey != null ? "Edit API Key" : "Create a New API Key"}
          okText={editingKey != null ? "Save" : "Create"}
          cancelText={<CancelText />}
          onCancel={handleModalCancel}
          onOk={handleModalOK}
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
          </Form>
          <ApiKeyScopeEditor
            value={draftScope}
            projectTitle={(project_id) =>
              projectMap?.getIn([project_id, "title"]) as string | undefined
            }
            onChange={(scope) => {
              setDraftScope(scope);
              setScopeError(null);
            }}
          />
          {scopeError && (
            <Alert
              title={scopeError}
              type="error"
              role="alert"
              style={{ marginTop: 12 }}
            />
          )}
        </Modal>
      </div>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
