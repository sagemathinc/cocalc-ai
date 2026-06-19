/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import jsonic from "jsonic";

import { React } from "@cocalc/frontend/app-framework";
import {
  CopyToClipBoard,
  ErrorDisplay,
  Loading,
  TimeAgo,
} from "@cocalc/frontend/components";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  SiteLicenseExternalClaimConsumption,
  SiteLicenseExternalClaimConsumptionStatus,
  SiteLicenseExternalClaimKey,
  SiteLicenseExternalClaimPool,
  SiteLicenseExternalClaimSigningAlgorithm,
  SiteLicenseOverview,
} from "@cocalc/conat/hub/api/purchases";

const { Paragraph, Text, Title } = Typography;

const CLAIM_STATUSES: SiteLicenseExternalClaimConsumptionStatus[] = [
  "pending-side-effect",
  "granted",
  "failed-retryable",
  "failed-terminal",
];

function shortId(value?: string | null): string {
  if (!value) return "";
  return value.length <= 12
    ? value
    : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function copyId(value?: string | null) {
  if (!value) return null;
  return (
    <CopyToClipBoard value={value} display={shortId(value)} inputWidth="18ex" />
  );
}

function optionalString(value?: string): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || undefined;
}

function optionalNumber(value?: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseJsonObject(raw?: string): Record<string, unknown> | undefined {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) return undefined;
  const parsed = jsonic(trimmed);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function dateCell(value?: Date | string | null) {
  return value ? <TimeAgo date={value} /> : <Text type="secondary">never</Text>;
}

function poolStatus(pool: SiteLicenseExternalClaimPool) {
  if (pool.disabled_at) return <Tag color="red">disabled</Tag>;
  if (pool.expires_at && new Date(pool.expires_at).getTime() < Date.now()) {
    return <Tag color="orange">expired</Tag>;
  }
  if (pool.starts_at && new Date(pool.starts_at).getTime() > Date.now()) {
    return <Tag color="blue">scheduled</Tag>;
  }
  return <Tag color="green">active</Tag>;
}

function keyStatus(key: SiteLicenseExternalClaimKey) {
  if (key.revoked_at) return <Tag color="red">revoked</Tag>;
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    return <Tag color="orange">expired</Tag>;
  }
  if (key.starts_at && new Date(key.starts_at).getTime() > Date.now()) {
    return <Tag color="blue">scheduled</Tag>;
  }
  return <Tag color="green">active</Tag>;
}

function consumptionStatus(status: SiteLicenseExternalClaimConsumptionStatus) {
  switch (status) {
    case "granted":
      return <Tag color="green">granted</Tag>;
    case "pending-side-effect":
      return <Tag color="blue">pending</Tag>;
    case "failed-retryable":
      return <Tag color="orange">retryable</Tag>;
    case "failed-terminal":
      return <Tag color="red">terminal</Tag>;
  }
}

function keyGenerationCommand(): string {
  return [
    "# Install cocalc-cli if the cocalc command is not available:",
    "curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash",
    "",
    "# Generate a signing keypair. Keep claim-private.pem secret.",
    "mkdir -p ~/.cocalc-site-license-claims",
    "openssl genpkey -algorithm Ed25519 -out ~/.cocalc-site-license-claims/claim-private.pem",
    "openssl pkey -in ~/.cocalc-site-license-claims/claim-private.pem -pubout -out ~/.cocalc-site-license-claims/claim-public.pem",
    "",
    "# Send this public key output to the CoCalc operator.",
    "cat ~/.cocalc-site-license-claims/claim-public.pem",
  ].join("\n");
}

function sampleTokenCommand(pool?: SiteLicenseExternalClaimPool): string {
  return [
    "cocalc membership site-license sample-token \\",
    `  --site-license ${pool?.site_license_id ?? "<site-license-id>"} \\`,
    `  --pool ${pool?.id ?? "<pool-id>"} \\`,
    `  --issuer ${pool?.issuer ?? "<issuer>"} \\`,
    "  --kid <key-id> \\",
    "  --private-key-file ~/.cocalc-site-license-claims/claim-private.pem \\",
    "  --expires-in-days 30",
  ].join("\n");
}

function siteLicenseOptions(overviews: SiteLicenseOverview[]) {
  return overviews.map((overview) => ({
    value: overview.site_license.id,
    label: `${overview.site_license.organization_name || overview.site_license.name} (${shortId(overview.site_license.id)})`,
  }));
}

function packageOptions(
  overviews: SiteLicenseOverview[],
  siteLicenseId?: string,
) {
  return overviews
    .filter((overview) =>
      siteLicenseId ? overview.site_license.id === siteLicenseId : true,
    )
    .flatMap((overview) =>
      overview.pools.map((pool) => ({
        value: pool.id,
        label: `${pool.pool_name} / ${pool.membership_class} (${shortId(pool.id)})`,
      })),
    );
}

export function SiteLicenseClaimsAdmin() {
  const hub = webapp_client.conat_client.hub;
  const [overviews, setOverviews] = React.useState<SiteLicenseOverview[]>([]);
  const [pools, setPools] = React.useState<SiteLicenseExternalClaimPool[]>([]);
  const [keys, setKeys] = React.useState<SiteLicenseExternalClaimKey[]>([]);
  const [consumptions, setConsumptions] = React.useState<
    SiteLicenseExternalClaimConsumption[]
  >([]);
  const [selectedPoolId, setSelectedPoolId] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [loadingDetails, setLoadingDetails] = React.useState(false);
  const [error, setError] = React.useState<string>("");
  const [poolModalOpen, setPoolModalOpen] = React.useState(false);
  const [keyModalOpen, setKeyModalOpen] = React.useState(false);
  const [savingPool, setSavingPool] = React.useState(false);
  const [savingKey, setSavingKey] = React.useState(false);
  const [filterSiteLicenseId, setFilterSiteLicenseId] =
    React.useState<string>("");
  const [filterPackageId, setFilterPackageId] = React.useState<string>("");
  const [filterStatus, setFilterStatus] = React.useState<
    SiteLicenseExternalClaimConsumptionStatus | undefined
  >();

  const [poolForm] = Form.useForm();
  const [keyForm] = Form.useForm();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const selectedPool = React.useMemo(
    () => pools.find((pool) => pool.id === selectedPoolId),
    [pools, selectedPoolId],
  );

  const loadPools = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextOverviews, nextPools] = await Promise.all([
        hub.purchases.listSiteLicenseOverviews({
          admin: true,
        }),
        hub.purchases.listSiteLicenseExternalClaimPools({
          site_license_id: optionalString(filterSiteLicenseId),
          package_id: optionalString(filterPackageId),
          limit: 500,
        }),
      ]);
      setOverviews(nextOverviews ?? []);
      setPools(nextPools ?? []);
      setSelectedPoolId((current) => {
        if (current && nextPools?.some((pool) => pool.id === current)) {
          return current;
        }
        return nextPools?.[0]?.id ?? "";
      });
      setError("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [hub, filterSiteLicenseId, filterPackageId]);

  const loadDetails = React.useCallback(async () => {
    if (!selectedPoolId) {
      setKeys([]);
      setConsumptions([]);
      return;
    }
    setLoadingDetails(true);
    try {
      const [nextKeys, nextConsumptions] = await Promise.all([
        hub.purchases.listSiteLicenseExternalClaimKeys({
          pool_id: selectedPoolId,
          limit: 200,
        }),
        hub.purchases.listSiteLicenseExternalClaimConsumptions({
          pool_id: selectedPoolId,
          status: filterStatus,
          limit: 200,
        }),
      ]);
      setKeys(nextKeys ?? []);
      setConsumptions(nextConsumptions ?? []);
      setError("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoadingDetails(false);
    }
  }, [hub, selectedPoolId, filterStatus]);

  React.useEffect(() => {
    loadPools();
  }, [loadPools]);

  React.useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  function openPoolModal() {
    poolForm.resetFields();
    poolForm.setFieldsValue({
      site_license_id: filterSiteLicenseId || undefined,
      package_id: filterPackageId || undefined,
      audience: "cocalc.ai.site-license-claim",
      max_claims_per_account: 1,
      allow_membership_class_override: false,
      allow_membership_expires_at_override: false,
    });
    setPoolModalOpen(true);
  }

  async function createPool() {
    const values = await poolForm.validateFields();
    setSavingPool(true);
    try {
      let created: SiteLicenseExternalClaimPool | undefined;
      const completed = await runFreshAuthAction(async () => {
        created = await hub.purchases.createSiteLicenseExternalClaimPool({
          browser_id: webapp_client.browser_id,
          site_license_id: values.site_license_id,
          package_id: values.package_id,
          name: values.name,
          issuer: values.issuer,
          slug: optionalString(values.slug),
          audience:
            optionalString(values.audience) ?? "cocalc.ai.site-license-claim",
          default_membership_class: optionalString(
            values.default_membership_class,
          ),
          allow_membership_class_override:
            values.allow_membership_class_override === true,
          default_membership_duration_days: optionalNumber(
            values.default_membership_duration_days,
          ),
          default_membership_expires_at: optionalString(
            values.default_membership_expires_at,
          ),
          allow_membership_expires_at_override:
            values.allow_membership_expires_at_override === true,
          max_membership_duration_days: optionalNumber(
            values.max_membership_duration_days,
          ),
          max_membership_expires_at: optionalString(
            values.max_membership_expires_at,
          ),
          default_rootfs_id: optionalString(values.default_rootfs_id),
          max_claims: optionalNumber(values.max_claims),
          max_claims_per_account: optionalNumber(values.max_claims_per_account),
          starts_at: optionalString(values.starts_at),
          expires_at: optionalString(values.expires_at),
          metadata: parseJsonObject(values.metadata_json) ?? null,
        });
      });
      if (!completed) return;
      message.success("External claim pool saved");
      setPoolModalOpen(false);
      await loadPools();
      if (created?.id) {
        setSelectedPoolId(created.id);
      }
    } catch (err) {
      message.error(`Failed to save claim pool: ${err}`);
    } finally {
      setSavingPool(false);
    }
  }

  async function disablePool(poolId: string) {
    try {
      const completed = await runFreshAuthAction(async () => {
        await hub.purchases.disableSiteLicenseExternalClaimPool({
          browser_id: webapp_client.browser_id,
          pool_id: poolId,
        });
      });
      if (!completed) return;
      message.success("External claim pool disabled");
      await loadPools();
      await loadDetails();
    } catch (err) {
      message.error(`Failed to disable pool: ${err}`);
    }
  }

  function openKeyModal() {
    keyForm.resetFields();
    keyForm.setFieldsValue({
      pool_id: selectedPoolId,
      alg: "EdDSA",
    });
    setKeyModalOpen(true);
  }

  async function addKey() {
    const values = await keyForm.validateFields();
    const jwk = parseJsonObject(values.public_key_jwk);
    const pem = optionalString(values.public_key_pem);
    if ((jwk && pem) || (!jwk && !pem)) {
      message.error("Provide exactly one public key: JWK JSON or PEM.");
      return;
    }
    setSavingKey(true);
    try {
      const completed = await runFreshAuthAction(async () => {
        await hub.purchases.addSiteLicenseExternalClaimKey({
          browser_id: webapp_client.browser_id,
          pool_id: values.pool_id,
          kid: values.kid,
          alg: values.alg as SiteLicenseExternalClaimSigningAlgorithm,
          public_key_jwk: jwk ?? null,
          public_key_pem: pem ?? null,
          starts_at: optionalString(values.starts_at),
          expires_at: optionalString(values.expires_at),
          metadata: parseJsonObject(values.metadata_json) ?? null,
        });
      });
      if (!completed) return;
      message.success("External claim key saved");
      setKeyModalOpen(false);
      await loadDetails();
    } catch (err) {
      message.error(`Failed to save key: ${err}`);
    } finally {
      setSavingKey(false);
    }
  }

  async function revokeKey(key: SiteLicenseExternalClaimKey) {
    try {
      const completed = await runFreshAuthAction(async () => {
        await hub.purchases.revokeSiteLicenseExternalClaimKey({
          browser_id: webapp_client.browser_id,
          pool_id: key.pool_id,
          kid: key.kid,
        });
      });
      if (!completed) return;
      message.success("External claim key revoked");
      await loadDetails();
    } catch (err) {
      message.error(`Failed to revoke key: ${err}`);
    }
  }

  const poolColumns = [
    {
      title: "Pool",
      dataIndex: "id",
      render: (_value, pool: SiteLicenseExternalClaimPool) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{pool.name}</Text>
          {copyId(pool.id)}
          {pool.slug ? <Text type="secondary">slug: {pool.slug}</Text> : null}
        </Space>
      ),
    },
    { title: "Issuer", dataIndex: "issuer" },
    {
      title: "Site license",
      dataIndex: "site_license_id",
      render: copyId,
    },
    {
      title: "Package",
      dataIndex: "package_id",
      render: copyId,
    },
    {
      title: "Claims",
      render: (_value, pool: SiteLicenseExternalClaimPool) => (
        <Space orientation="vertical" size={0}>
          <Text>max {pool.max_claims ?? "unlimited"}</Text>
          <Text type="secondary">
            per account {pool.max_claims_per_account ?? "unlimited"}
          </Text>
        </Space>
      ),
    },
    {
      title: "Status",
      render: (_value, pool: SiteLicenseExternalClaimPool) => (
        <Space orientation="vertical" size={0}>
          {poolStatus(pool)}
          {pool.expires_at ? <Text>{dateCell(pool.expires_at)}</Text> : null}
        </Space>
      ),
    },
    {
      title: "Actions",
      render: (_value, pool: SiteLicenseExternalClaimPool) => (
        <Space wrap>
          <Button size="small" onClick={() => setSelectedPoolId(pool.id)}>
            Select
          </Button>
          {!pool.disabled_at && (
            <Popconfirm
              title="Disable external claim pool?"
              description="Existing unused tokens for this pool will stop working."
              okText="Disable"
              okButtonProps={{ danger: true }}
              onConfirm={() => disablePool(pool.id)}
            >
              <Button size="small" danger>
                Disable
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const keyColumns = [
    { title: "kid", dataIndex: "kid" },
    { title: "alg", dataIndex: "alg" },
    {
      title: "Status",
      render: (_value, key: SiteLicenseExternalClaimKey) => keyStatus(key),
    },
    {
      title: "Created",
      dataIndex: "created",
      render: dateCell,
    },
    {
      title: "Expires",
      dataIndex: "expires_at",
      render: dateCell,
    },
    {
      title: "Actions",
      render: (_value, key: SiteLicenseExternalClaimKey) =>
        key.revoked_at ? null : (
          <Popconfirm
            title="Revoke external claim key?"
            description="Tokens signed with this key will stop working."
            okText="Revoke"
            okButtonProps={{ danger: true }}
            onConfirm={() => revokeKey(key)}
          >
            <Button size="small" danger>
              Revoke
            </Button>
          </Popconfirm>
        ),
    },
  ];

  const consumptionColumns = [
    {
      title: "Consumed",
      dataIndex: "consumed_at",
      render: dateCell,
    },
    {
      title: "Status",
      dataIndex: "status",
      render: consumptionStatus,
    },
    {
      title: "Account",
      dataIndex: "account_id",
      render: copyId,
    },
    {
      title: "Membership",
      render: (_value, row: SiteLicenseExternalClaimConsumption) => (
        <Space orientation="vertical" size={0}>
          <Text>{row.membership_class}</Text>
          {row.membership_expires_at ? (
            <Text type="secondary">
              expires {dateCell(row.membership_expires_at)}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "Subject",
      dataIndex: "external_subject",
      render: (value?: string | null) => value ?? "",
    },
    {
      title: "Error",
      render: (_value, row: SiteLicenseExternalClaimConsumption) =>
        row.error_code || row.error_message ? (
          <Space orientation="vertical" size={0}>
            {row.error_code ? <Text code>{row.error_code}</Text> : null}
            {row.error_message ? (
              <Text type="danger">{row.error_message}</Text>
            ) : null}
          </Space>
        ) : null,
    },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <Title level={4}>Site License External Claims</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Create external claim pools, register publisher public keys, and
          inspect token consumptions. These operations route through the
          seed-global site-license authority.
        </Paragraph>
      </div>
      {error ? <ErrorDisplay error={error} /> : null}
      <Card>
        <Space wrap>
          <Select
            allowClear
            showSearch
            placeholder="Site license"
            style={{ minWidth: 320 }}
            value={filterSiteLicenseId || undefined}
            options={siteLicenseOptions(overviews)}
            onChange={(value) => {
              setFilterSiteLicenseId(value ?? "");
              setFilterPackageId("");
            }}
            optionFilterProp="label"
          />
          <Select
            allowClear
            showSearch
            placeholder="Package / pool"
            style={{ minWidth: 320 }}
            value={filterPackageId || undefined}
            options={packageOptions(overviews, filterSiteLicenseId)}
            onChange={(value) => setFilterPackageId(value ?? "")}
            optionFilterProp="label"
          />
          <Button onClick={loadPools}>Refresh</Button>
          <Button type="primary" onClick={openPoolModal}>
            Create external claim pool
          </Button>
        </Space>
      </Card>
      {loading ? (
        <Loading />
      ) : (
        <Table
          rowKey="id"
          size="small"
          columns={poolColumns}
          dataSource={pools}
          pagination={{ pageSize: 10 }}
          rowClassName={(pool) =>
            pool.id === selectedPoolId ? "ant-table-row-selected" : ""
          }
          onRow={(pool) => ({
            onClick: () => setSelectedPoolId(pool.id),
          })}
        />
      )}
      {selectedPool ? (
        <Card
          title={
            <Space wrap>
              <span>Selected pool: {selectedPool.name}</span>
              {copyId(selectedPool.id)}
              {poolStatus(selectedPool)}
            </Space>
          }
          extra={
            <Space wrap>
              <Button onClick={loadDetails}>Refresh details</Button>
              <Button type="primary" onClick={openKeyModal}>
                Add key
              </Button>
            </Space>
          }
        >
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message="Claim URL"
              description={
                <Space orientation="vertical" size={0}>
                  <Text>
                    Send users a signed token link after generating a token with
                    the publisher/private key workflow.
                  </Text>
                  <Text code>
                    /claim/site-license?token=&lt;signed-token&gt;
                  </Text>
                </Space>
              }
            />
            {loadingDetails ? <Loading /> : null}
            <Title level={5}>Verification Keys</Title>
            <Table
              rowKey="id"
              size="small"
              columns={keyColumns}
              dataSource={keys}
              pagination={false}
            />
            <Space wrap>
              <Title level={5} style={{ margin: 0 }}>
                Recent Consumptions
              </Title>
              <Select
                allowClear
                placeholder="Status"
                style={{ width: 220 }}
                value={filterStatus}
                options={CLAIM_STATUSES.map((status) => ({
                  value: status,
                  label: status,
                }))}
                onChange={setFilterStatus}
              />
            </Space>
            <Table
              rowKey="id"
              size="small"
              columns={consumptionColumns}
              dataSource={consumptions}
              pagination={{ pageSize: 10 }}
            />
          </Space>
        </Card>
      ) : null}
      <Modal
        title="Create external claim pool"
        open={poolModalOpen}
        onCancel={() => setPoolModalOpen(false)}
        onOk={createPool}
        okText="Save pool"
        confirmLoading={savingPool}
        width={820}
      >
        <Form form={poolForm} layout="vertical">
          <Form.Item
            name="site_license_id"
            label="Site license"
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              options={siteLicenseOptions(overviews)}
              optionFilterProp="label"
              onChange={() => poolForm.setFieldValue("package_id", undefined)}
            />
          </Form.Item>
          <Form.Item
            shouldUpdate={(prev, cur) =>
              prev.site_license_id !== cur.site_license_id
            }
            noStyle
          >
            {({ getFieldValue }) => (
              <Form.Item
                name="package_id"
                label="Site-license package / pool"
                rules={[{ required: true }]}
              >
                <Select
                  showSearch
                  options={packageOptions(
                    overviews,
                    getFieldValue("site_license_id"),
                  )}
                  optionFilterProp="label"
                />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item name="name" label="Pool name" rules={[{ required: true }]}>
            <Input placeholder="CUP beta readers" />
          </Form.Item>
          <Form.Item
            name="issuer"
            label="Token issuer"
            rules={[{ required: true }]}
          >
            <Input placeholder="cambridge-university-press" />
          </Form.Item>
          <Form.Item name="slug" label="Slug">
            <Input placeholder="cup-beta" />
          </Form.Item>
          <Form.Item name="audience" label="Audience">
            <Input />
          </Form.Item>
          <Form.Item
            name="default_membership_class"
            label="Default membership class"
          >
            <Input placeholder="Optional; otherwise uses package membership class" />
          </Form.Item>
          <Space wrap style={{ width: "100%" }}>
            <Form.Item
              name="default_membership_duration_days"
              label="Default duration days"
            >
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item
              name="max_membership_duration_days"
              label="Max duration days"
            >
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item name="max_claims" label="Max claims">
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item name="max_claims_per_account" label="Max claims/account">
              <InputNumber min={1} />
            </Form.Item>
          </Space>
          <Form.Item name="default_rootfs_id" label="Default RootFS id">
            <Input placeholder="Optional RootFS context" />
          </Form.Item>
          <Form.Item name="expires_at" label="Pool expires at">
            <Input placeholder="ISO timestamp" />
          </Form.Item>
          <Form.Item name="metadata_json" label="Metadata JSON">
            <Input.TextArea rows={3} placeholder="{ label: 'CUP beta' }" />
          </Form.Item>
          <Form.Item
            name="allow_membership_class_override"
            valuePropName="checked"
          >
            <Checkbox>Allow token membership_class override</Checkbox>
          </Form.Item>
          <Form.Item
            name="allow_membership_expires_at_override"
            valuePropName="checked"
          >
            <Checkbox>Allow token membership_expires_at override</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="Add external claim verification key"
        open={keyModalOpen}
        onCancel={() => setKeyModalOpen(false)}
        onOk={addKey}
        okText="Save key"
        confirmLoading={savingKey}
        width={820}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="Recommended key workflow"
            description={
              <Space orientation="vertical" style={{ width: "100%" }}>
                <Text>
                  Send this command block to the issuer. They run it in a
                  terminal, keep the private key file secret, and send back only
                  the public key output. Paste that output into the Public key
                  PEM field below.
                </Text>
                <Paragraph copyable={{ text: keyGenerationCommand() }}>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {keyGenerationCommand()}
                  </pre>
                </Paragraph>
                <Text type="secondary">
                  After this key is saved, signed claim links can be generated
                  with:
                </Text>
                <Paragraph
                  copyable={{ text: sampleTokenCommand(selectedPool) }}
                >
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {sampleTokenCommand(selectedPool)}
                  </pre>
                </Paragraph>
              </Space>
            }
          />
        </Space>
        <Form form={keyForm} layout="vertical">
          <Form.Item
            name="pool_id"
            label="Pool id"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="kid" label="Key id" rules={[{ required: true }]}>
            <Input placeholder="cup-2026-01" />
          </Form.Item>
          <Form.Item name="alg" label="Algorithm" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "EdDSA", label: "EdDSA" },
                { value: "ES256", label: "ES256" },
              ]}
            />
          </Form.Item>
          <Form.Item name="public_key_pem" label="Public key PEM">
            <Input.TextArea
              rows={6}
              placeholder={[
                "-----BEGIN PUBLIC KEY-----",
                "...",
                "-----END PUBLIC KEY-----",
              ].join("\n")}
            />
          </Form.Item>
          <Form.Item
            name="public_key_jwk"
            label="Public key JWK JSON (advanced alternative)"
            extra="Use either PEM or JWK, not both."
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="expires_at" label="Key expires at">
            <Input placeholder="Optional ISO timestamp" />
          </Form.Item>
          <Form.Item name="metadata_json" label="Metadata JSON">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
