/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Empty,
  Flex,
  Modal,
  Space,
  Table,
  Tabs,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import CopyToClipboard from "@cocalc/frontend/components/copy-to-clipboard";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { currency, plural } from "@cocalc/util/misc";
import type { Voucher, VoucherCode } from "@cocalc/util/db-schema/vouchers";
import { joinUrlPath } from "@cocalc/util/url-path";

import {
  chargeForUnpaidVouchers,
  getAdminVouchers,
  getVoucherCenterData,
  getVoucherCodes,
} from "./api";
import VoucherCodeNotes from "./voucher-code-notes";

const { Paragraph, Text, Title } = Typography;

function sortByDateDesc<T extends { created?: Date | string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const at = a.created ? new Date(a.created).valueOf() : 0;
    const bt = b.created ? new Date(b.created).valueOf() : 0;
    return bt - at;
  });
}

function voucherStatus(record: Voucher): string {
  if (record.when_pay === "admin") return "Admin";
  if (record.purchased?.time) {
    return `Paid ${new Date(record.purchased.time).toLocaleDateString()}`;
  }
  return "Paid";
}

function redeemUrl(code: string): string {
  const origin = window.location.origin;
  return `${origin}${joinUrlPath(appBasePath, "redeem", code)}`;
}

function VoucherBatchModal({
  onClose,
  voucher,
}: {
  onClose: () => void;
  voucher?: Voucher | null;
}) {
  const [codes, setCodes] = useState<VoucherCode[]>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    const voucherId = voucher?.id;
    if (voucherId == null) return;
    const resolvedVoucherId = voucherId;
    let canceled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const result = await getVoucherCodes(resolvedVoucherId);
        if (!canceled) {
          setCodes(result);
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      canceled = true;
    };
  }, [voucher?.id]);

  const allCodes = useMemo(() => codes.map((code) => code.code), [codes]);
  const unusedCodes = useMemo(
    () => codes.filter((code) => !code.when_redeemed).map((code) => code.code),
    [codes],
  );
  const redeemedCodes = useMemo(
    () => codes.filter((code) => !!code.when_redeemed).map((code) => code.code),
    [codes],
  );

  return (
    <Modal
      footer={null}
      open={!!voucher}
      title={`Voucher batch ${voucher?.id ?? ""}`}
      width={1100}
      onCancel={onClose}
    >
      {voucher && (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <div>
            <Title level={4} style={{ marginBottom: 8 }}>
              {voucher.title}
            </Title>
            <Text type="secondary">
              {voucher.count} {plural(Number(voucher.count ?? 0), "code")} at{" "}
              {currency(Number(voucher.cost ?? 0))} each
            </Text>
          </div>

          <Flex gap="middle" wrap="wrap">
            <CopyToClipboard
              display={`${allCodes.length} total`}
              inputWidth="130px"
              label="All codes"
              value={allCodes.join(", ")}
            />
            <CopyToClipboard
              display={`${unusedCodes.length} unused`}
              inputWidth="130px"
              label="Unused"
              value={unusedCodes.join(", ")}
            />
            <CopyToClipboard
              display={`${redeemedCodes.length} redeemed`}
              inputWidth="130px"
              label="Redeemed"
              value={redeemedCodes.join(", ")}
            />
          </Flex>

          {error && <Alert message={error} type="error" />}
          {loading ? (
            <Card loading />
          ) : (
            <Table
              columns={[
                {
                  dataIndex: "code",
                  key: "redeem",
                  render: (_, record: VoucherCode) => (
                    <CopyToClipboard
                      display={`…${record.code.slice(-8)}`}
                      inputWidth="200px"
                      value={redeemUrl(record.code)}
                    />
                  ),
                  title: "Redeem URL",
                },
                {
                  dataIndex: "code",
                  key: "code",
                  title: "Code",
                },
                {
                  dataIndex: "created",
                  key: "created",
                  render: (_, record: VoucherCode) =>
                    record.created ? (
                      <TimeAgo date={new Date(record.created)} />
                    ) : (
                      "-"
                    ),
                  title: "Created",
                },
                {
                  dataIndex: "when_redeemed",
                  key: "when_redeemed",
                  render: (_, record: VoucherCode) =>
                    record.when_redeemed ? (
                      <TimeAgo date={new Date(record.when_redeemed)} />
                    ) : (
                      "-"
                    ),
                  title: "Redeemed",
                },
                {
                  dataIndex: "redeemed_by",
                  key: "redeemed_by",
                  render: (_, record: VoucherCode) =>
                    record.redeemed_by ? (
                      <Avatar account_id={record.redeemed_by} />
                    ) : (
                      "-"
                    ),
                  title: "Redeemed By",
                },
                {
                  dataIndex: "notes",
                  key: "notes",
                  render: (_, record: VoucherCode) => (
                    <VoucherCodeNotes code={record.code} notes={record.notes} />
                  ),
                  title: "Private Notes",
                },
              ]}
              dataSource={codes}
              pagination={{ defaultPageSize: 25 }}
              rowKey="code"
            />
          )}
        </Space>
      )}
    </Modal>
  );
}

export function VoucherCenterPage() {
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const [created, setCreated] = useState<Voucher[]>([]);
  const [redeemed, setRedeemed] = useState<VoucherCode[]>([]);
  const [adminVouchers, setAdminVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [showExpiredOnly, setShowExpiredOnly] = useState<boolean>(false);
  const [showAdminOnly, setShowAdminOnly] = useState<boolean>(false);
  const [showPaidOnly, setShowPaidOnly] = useState<boolean>(false);
  const [charging, setCharging] = useState<boolean>(false);
  const [chargeResult, setChargeResult] = useState<any>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [userData, allAdminVouchers] = await Promise.all([
        getVoucherCenterData(),
        isAdmin ? getAdminVouchers() : Promise.resolve([]),
      ]);
      setCreated(sortByDateDesc(userData.created));
      setRedeemed(
        [...userData.redeemed].sort((a, b) => {
          const at = a.when_redeemed ? new Date(a.when_redeemed).valueOf() : 0;
          const bt = b.when_redeemed ? new Date(b.when_redeemed).valueOf() : 0;
          return bt - at;
        }),
      );
      setAdminVouchers(sortByDateDesc(allAdminVouchers));
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [isAdmin]);

  const filteredAdminVouchers = useMemo(() => {
    let records = [...adminVouchers];
    if (showExpiredOnly) {
      const now = Date.now();
      records = records.filter((record) => {
        const expire = record.expire ? new Date(record.expire).valueOf() : 0;
        return expire > 0 && expire <= now;
      });
    }
    if (showAdminOnly) {
      records = records.filter((record) => record.when_pay === "admin");
    }
    if (showPaidOnly) {
      records = records.filter((record) => !!record.purchased);
    }
    return records;
  }, [adminVouchers, showAdminOnly, showExpiredOnly, showPaidOnly]);

  const createdColumns = [
    {
      dataIndex: "created",
      key: "created",
      render: (_, record: Voucher) => (
        <Button type="link" onClick={() => setSelectedVoucher(record)}>
          <TimeAgo date={new Date(record.created)} />
        </Button>
      ),
      title: "Created",
    },
    {
      dataIndex: "count",
      key: "count",
      title: "Codes",
    },
    {
      dataIndex: "cost",
      key: "cost",
      render: (_, record: Voucher) => currency(Number(record.cost ?? 0)),
      title: "Value Each",
    },
    {
      dataIndex: "title",
      key: "title",
      title: "Title",
    },
    {
      dataIndex: "when_pay",
      key: "status",
      render: (_, record: Voucher) => voucherStatus(record),
      title: "Status",
    },
    {
      key: "actions",
      render: (_, record: Voucher) => (
        <Button onClick={() => setSelectedVoucher(record)}>View Codes</Button>
      ),
      title: "",
    },
  ];

  return (
    <div style={{ padding: "20px", overflowY: "auto" }}>
      <VoucherBatchModal
        voucher={selectedVoucher}
        onClose={() => setSelectedVoucher(null)}
      />

      <Flex align="center" gap="middle" justify="space-between" wrap>
        <Paragraph style={{ marginBottom: 0 }} type="secondary">
          Buy vouchers in the Store, redeem them publicly, and manage the
          voucher batches and redemptions tied to your account.
        </Paragraph>
        <Space>
          <Button onClick={load}>
            <Icon name="sync-alt" /> Refresh
          </Button>
          <Button
            onClick={() => openAccountSettings({ kind: "tab", page: "store" })}
          >
            Open Store
          </Button>
          <Button href={joinUrlPath(appBasePath, "redeem")} target="_blank">
            Redeem Voucher
          </Button>
        </Space>
      </Flex>

      <Card style={{ marginTop: "16px" }}>
        <Flex gap="middle" wrap>
          <div>
            <Text strong>{created.length}</Text>
            <div style={{ color: "#666" }}>batches created</div>
          </div>
          <Divider type="vertical" style={{ height: "auto" }} />
          <div>
            <Text strong>{redeemed.length}</Text>
            <div style={{ color: "#666" }}>codes redeemed</div>
          </div>
          <Divider type="vertical" style={{ height: "auto" }} />
          <div>
            <a href="https://doc.cocalc.com/vouchers.html" target="_blank">
              Voucher documentation
            </a>
          </div>
        </Flex>
      </Card>

      {error && (
        <Alert style={{ marginTop: "16px" }} message={error} type="error" />
      )}

      <Tabs
        style={{ marginTop: "16px" }}
        items={[
          {
            key: "created",
            label: `Created (${created.length})`,
            children: loading ? (
              <Card loading />
            ) : created.length === 0 ? (
              <Empty description="You have not created any voucher batches yet." />
            ) : (
              <Table
                columns={createdColumns}
                dataSource={created}
                pagination={{ defaultPageSize: 25 }}
                rowKey="id"
              />
            ),
          },
          {
            key: "redeemed",
            label: `Redeemed (${redeemed.length})`,
            children: loading ? (
              <Card loading />
            ) : redeemed.length === 0 ? (
              <Empty description="You have not redeemed any vouchers yet." />
            ) : (
              <Table
                columns={[
                  {
                    dataIndex: "code",
                    key: "code",
                    title: "Code",
                  },
                  {
                    dataIndex: "when_redeemed",
                    key: "when_redeemed",
                    render: (_, record: VoucherCode) =>
                      record.when_redeemed ? (
                        <TimeAgo date={new Date(record.when_redeemed)} />
                      ) : (
                        "-"
                      ),
                    title: "Redeemed",
                  },
                  {
                    dataIndex: "canceled",
                    key: "canceled",
                    render: (_, record: VoucherCode) =>
                      record.canceled ? "Yes" : "-",
                    title: "Canceled",
                  },
                  {
                    dataIndex: "purchase_ids",
                    key: "purchase_ids",
                    render: (_, record: VoucherCode) =>
                      record.purchase_ids?.length ? (
                        <>
                          {plural(record.purchase_ids.length, "Purchase")}{" "}
                          {record.purchase_ids.join(", ")}
                        </>
                      ) : (
                        "-"
                      ),
                    title: "Credits",
                  },
                ]}
                dataSource={redeemed}
                pagination={{ defaultPageSize: 25 }}
                rowKey="code"
              />
            ),
          },
          ...(isAdmin
            ? [
                {
                  key: "admin",
                  label: `Admin (${filteredAdminVouchers.length})`,
                  children: (
                    <Space
                      direction="vertical"
                      size="middle"
                      style={{ width: "100%" }}
                    >
                      <Flex gap="middle" wrap>
                        <Checkbox
                          checked={showExpiredOnly}
                          onChange={(e) => setShowExpiredOnly(e.target.checked)}
                        >
                          Show expired only
                        </Checkbox>
                        <Checkbox
                          checked={showAdminOnly}
                          onChange={(e) => setShowAdminOnly(e.target.checked)}
                        >
                          Show admin only
                        </Checkbox>
                        <Checkbox
                          checked={showPaidOnly}
                          onChange={(e) => setShowPaidOnly(e.target.checked)}
                        >
                          Show paid only
                        </Checkbox>
                        <Button
                          disabled={charging}
                          loading={charging}
                          type="primary"
                          onClick={async () => {
                            try {
                              setCharging(true);
                              setChargeResult(await chargeForUnpaidVouchers());
                              await load();
                            } catch (err) {
                              setError(`${err}`);
                            } finally {
                              setCharging(false);
                            }
                          }}
                        >
                          Charge unpaid expired vouchers
                        </Button>
                      </Flex>
                      {chargeResult && (
                        <Card>
                          <Text strong>Charge result</Text>
                          <pre style={{ marginTop: "8px" }}>
                            {JSON.stringify(chargeResult, undefined, 2)}
                          </pre>
                        </Card>
                      )}
                      <Table
                        columns={[
                          ...createdColumns,
                          {
                            dataIndex: "created_by",
                            key: "created_by",
                            title: "Created By",
                          },
                        ]}
                        dataSource={filteredAdminVouchers}
                        pagination={{ defaultPageSize: 25 }}
                        rowKey="id"
                      />
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Card style={{ marginTop: "16px" }}>
        <Paragraph style={{ marginBottom: 0 }}>
          Need to buy more voucher codes? Go back to the{" "}
          <a
            onClick={() => openAccountSettings({ kind: "tab", page: "store" })}
          >
            Store
          </a>
          . Need to redeem a code from outside the app? Use the public{" "}
          <a href={joinUrlPath(appBasePath, "redeem")} target="_blank">
            redeem page
          </a>
          .
        </Paragraph>
      </Card>
    </div>
  );
}
