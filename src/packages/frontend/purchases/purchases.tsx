import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Flex,
  Input,
  Popover,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  MutableRefObject,
} from "react";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { useMembershipTiers } from "@cocalc/frontend/account/membership-tiers";
import { useTypedRedux, redux } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { Icon } from "@cocalc/frontend/components/icon";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { load_target } from "@cocalc/frontend/history";
import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import getSupportURL from "@cocalc/frontend/support/url";
import { isLanguageModelService } from "@cocalc/util/db-schema/ai-models";
import {
  serviceToDisplay,
  type Service,
} from "@cocalc/util/db-schema/purchase-quotas";
import type {
  DedicatedHostPurchase,
  Purchase,
} from "@cocalc/util/db-schema/purchases";
import { getAmountStyle } from "./amount-style";
import {
  formatMembershipDebitPurchaseDescription,
  formatTeamLicenseDebitPurchaseDescription,
  membershipTierLabel,
  type MembershipTierLabels,
} from "@cocalc/util/purchases/descriptions";
import {
  capitalize,
  field_cmp,
  currency,
  hoursToTimeIntervalHuman,
  plural,
} from "@cocalc/util/misc";
import {
  moneyRoundToCents,
  moneyToDbString,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import AdminRefund, { isRefundable } from "./admin-refund";
import * as api from "./api";
import EmailStatement from "./email-statement";
import Export, { type PrintColumn } from "./export";
import DynamicallyUpdatingCost from "./pay-as-you-go/dynamically-updating-cost";
import { formatHourlyRate } from "./pay-as-you-go/format-hourly-rate";
import Refresh from "./refresh";
import ServiceTag from "./service";
import { LineItemsTable, moneyToString } from "./line-items";
import { getInvoiceUrlOrNull } from "./invoice-url";
import searchFilter from "@cocalc/frontend/search/filter";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import "./purchases.css";

const DEFAULT_LIMIT = 10;
const MAX_RELATED_PURCHASE_LOADS = 5;

interface Props {
  project_id?: string; // if given, restrict to only purchases that are for things in this project
  group?: boolean;
  day_statement_id?: number; // if given, restrict to purchases on this day statement.
  month_statement_id?: number; // if given, restrict to purchases on this month statement.
  account_id?: string; // used by admins to specify a different user
  noTitle?: boolean;
}

export default function Purchases(props: Props) {
  return <Purchases0 {...props} />;
}

function Purchases0({
  project_id,
  group: group0,
  day_statement_id,
  month_statement_id,
  account_id,
  noTitle,
}: Props) {
  const [group, setGroup] = useState<boolean>(!!group0);
  const [fromDate, setFromDate] = useState<Dayjs | null>(null);
  const [toDate, setToDate] = useState<Dayjs | null>(null);
  const title = noTitle ? undefined : (
    <>
      {account_id && (
        <Avatar account_id={account_id} style={{ marginRight: "15px" }} />
      )}
      {project_id ? (
        <span>
          {project_id ? (
            <a onClick={() => load_target("settings/purchases")}>Purchases</a>
          ) : (
            "Purchases"
          )}{" "}
          in <ProjectTitle project_id={project_id} trunc={30} />
        </span>
      ) : (
        <span>
          <Icon name="credit-card" /> Purchases
        </span>
      )}
    </>
  );

  const viewControls = (
    <>
      <Tooltip title="Aggregate transactions by service so you can see how much you are spending on each service. Pay-as-you-go in progress purchases are not included.">
        <Checkbox
          checked={group}
          onChange={(e) => {
            setGroup(e.target.checked);
          }}
        >
          Group by service
        </Checkbox>
      </Tooltip>
      <Space>
        <span>From</span>
        <DatePicker
          changeOnBlur
          allowClear
          value={fromDate}
          onChange={setFromDate}
          disabledDate={(current) =>
            current > dayjs().endOf("day") ||
            (toDate != null && current > toDate.endOf("day"))
          }
        />
      </Space>
      <Space>
        <span>To</span>
        <DatePicker
          changeOnBlur
          allowClear
          value={toDate}
          onChange={setToDate}
          disabledDate={(current) =>
            current > dayjs().endOf("day") ||
            (fromDate != null && current < fromDate.startOf("day"))
          }
        />
      </Space>
    </>
  );

  const content = (
    <PurchasesTable
      project_id={project_id}
      account_id={account_id}
      group={group}
      day_statement_id={day_statement_id}
      month_statement_id={month_statement_id}
      cutoff={fromDate?.startOf("day").toDate()}
      cutoffEnd={toDate?.endOf("day").toDate()}
      viewControls={viewControls}
    />
  );

  return title ? <Card title={title}>{content}</Card> : content;
}

type PurchaseItem = Partial<
  Purchase & {
    sum?: number;
    filter?: string;
    balance?: MoneyValue;
    count?: number;
  }
>;

export function PurchasesTable({
  account_id,
  project_id,
  group,
  thisMonth,
  cutoff,
  cutoffEnd,
  day_statement_id,
  month_statement_id,
  noStatement,
  style,
  filename,
  activeOnly,
  refreshRef,
  viewControls,
}: Props & {
  thisMonth?: boolean;
  cutoff?: Date;
  cutoffEnd?: Date;
  noStatement?: boolean;
  style?: CSSProperties;
  filename?: string;
  activeOnly?: boolean;
  refreshRef?;
  viewControls?: ReactNode;
}) {
  const [loading, setLoading] = useState<boolean>(false);
  const [purchaseRecords, setPurchaseRecords] = useState<PurchaseItem[] | null>(
    null,
  );
  const [purchases, setPurchases] = useState<PurchaseItem[] | null>(null);
  const [filteredPurchases, setFilteredPurchases] = useState<
    PurchaseItem[] | null
  >(null);
  const [groupedPurchases, setGroupedPurchases] = useState<
    PurchaseItem[] | null
  >(null);
  const [error, setError] = useState<string>("");
  const [offset, setOffset] = useState<number>(0);
  const [service /*, setService*/] = useState<Service | undefined>(undefined);
  const [balance, setBalance] = useState<MoneyValue | null | undefined>(
    undefined,
  );
  const [hasMore, setHasMore] = useState<boolean>(true); // todo
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [filter, setFilter] = useState<string>("");
  const { tiers: membershipTiers } = useMembershipTiers();
  const membershipTierLabels = useMemo(
    () =>
      membershipTiers.reduce((labels, tier) => {
        labels[tier.id] = tier.label || tier.id;
        return labels;
      }, {} as MembershipTierLabels),
    [membershipTiers],
  );
  const searchFilterRef = useRef<any>(null) as MutableRefObject<
    (string) => Promise<PurchaseItem[]> | null
  >;

  const fetchPurchasesPage = async ({
    limit0,
    offset0,
    paginated,
  }: {
    limit0: number;
    offset0: number;
    paginated: boolean;
  }) => {
    const opts = {
      cutoff,
      cutoff_end: cutoffEnd,
      day_statement_id,
      month_statement_id,
      group,
      no_statement: noStatement,
      project_id,
      service,
      thisMonth,
      ...(paginated ? { limit: limit0 + 1, offset: offset0 } : {}),
    };
    let { purchases: x, balance } = account_id
      ? await api.getPurchasesAdmin({ ...opts, account_id })
      : await api.getPurchases(opts);
    const rawLength = x.length;
    x = x.filter((purchase) => !isLanguageModelService(purchase.service));
    for (const purchase of x) {
      getFilter(purchase);
    }
    const pageHasMore = paginated ? rawLength == limit0 + 1 : false;
    return {
      balance,
      hasMore: pageHasMore,
      purchases: paginated ? x.slice(0, limit0) : x,
    };
  };

  const mergePurchaseRecords = (
    records: PurchaseItem[],
    newRecords: PurchaseItem[],
  ) => {
    const merged: { [id: string]: PurchaseItem } = {};
    for (const purchase of records.concat(newRecords)) {
      merged[(purchase as any).id] = purchase;
    }
    const nextRecords = Object.values(merged);
    nextRecords.sort(field_cmp("id"));
    nextRecords.reverse();
    return nextRecords;
  };

  const loadMore = async ({ init }: { init? } = {}) => {
    try {
      setError("");
      setLoading(true);

      const paginated = !group;
      let limit0 = DEFAULT_LIMIT;
      if (paginated) {
        if (purchaseRecords == null) {
          limit0 = DEFAULT_LIMIT;
        } else if (init) {
          limit0 = Math.max(
            DEFAULT_LIMIT,
            Math.min(100, purchaseRecords.length),
          );
        } else {
          limit0 = limit;
        }
      }

      const {
        balance,
        hasMore: pageHasMore,
        purchases: x,
      } = await fetchPurchasesPage({
        limit0,
        offset0: init ? 0 : offset,
        paginated,
      });
      setBalance(balance);

      if (paginated) {
        // TODO: need getPurchases to tell if there are more or not.
        setHasMore(pageHasMore);
      } else {
        setHasMore(false);
      }

      if (init || group) {
        setOffset(group ? 0 : DEFAULT_LIMIT);
        searchFilterRef.current = await searchFilter({
          data: x,
          toString: getFilter,
        });
        setPurchaseRecords(x); // put after creating filter so will update view
      } else {
        const v2 = mergePurchaseRecords(purchaseRecords ?? [], x);
        // for next time:
        setOffset(v2.length);
        searchFilterRef.current = await searchFilter<PurchaseItem>({
          data: v2,
          toString: getFilter,
        });
        setPurchaseRecords(v2); // put after creating filter so will update view
      }
      setLimit(100);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  const loadUntilPurchase = async (id: number) => {
    if (group || purchaseRecords == null || !hasMore) {
      return;
    }
    if (purchaseRecords.some((purchase) => purchase.id === id)) {
      return;
    }
    try {
      setError("");
      setLoading(true);
      let nextRecords = purchaseRecords;
      let nextOffset = offset;
      let nextHasMore: boolean = hasMore;
      for (
        let i = 0;
        i < MAX_RELATED_PURCHASE_LOADS &&
        nextHasMore &&
        !nextRecords.some((purchase) => purchase.id === id);
        i += 1
      ) {
        const {
          balance,
          hasMore: pageHasMore,
          purchases: pagePurchases,
        } = await fetchPurchasesPage({
          limit0: limit,
          offset0: nextOffset,
          paginated: true,
        });
        setBalance(balance);
        nextHasMore = pageHasMore;
        nextRecords = mergePurchaseRecords(nextRecords, pagePurchases);
        nextOffset = nextRecords.length;
        setHasMore(nextHasMore);
        setOffset(nextOffset);
        searchFilterRef.current = await searchFilter<PurchaseItem>({
          data: nextRecords,
          toString: getFilter,
        });
        setPurchaseRecords(nextRecords);
      }
      if (!nextRecords.some((purchase) => purchase.id === id)) {
        setError(`Transaction ${id} is not available in the current view.`);
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let canceled = false;
    const search = searchFilterRef.current;
    if (search == null || !filter?.trim() || purchases == null) {
      setFilteredPurchases(purchases);
      return () => {
        canceled = true;
      };
    }
    (async () => {
      const filteredPurchases = await search(filter);
      if (!canceled) {
        setFilteredPurchases(filteredPurchases);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [filter, purchases]);

  useEffect(() => {
    if (group && filter) {
      setFilter("");
    }
  }, [group, filter]);

  const refreshRecords = async () => {
    // [ ] TODO: this needs to instead get only recent records (that could have possibly
    // changed or been added) and update them.
    await loadMore({ init: true });
  };
  if (refreshRef != null) {
    refreshRef.current = refreshRecords;
  }

  useEffect(() => {
    loadMore({ init: true });
  }, [cutoff, cutoffEnd]);

  useEffect(() => {
    refreshRecords();
  }, [group, noStatement, project_id, service, thisMonth]);

  useEffect(() => {
    if (purchaseRecords == null) {
      return;
    }

    let b = balance != null ? toDecimal(balance) : null;
    const purchases: PurchaseItem[] = [];
    for (const row of purchaseRecords) {
      if (activeOnly && row.cost != null) {
        continue;
      }
      const cost = toDecimal(getCost(row));
      // Compute incremental balance
      if (b != null) {
        purchases.push({ ...row, balance: moneyToDbString(b) });
      } else {
        purchases.push(row);
      }

      if (row.pending) {
        // Pending transactions are not included in the balance.
        continue;
      }
      if (b != null) {
        b = b.add(cost);
      }
    }

    if (group) {
      setPurchases(null);
      setGroupedPurchases(purchases);
    } else {
      setGroupedPurchases(null);
      setPurchases(purchases);
    }
  }, [balance, purchaseRecords, activeOnly, group]);

  const filterText = filter.trim();
  const visiblePurchases = group ? groupedPurchases : filteredPurchases;
  const loadedCount = purchases?.length ?? 0;
  const visibleCount = visiblePurchases?.length;
  const hasDateCriteria = cutoff != null || cutoffEnd != null;
  const hasFilterCriteria = !group && !!filterText;
  const hasCriteria = hasDateCriteria || hasFilterCriteria;
  const purchaseLabel =
    visibleCount == null ? "purchases" : plural(visibleCount, "purchase");
  const groupLabel =
    visibleCount == null
      ? "service groups"
      : plural(visibleCount, "service group");
  const summary =
    visibleCount == null
      ? "Purchases"
      : group
        ? `All ${hasCriteria ? "matching " : ""}${groupLabel}`
        : `${hasMore ? "Most recent" : "All"} ${visibleCount} ${
            hasCriteria ? "matching " : ""
          }${purchaseLabel}`;
  const filterInfo =
    hasFilterCriteria && visibleCount != null && purchases != null
      ? `Showing ${visibleCount} matching ${purchaseLabel} from ${loadedCount} loaded.`
      : "";
  const clearFilterOnSelectPurchase = (id: number) => {
    if (filter) {
      setFilter("");
    }
    loadUntilPurchase(id);
  };
  const print = visiblePurchases
    ? {
        title: getPrintTitle({
          cutoff,
          cutoffEnd,
          filterText,
          group: !!group,
          hasMore,
          noStatement,
          thisMonth,
        }),
        columns: group
          ? GROUPED_PRINT_COLUMNS
          : getDetailedPrintColumns({
              membershipTierLabels,
              showBalance: visiblePurchases.some(
                ({ balance }) => balance != null,
              ),
            }),
      }
    : undefined;

  return (
    <div style={style}>
      <ShowError error={error} setError={setError} />
      <Space wrap style={{ marginBottom: "8px" }}>
        {viewControls}
        {!group && (
          <>
            <Input.Search
              allowClear
              placeholder="Filter purchases..."
              style={{ width: 320, maxWidth: "100%" }}
              value={filter}
              onChange={(e) => setFilter(e.target.value ?? "")}
            />
            {!!filterInfo && (
              <Alert
                showIcon
                type="info"
                title={filterInfo}
                style={{ padding: "4px 12px" }}
              />
            )}
          </>
        )}
      </Space>
      <Flex justify="space-between" align="center" wrap gap="small">
        <Tooltip title="These are transactions made within CoCalc, which includes all purchases and credits resulting from payments.">
          <Space>
            <span>{summary}</span>
            {!group && hasMore && (
              <Button disabled={loading} onClick={() => loadMore()}>
                Load more
              </Button>
            )}
            {loading && <Spin />}
          </Space>
        </Tooltip>
        <Space wrap>
          {(day_statement_id != null || month_statement_id != null) && (
            <EmailStatement
              statement_id={(day_statement_id ?? month_statement_id) as number}
            />
          )}
          <Export
            name={
              filename ??
              getFilename({
                thisMonth,
                cutoff,
                cutoffEnd,
                filter: group ? "" : filterText,
                group,
                limit: group ? undefined : limit,
                offset: group ? undefined : offset,
                noStatement,
              })
            }
            data={visiblePurchases}
            print={print}
          />
          <Refresh handleRefresh={refreshRecords} style={{ marginRight: 0 }} />
        </Space>
      </Flex>
      <div style={{ textAlign: "center", marginTop: "15px" }}>
        {group ? (
          <GroupedPurchaseTable purchases={groupedPurchases} />
        ) : (
          <DetailedPurchaseTable
            membershipTierLabels={membershipTierLabels}
            purchases={filteredPurchases}
            admin={!!account_id}
            refresh={refreshRecords}
            onSelectPurchase={clearFilterOnSelectPurchase}
          />
        )}
      </div>
    </div>
  );
}

const GROUPED_PRINT_COLUMNS: PrintColumn<PurchaseItem>[] = [
  {
    title: "Service",
    align: "center",
    render: ({ service }) =>
      service != null ? serviceToDisplay(service as Service) : "",
  },
  {
    title: "Amount",
    align: "right",
    render: formatAmountForPrint,
  },
  {
    title: "Items",
    align: "center",
    render: ({ count }) => count ?? "",
  },
];

function getDetailedPrintColumns({
  membershipTierLabels,
  showBalance,
}: {
  membershipTierLabels: MembershipTierLabels;
  showBalance: boolean;
}): PrintColumn<PurchaseItem>[] {
  const columns: PrintColumn<PurchaseItem>[] = [
    {
      title: "Id",
      align: "right",
      render: ({ id }) => id ?? "",
    },
    {
      title: "Service",
      align: "center",
      render: ({ service }) =>
        service != null ? serviceToDisplay(service as Service) : "",
    },
    {
      title: "Description",
      render: (purchase) =>
        purchaseDescriptionLinesForPrint({
          membershipTierLabels,
          purchase,
        }),
    },
    {
      title: "Time",
      render: ({ time }) => formatPrintDateTime(time),
    },
    {
      title: "Period",
      render: formatPeriodForPrint,
    },
    {
      title: "Amount",
      align: "right",
      render: formatAmountForPrint,
    },
  ];
  if (showBalance) {
    columns.push({
      title: "Balance",
      align: "right",
      render: ({ balance }) =>
        balance == null ? "" : currency(toDecimal(balance).toNumber(), 2),
    });
  }
  return columns;
}

function getPrintTitle({
  cutoff,
  cutoffEnd,
  filterText,
  group,
  hasMore,
  noStatement,
  thisMonth,
}: {
  cutoff?: Date;
  cutoffEnd?: Date;
  filterText: string;
  group: boolean;
  hasMore: boolean;
  noStatement?: boolean;
  thisMonth?: boolean;
}) {
  const phrases = [hasMore && !group ? "Most recent purchases" : "Purchases"];
  if (group) {
    phrases.push("grouped by service");
  }
  if (thisMonth) {
    phrases.push("since last statement");
  }
  if (noStatement) {
    phrases.push("not on a statement");
  }
  if (cutoff && cutoffEnd) {
    phrases.push(
      `from ${formatPrintDate(cutoff)} to ${formatPrintDate(cutoffEnd)}`,
    );
  } else if (cutoff) {
    phrases.push(`from ${formatPrintDate(cutoff)}`);
  } else if (cutoffEnd) {
    phrases.push(`through ${formatPrintDate(cutoffEnd)}`);
  }
  if (filterText.trim()) {
    phrases.push(`containing ${quoteFilter(filterText)}`);
  }
  return phrases.join(" ");
}

function quoteFilter(filterText: string) {
  return filterText.includes("'") ? `"${filterText}"` : `'${filterText}'`;
}

function purchaseDescriptionLinesForPrint({
  membershipTierLabels,
  purchase: { description, notes, service },
}: {
  membershipTierLabels: MembershipTierLabels;
  purchase: PurchaseItem;
}) {
  const descriptionAny = description as any;
  const lines =
    dedicatedHostDescriptionLines(description) ??
    [
      descriptionTextForPrint({ description, membershipTierLabels, service }),
    ].filter(Boolean);
  if (descriptionAny?.credit_id != null) {
    lines.push(`Credit Id: ${descriptionAny.credit_id}`);
  }
  if (descriptionAny?.refund_purchase_id != null) {
    lines.push(`REFUNDED: Transaction ${descriptionAny.refund_purchase_id}`);
  }
  const lineItems = Array.isArray(descriptionAny?.line_items)
    ? descriptionAny.line_items
    : [];
  if (lineItems.length > 1) {
    for (const { amount, description } of lineItems) {
      lines.push(`  ${description}: ${moneyToString(amount)}`);
    }
  }
  if (notes) {
    lines.push(`Notes: ${notes}`);
  }
  return lines;
}

function dedicatedHostProviderLabel(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "gcp":
      return "GCP";
    case "nebius":
      return "Nebius";
    default:
      return capitalize(provider);
  }
}

function dedicatedHostDiskTypeLabel(diskType?: string | null): string {
  const value = `${diskType ?? ""}`.trim().toLowerCase();
  switch (value) {
    case "pd-balanced":
    case "balanced":
      return "balanced";
    case "pd-standard":
    case "standard":
      return "standard";
    case "pd-ssd":
    case "ssd":
      return "SSD";
    default:
      return value.replace(/[-_]+/g, " ");
  }
}

function dedicatedHostDiskLabel({
  size,
  type,
  fallback,
}: {
  size?: number | null;
  type?: string | null;
  fallback: string;
}): string {
  const sizeLabel =
    typeof size === "number" && Number.isFinite(size) && size > 0
      ? `${size} GB`
      : "";
  const typeLabel = dedicatedHostDiskTypeLabel(type);
  return [sizeLabel, typeLabel, fallback].filter(Boolean).join(" ");
}

function dedicatedHostDescriptionLines(value: unknown): string[] | undefined {
  const description = value as DedicatedHostPurchase | undefined;
  if (
    description?.type === "dedicated-host" &&
    description.resource_kind === "compute-egress"
  ) {
    const title = `${description.host_name ?? ""}`.trim() || "VM public egress";
    const gb = Number(description.usage_bytes ?? 0) / 1_000_000_000;
    return [
      title,
      `${gb.toFixed(gb >= 10 ? 1 : 3)} GB public Internet egress · $${Number(description.unit_cost_usd_per_gb ?? 0.1).toFixed(2)}/GB`,
    ];
  }
  if (
    description?.type !== "dedicated-host" ||
    !description.billing_state ||
    !description.pricing_snapshot
  ) {
    return undefined;
  }
  const title = `${description.host_name ?? ""}`.trim() || "Dedicated host";
  const details = [
    description.billing_state === "running" ? "Running" : "Stopped",
    dedicatedHostProviderLabel(description.provider),
  ];
  const config = description.pricing_snapshot.configuration;
  if (description.billing_state === "running") {
    if (config.machine_type) {
      details.push(config.machine_type);
    }
  } else {
    const componentKeys = new Set(
      description.pricing_snapshot.components.map(({ key }) => key),
    );
    const disks: string[] = [];
    if (componentKeys.has("disk")) {
      disks.push(
        dedicatedHostDiskLabel({
          size: config.disk_gb,
          type: config.disk_type,
          fallback: "disk",
        }),
      );
    }
    if (componentKeys.has("shared_scratch_disk")) {
      disks.push(
        dedicatedHostDiskLabel({
          size: config.shared_disk_gb,
          type: config.shared_disk_type,
          fallback: "shared disk",
        }),
      );
    }
    if (disks.length > 0) {
      details.push(disks.join(" + "));
    }
  }
  if (description.region) {
    details.push(description.region);
  }
  if (description.billing_state === "running" && config.pricing_model != null) {
    details.push(config.pricing_model === "spot" ? "Spot" : "Standard");
  }
  return [title, details.join(" · ")];
}

function descriptionTextForPrint({
  description,
  membershipTierLabels,
  service,
}: Pick<PurchaseItem, "description" | "service"> & {
  membershipTierLabels: MembershipTierLabels;
}) {
  if (description == null || typeof service !== "string") {
    return "";
  }
  const descriptionAny = description as any;
  if (service === "student-pay") {
    return "Course fee";
  }
  if (service === "membership") {
    const teamLicenseLabel =
      formatTeamLicenseDebitPurchaseDescription(descriptionAny);
    if (teamLicenseLabel) {
      return teamLicenseLabel;
    }
    if (descriptionAny.type === "membership-package") {
      const kindLabel =
        descriptionAny.kind === "course"
          ? "Course membership"
          : descriptionAny.kind === "team"
            ? "Team membership package"
            : descriptionAny.kind === "site"
              ? "Site membership package"
              : "Membership package";
      const courseLabel =
        descriptionAny.kind === "course"
          ? `${descriptionAny.metadata?.course_title ?? descriptionAny.metadata?.course_path ?? ""}`.trim()
          : "";
      const seatLabel =
        descriptionAny.seat_count != null && descriptionAny.seat_count !== 1
          ? ` (${descriptionAny.seat_count} seats)`
          : "";
      return `${kindLabel}: ${membershipTierLabel(
        descriptionAny.membership_class,
        membershipTierLabels,
      )}${seatLabel}${
        courseLabel ? ` for ${courseLabel}` : ""
      }${descriptionAny.expanded_existing_package ? " expanded" : ""}`;
    }
    return `${formatMembershipDebitPurchaseDescription({
      description: descriptionAny,
      labels: membershipTierLabels,
    })}${
      descriptionAny.admin_assigned
        ? ` admin assigned${descriptionAny.assigned_by ? ` by ${descriptionAny.assigned_by}` : ""}`
        : ""
    }`;
  }
  if (service === "credit") {
    return descriptionAny.description ?? "Credit";
  }
  if (service === "refund") {
    return `Refund Transaction ${descriptionAny.purchase_id}; Reason: ${capitalize(
      descriptionAny.reason.replace(/_/g, " "),
    )}${descriptionAny.notes ? `; Notes: ${descriptionAny.notes}` : ""}`;
  }
  return capitalize(service);
}

function formatAmountForPrint(record: PurchaseItem) {
  const { cost } = record;
  if (cost == null) {
    if (record.period_start && record.cost_per_hour) {
      return formatHourlyRate(toDecimal(record.cost_per_hour).neg());
    }
    if (record.period_start && record.cost_so_far != null) {
      return currency(toDecimal(record.cost_so_far).neg().toNumber(), 2);
    }
    return "-";
  }
  return currency(toDecimal(cost).neg().toNumber(), 2);
}

function formatPeriodForPrint(record: PurchaseItem) {
  if (!record.period_start) {
    return "";
  }
  const hours = periodLengthInHours(record);
  const duration =
    hours > 0 && hours < 24 ? ` (${hoursToTimeIntervalHuman(hours)})` : "";
  if (!record.period_end) {
    return `${formatPrintDateTime(record.period_start)} - now${duration}`;
  }
  return `${formatPrintDateTime(record.period_start)} - ${formatPrintDateTime(
    record.period_end,
  )}${duration}`;
}

function formatPrintDateTime(date?: Date | string | number) {
  if (!date) {
    return "";
  }
  return dayjs(date).format("MMMM D, YYYY h:mm A");
}

function formatPrintDate(date: Date) {
  return dayjs(date).format("MMMM D, YYYY");
}

export function GroupedPurchaseTable({
  purchases,
  hideColumns,
  style,
}: {
  purchases: PurchaseItem[] | null;
  hideColumns?: Set<string>;
  style?;
}) {
  if (purchases == null) {
    return <Spin size="large" />;
  }
  return (
    <div style={style}>
      <Table
        size="small"
        pagination={false}
        scroll={{ x: "max-content" }}
        dataSource={purchases}
        rowKey={({ service }) => service ?? ""}
        columns={[
          {
            hidden: hideColumns?.has("service"),
            title: "Service",
            dataIndex: "service",
            key: "service",
            align: "center" as "center",
            sorter: (a, b) =>
              (a.service ?? "").localeCompare(b.service ?? "") ?? -1,
            sortDirections: ["ascend", "descend"],
            render: (service) => <ServiceTag service={service} />,
          },
          {
            hidden: hideColumns?.has("amount"),
            title: "Amount",
            dataIndex: "cost",
            key: "cost",
            align: "right" as "right",
            render: (cost) => <Amount record={{ cost }} />,
            sorter: (a: any, b: any) =>
              toDecimal(a.cost ?? 0).comparedTo(b.cost ?? 0),
            sortDirections: ["ascend", "descend"],
          },

          {
            hidden: hideColumns?.has("items"),
            title: "Items",
            dataIndex: "count",
            key: "count",
            align: "center" as "center",
            sorter: (a: any, b: any) => (a.count ?? 0) - (b.count ?? 0),
            sortDirections: ["ascend", "descend"],
          },
        ]}
      />
    </div>
  );
}

export function DetailedPurchaseTable({
  membershipTierLabels = {},
  purchases,
  admin,
  refresh,
  hideColumns,
  onSelectPurchase,
}: {
  membershipTierLabels?: MembershipTierLabels;
  purchases: PurchaseItem[] | null;
  admin?: boolean;
  refresh?;
  hideColumns?: Set<string>;
  onSelectPurchase?: (id: number) => void;
}) {
  const fragment = useTypedRedux("account", "fragment");
  const tableRef = useRef<HTMLDivElement | null>(null);
  const [hideBalance, setHideBalance] = useState<boolean>(false);
  const [highlightedPurchaseId, setHighlightedPurchaseId] = useState<
    number | undefined
  >(undefined);

  const selectPurchase = (id: number) => {
    if (!Number.isFinite(id)) {
      return;
    }
    onSelectPurchase?.(id);
    setHighlightedPurchaseId(id);
    const nextFragment = { id: `${id}` };
    redux.getActions("account").setFragment(nextFragment);
    Fragment.set(nextFragment);
  };

  useEffect(() => {
    if (purchases == null) {
      return;
    }
    let hideBalance = true;
    for (const purchase of purchases) {
      if (purchase.balance != null) {
        hideBalance = false;
        break;
      }
    }
    setHideBalance(hideBalance);
    const id = parseInt(fragment?.get("id") ?? Fragment.get()?.id ?? "");
    if (!Number.isFinite(id)) {
      setHighlightedPurchaseId(undefined);
      return;
    }
    for (const purchase of purchases) {
      if (purchase.id == id) {
        setHighlightedPurchaseId(id);
        return;
      }
    }
  }, [fragment, purchases]);

  useEffect(() => {
    if (highlightedPurchaseId == null) {
      return;
    }
    const timeout = setTimeout(() => {
      tableRef.current
        ?.querySelector<HTMLElement>(
          `[data-purchase-id="${highlightedPurchaseId}"]`,
        )
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    }, 0);
    return () => clearTimeout(timeout);
  }, [highlightedPurchaseId, purchases]);

  if (purchases == null) {
    return <Spin size="large" />;
  }
  return (
    <div ref={tableRef}>
      <Table
        className="cocalc-purchases-table"
        size="small"
        pagination={false}
        dataSource={purchases}
        rowKey="id"
        rowClassName={(purchase) =>
          purchase.id === highlightedPurchaseId ? "ant-table-row-selected" : ""
        }
        onRow={(purchase) =>
          ({
            "data-purchase-id": purchase.id,
          }) as any
        }
        columns={[
          {
            title: "Id",
            dataIndex: "id",
            key: "id",
            align: "right" as "right",
            sorter: (a, b) => (a.id ?? 0) - (b.id ?? 0),
            sortDirections: ["ascend", "descend"],
          },
          {
            hidden: hideColumns?.has("service"),
            title: "Service",
            dataIndex: "service",
            key: "service",
            align: "center" as "center",
            sorter: (a, b) => (a.service ?? "").localeCompare(b.service ?? ""),
            sortDirections: ["ascend", "descend"],
            render: (service) => <ServiceTag service={service} />,
          },
          {
            hidden: hideColumns?.has("description"),
            title: "Description",
            dataIndex: "description",
            key: "description",
            render: (_, purchase) => (
              <PurchaseDescription
                {...(purchase as any)}
                admin={admin}
                membershipTierLabels={membershipTierLabels}
                refresh={refresh}
                onSelectPurchase={selectPurchase}
              />
            ),
          },
          {
            hidden: hideColumns?.has("time"),
            title: "Time",
            dataIndex: "time",
            key: "time",
            minWidth: 110,
            render: (text) => {
              return <TimeAgo date={text} />;
            },
            sorter: (a, b) =>
              new Date(a.time ?? 0).getTime() - new Date(b.time ?? 0).getTime(),
            sortDirections: ["ascend", "descend"],
          },
          {
            hidden: hideColumns?.has("period_start"),
            title: "Period",
            dataIndex: "period_start",
            key: "period",
            minWidth: 110,
            render: (_, record) => <Period record={record} />,
            sorter: (a, b) =>
              new Date(a.period_start ?? 0).getTime() -
              new Date(b.period_start ?? 0).getTime(),
            sortDirections: ["ascend", "descend"],
          },
          {
            hidden: hideColumns?.has("amount"),
            title: "Amount",
            align: "right" as "right",
            dataIndex: "cost",
            key: "cost",
            render: (_, record) => (
              <>
                <Amount record={record} />
              </>
            ),
            sorter: (a, b) => toDecimal(a.cost ?? 0).comparedTo(b.cost ?? 0),
            sortDirections: ["ascend", "descend"],
          },
          {
            hidden: hideBalance || hideColumns?.has("balance"),
            title: "Balance",
            align: "right" as "right",
            dataIndex: "balance",
            key: "balance",
            render: (_, { balance }) =>
              balance != undefined ? <Balance balance={balance} /> : null,
          },
        ]}
      />
    </div>
  );
}

function PurchaseDescription({
  id,
  description,
  invoice_id,
  membershipTierLabels,
  notes,
  service,
  admin,
  cost,
  refresh,
  onSelectPurchase,
}) {
  const [showLineItems, setShowLineItems] = useState<boolean>(false);
  const lineItems = Array.isArray(description?.line_items)
    ? description.line_items
    : [];
  const showLineItemsToggle = lineItems.length > 1;
  const showCreditLink = description?.credit_id != null;
  const showRefundedMarker = description?.refund_purchase_id != null;
  const showAdminRefund =
    admin &&
    description?.refund_purchase_id == null &&
    id != null &&
    isRefundable(service, cost);
  const showInvoiceActions = invoice_id != null;
  const showActions =
    showCreditLink ||
    showRefundedMarker ||
    showAdminRefund ||
    showInvoiceActions ||
    showLineItemsToggle;
  return (
    <Space vertical size={0}>
      <Description
        service={service}
        description={description}
        membershipTierLabels={membershipTierLabels}
        onSelectPurchase={onSelectPurchase}
      />
      {showActions && (
        <Space wrap>
          {showCreditLink && (
            <RelatedPurchaseLink
              purchaseId={description.credit_id}
              onSelectPurchase={onSelectPurchase}
            >
              Credit Id: {description.credit_id}
            </RelatedPurchaseLink>
          )}
          {showRefundedMarker && (
            <span>
              Refunded:{" "}
              <RelatedPurchaseLink
                purchaseId={description.refund_purchase_id}
                onSelectPurchase={onSelectPurchase}
              >
                Transaction {description.refund_purchase_id}
              </RelatedPurchaseLink>
            </span>
          )}
          {showAdminRefund && (
            <AdminRefund
              purchase_id={id}
              service={service}
              cost={cost}
              subscription_id={description?.subscription_id}
              membership_package={description?.type === "membership-package"}
              refresh={refresh}
            />
          )}
          {showInvoiceActions && (
            <>
              {!admin && !description?.refund_purchase_id && (
                <Button
                  size="small"
                  type="link"
                  target="_blank"
                  href={getSupportURL({
                    body: `I would like to request a full refund for transaction ${id}.\n\nEXPLAIN WHAT HAPPENED.  THANKS!`,
                    subject: `Refund Request: Transaction ${id}`,
                    type: "purchase",
                    hideExtra: true,
                  })}
                >
                  <Icon name="support" /> Request refund
                </Button>
              )}
              <InvoiceLink invoice_id={invoice_id} />
            </>
          )}
          {showLineItemsToggle && (
            <Button
              size="small"
              type="link"
              onClick={() => setShowLineItems(!showLineItems)}
            >
              {showLineItems
                ? "Hide line items"
                : `Show ${lineItems.length} ${plural(lineItems.length, "line item")}`}
            </Button>
          )}
        </Space>
      )}
      {showLineItems && (
        <LineItemsTable lineItems={lineItems} style={{ marginTop: "8px" }} />
      )}
      {notes && <StaticMarkdown value={`**Notes:** ${notes}`} />}
    </Space>
  );
}

// "credit" | "openai-gpt-4" | "membership", etc.

function RelatedPurchaseLink({ children, onSelectPurchase, purchaseId }) {
  const id = Number(purchaseId);
  if (!Number.isFinite(id)) {
    return <>{children}</>;
  }
  return <a onClick={() => onSelectPurchase?.(id)}>{children}</a>;
}

function Description({
  description,
  membershipTierLabels,
  service,
  onSelectPurchase,
}: {
  description: any;
  membershipTierLabels: MembershipTierLabels;
  service: any;
  onSelectPurchase?;
}) {
  if (description == null) {
    return null;
  }

  if (typeof service !== "string") {
    // service should be DescriptionType["type"]
    return null;
  }

  // <pre>{JSON.stringify(description, undefined, 2)}</pre>
  if (service === "student-pay") {
    return <>Course fee</>;
  }
  if (service === "membership") {
    const teamLicenseLabel =
      formatTeamLicenseDebitPurchaseDescription(description);
    if (teamLicenseLabel) {
      return <>{teamLicenseLabel}</>;
    }
    if (description?.type === "membership-package") {
      const {
        expanded_existing_package,
        kind,
        membership_class,
        metadata,
        seat_count,
      } = description;
      const kindLabel =
        kind === "course"
          ? "Course membership"
          : kind === "team"
            ? "Team membership package"
            : kind === "site"
              ? "Site membership package"
              : "Membership package";
      const courseLabel =
        kind === "course"
          ? `${metadata?.course_title ?? metadata?.course_path ?? ""}`.trim()
          : "";
      return (
        <>
          {kindLabel}:{" "}
          {membershipTierLabel(membership_class, membershipTierLabels)}
          {seat_count != null && seat_count !== 1
            ? ` (${seat_count} seats)`
            : ""}
          {courseLabel ? <> for {courseLabel}</> : null}
          {expanded_existing_package ? (
            <>
              {" "}
              <Tag color="blue">expanded</Tag>
            </>
          ) : null}
        </>
      );
    }
    const { admin_assigned, assigned_by } = description;
    return (
      <>
        {formatMembershipDebitPurchaseDescription({
          description,
          labels: membershipTierLabels,
        })}
        {admin_assigned ? (
          <>
            {" "}
            <Tag color="blue">admin assigned</Tag>
            {assigned_by ? ` by ${assigned_by}` : ""}
          </>
        ) : null}
      </>
    );
  }
  if (service === "credit") {
    return <>{description?.description ?? "Credit"}</>;
  }
  if (service === "refund") {
    const { notes, reason, purchase_id } = description;
    return (
      <Space vertical size={0}>
        <span>
          Refund{" "}
          <RelatedPurchaseLink
            purchaseId={purchase_id}
            onSelectPurchase={onSelectPurchase}
          >
            Transaction {purchase_id}
          </RelatedPurchaseLink>
        </span>
        <span>Reason: {capitalize(reason.replace(/_/g, " "))}</span>
        {!!notes && <span>Notes: {notes}</span>}
      </Space>
    );
  }
  const dedicatedHostLines = dedicatedHostDescriptionLines(description);
  if (dedicatedHostLines) {
    return (
      <Space vertical size={0}>
        {dedicatedHostLines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </Space>
    );
  }

  // generic fallback...
  return (
    <>
      <Popover
        title={() => <pre>{JSON.stringify(description, undefined, 2)}</pre>}
      >
        {capitalize(service)}
      </Popover>
    </>
  );
}

function InvoiceLink({ invoice_id }) {
  const [loading, setLoading] = useState<boolean>(false);
  const [unknown, setUnknown] = useState<boolean>(false);
  return (
    <Button
      size="small"
      disabled={unknown}
      type="link"
      onClick={async () => {
        try {
          setLoading(true);
          const invoiceUrl = await getInvoiceUrlOrNull(invoice_id);
          if (invoiceUrl) {
            open_new_tab(invoiceUrl, false);
          } else {
            setUnknown(true);
          }
        } finally {
          setLoading(false);
        }
      }}
    >
      <Icon name="external-link" /> Receipt{" "}
      {unknown ? " (ERROR: receipt not found)" : ""}
      {loading && <Spin style={{ marginLeft: "30px" }} />}
    </Button>
  );
}

function Amount({ record }) {
  const { cost } = record;
  if (cost == null) {
    // it's a partial ongoing purchase
    if (record.period_start && record.cost_per_hour) {
      // it's a pay-as-you-go purchase with a fixed rate
      return (
        <Space vertical size={0} align="end">
          <DynamicallyUpdatingCost
            costPerHour={record.cost_per_hour}
            start={new Date(record.period_start).valueOf()}
            showTooltip={false}
          />
          <Typography.Text type="secondary">
            {formatHourlyRate(toDecimal(record.cost_per_hour).neg())}
          </Typography.Text>
        </Space>
      );
    } else if (record.period_start && record.cost_so_far != null) {
      const amountValue = toDecimal(record.cost_so_far).neg();
      const amount = amountValue.toNumber();
      // it's a metered pay as you go purchase
      return <span style={getAmountStyle(amount)}>{currency(amount, 2)}</span>;
    }
  }
  if (cost != null) {
    const amountValue = toDecimal(cost).neg();
    const amount = amountValue.toNumber();
    return (
      <span style={getAmountStyle(amount, record.pending)}>
        {currency(amount, 2)}
      </span>
    );
  }
  return <>-</>;
}

function Balance({ balance }) {
  if (balance != null) {
    const balanceValue = toDecimal(balance);
    return (
      <span style={getAmountStyle(balanceValue.toNumber())}>
        {currency(balanceValue.toNumber(), 2)}
      </span>
    );
  }
  return <>-</>;
}

function getFilename({
  thisMonth,
  cutoff,
  cutoffEnd,
  filter,
  group,
  limit,
  offset,
  noStatement,
}) {
  const v: string[] = [];
  if (thisMonth) {
    v.push("since_last_statement");
  }
  if (noStatement) {
    v.push("not_on_statement");
  }
  if (cutoff) {
    v.push(`from-${new Date(cutoff).toISOString().split("T")[0]}`);
  }
  if (cutoffEnd) {
    v.push(`to-${new Date(cutoffEnd).toISOString().split("T")[0]}`);
  }
  if (group) {
    v.push("grouped");
  }
  if (filter) {
    v.push("filtered");
  }
  if (!group) {
    if (limit) {
      v.push(`limit${limit}`);
    }
    if (offset) {
      v.push(`offset${offset}`);
    }
  }
  return v.join("-");
}

export function PurchasesButton(props: Props) {
  const [show, setShow] = useState<boolean>(false);
  return (
    <div>
      <Button onClick={() => setShow(!show)} type={show ? "dashed" : undefined}>
        <Icon name="table" /> Purchases
      </Button>
      {show && (
        <div style={{ marginTop: "8px" }}>
          <Purchases {...props} />
        </div>
      )}
    </div>
  );
}

// this should match with sql formula in server/purchases/get-balance.ts
function getCost(row: PurchaseItem) {
  if (row.cost != null) {
    return row.cost;
  }
  if (row.cost_so_far != null) {
    return moneyRoundToCents(row.cost_so_far);
  }
  if (row.cost_per_hour != null && row.period_start != null) {
    const hours = periodLengthInHours(row);
    return moneyRoundToCents(toDecimal(row.cost_per_hour).mul(hours));
  }
  return 0;
}

// start = end = iso time strings
// if end not given, assumed now
function periodLengthInHours({
  period_start,
  period_end,
}: {
  period_start?: Date;
  period_end?: Date;
}) {
  if (period_start == null) {
    return 0;
  }
  const end = period_end != null ? period_end.valueOf() : Date.now();
  const start = period_start.valueOf();
  const ms = end - start;
  const hours = ms / (1000 * 3600);
  return hours;
}

function Active({ record }) {
  const { cost } = record;
  if (cost != null) {
    return null; // not active
  }
  // it's a partial ongoing purchase
  if (record.period_start && record.cost_per_hour != null) {
    // it's a pay-as-you-go purchase with a fixed rate
    return (
      <Tooltip title="This purchase is ongoing. Its amount updates at the displayed hourly rate.">
        <Tag color="green" style={{ margin: 0 }}>
          Active
        </Tag>
      </Tooltip>
    );
  } else if (record.period_start && record.cost_so_far != null) {
    // it's a metered pay as you go purchase
    return (
      <Tooltip title="This metered purchase is ongoing. Its amount updates as usage is reported and is finalized when its billing period or resource ends.">
        <Tag color="green" style={{ margin: 0 }}>
          Active
        </Tag>
      </Tooltip>
    );
  }
  return null;
}

function Period({ record }) {
  if (record.period_start) {
    const hours = periodLengthInHours(record);
    const duration =
      hours > 0 && hours < 24 ? (
        <div style={{ borderTop: "1px solid #ccc" }}>
          {hoursToTimeIntervalHuman(hours)}
        </div>
      ) : null;
    return (
      <div>
        <Space wrap size={[4, 0]}>
          <TimeAgo date={record.period_start} />
          <span>to</span>
          {record.period_end ? <TimeAgo date={record.period_end} /> : "now"}
          <Active record={record} />
        </Space>
        {duration}
      </div>
    );
  }
  return null;
}

function getFilter(purchase) {
  if (purchase.filter == null) {
    purchase.filter = JSON.stringify(purchase).toLowerCase();
  }
  return purchase.filter;
}
