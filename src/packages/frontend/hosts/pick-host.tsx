import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Dropdown,
  List,
  Modal,
  Radio,
  Space,
  Tag,
  Typography,
} from "antd";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { labels } from "@cocalc/frontend/i18n";
import { useIntl } from "react-intl";
import {
  mapCloudRegionToR2Region,
  R2_REGION_LABELS,
  type R2Region,
} from "@cocalc/util/consts";
import {
  recommendProjectHosts,
  type ProjectHostRecommendation,
} from "@cocalc/frontend/hosts/project-host-recommendations";

import { getHostStatusTooltip } from "./constants";
import {
  HostPlacementSummary,
  HostPressureTag,
  hostPressureRank,
} from "./pressure-ui";
import { isSpotHost, SpotHostTag } from "./spot-ui";

const STATUS_COLOR = {
  stopped: "red",
  off: "red",
  running: "green",
  starting: "blue",
  restarting: "blue",
  stopping: "orange",
  provisioning: "blue",
  deprovisioned: "default",
} as const;

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  starting: 1,
  restarting: 2,
  error: 3,
  off: 4,
  stopping: 5,
  deprovisioned: 6,
};

const SCOPE_ORDER: Record<string, number> = {
  owned: 0,
  collab: 1,
  pool: 2,
  shared: 3,
};

function autoSelectCompare(a: Host, b: Host): number {
  const aStatus = STATUS_ORDER[a.status] ?? 99;
  const bStatus = STATUS_ORDER[b.status] ?? 99;
  if (aStatus !== bStatus) return aStatus - bStatus;

  const aPressure = hostPressureRank(a);
  const bPressure = hostPressureRank(b);
  if (aPressure !== bPressure) return aPressure - bPressure;

  const aProjects =
    typeof a.projects === "number" ? a.projects : Number.MAX_SAFE_INTEGER;
  const bProjects =
    typeof b.projects === "number" ? b.projects : Number.MAX_SAFE_INTEGER;
  if (aProjects !== bProjects) return aProjects - bProjects;

  const aScope = SCOPE_ORDER[a.scope ?? ""] ?? 99;
  const bScope = SCOPE_ORDER[b.scope ?? ""] ?? 99;
  if (aScope !== bScope) return aScope - bScope;

  return (a.name || "").localeCompare(b.name || "");
}

export function HostPickerModal({
  open,
  onCancel,
  onSelect,
  currentHostId,
  selectedHostId,
  regionFilter,
  sourceProjectRegion,
  lockRegion,
  showOfflineMoveWarning,
  wantsGpu,
  mode = "move",
}: {
  open: boolean;
  currentHostId?: string;
  selectedHostId?: string;
  onCancel: () => void;
  onSelect: (host_id: string, host?: Host) => void;
  regionFilter?: string;
  sourceProjectRegion?: string;
  lockRegion?: boolean;
  showOfflineMoveWarning?: boolean;
  wantsGpu?: boolean;
  mode?: "move" | "assign" | "create";
}) {
  const isCreate = mode === "create";
  const isAssign = mode === "assign";
  const title = isCreate
    ? "Choose host"
    : isAssign
      ? "Assign to host"
      : "Move to host";
  return (
    <Modal
      width={600}
      open={open}
      onCancel={onCancel}
      footer={null}
      title={
        <Space>
          <Icon name="server" /> {title}
        </Space>
      }
      destroyOnHidden
    >
      <HostPickerPanel
        active={open}
        currentHostId={currentHostId}
        selectedHostId={selectedHostId}
        regionFilter={regionFilter}
        sourceProjectRegion={sourceProjectRegion}
        lockRegion={lockRegion}
        showOfflineMoveWarning={showOfflineMoveWarning}
        wantsGpu={wantsGpu}
        mode={mode}
        onCancel={onCancel}
        onSelect={onSelect}
      />
    </Modal>
  );
}

export function HostPickerPanel({
  active,
  onCancel,
  onSelect,
  currentHostId,
  selectedHostId,
  regionFilter,
  sourceProjectRegion,
  lockRegion,
  showOfflineMoveWarning,
  wantsGpu,
  mode = "move",
}: {
  active: boolean;
  currentHostId?: string;
  selectedHostId?: string;
  onCancel: () => void;
  onSelect: (host_id: string, host?: Host) => void;
  regionFilter?: string;
  sourceProjectRegion?: string;
  lockRegion?: boolean;
  showOfflineMoveWarning?: boolean;
  wantsGpu?: boolean;
  mode?: "move" | "assign" | "create";
}) {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectsLabel = intl.formatMessage(labels.projects);
  const isCreate = mode === "create";
  const isAssign = mode === "assign";
  const isMove = mode === "move";
  const isInitialPlacement = isCreate || isAssign;
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [regionFilterState, setRegionFilterState] = useState<
    string | undefined
  >(regionFilter);
  const [autoExpandedRemote, setAutoExpandedRemote] = useState(false);

  const currentHost = useMemo(
    () => hosts.find((host) => host.id === currentHostId),
    [hosts, currentHostId],
  );
  const currentHostAvailable = useMemo(() => {
    if (!currentHostId) return true;
    if (!currentHost) return false;
    if (currentHost.deleted) return false;
    return ["running", "starting", "restarting", "error"].includes(
      currentHost.status,
    );
  }, [currentHost, currentHostId]);
  const selectedHost = useMemo(
    () => hosts.find((host) => host.id === selected),
    [hosts, selected],
  );
  const selectedHostRegion = selectedHost
    ? mapCloudRegionToR2Region(selectedHost.region)
    : undefined;
  const crossRegionCutoverSelected =
    isMove &&
    !!sourceProjectRegion &&
    !!selectedHostRegion &&
    selectedHostRegion !== sourceProjectRegion;
  const sourceProjectRegionLabel = sourceProjectRegion
    ? (R2_REGION_LABELS[sourceProjectRegion] ?? sourceProjectRegion)
    : undefined;
  const selectedHostRegionLabel = selectedHostRegion
    ? (R2_REGION_LABELS[selectedHostRegion] ?? selectedHostRegion)
    : undefined;

  const filteredHosts = useMemo(() => {
    return hosts.filter((h) => {
      if (!showUnavailable && h.can_place === false) return false;
      if (
        regionFilterState &&
        mapCloudRegionToR2Region(h.region) !== regionFilterState
      )
        return false;
      return true;
    });
  }, [hosts, showUnavailable, regionFilterState]);

  const initialPlacementRecommendations = useMemo(() => {
    if (!isInitialPlacement || !regionFilter) return undefined;
    return recommendProjectHosts({
      hosts,
      projectRegion: regionFilter as R2Region,
      wantsGpu,
      selectedHostId,
    });
  }, [hosts, isInitialPlacement, regionFilter, selectedHostId, wantsGpu]);

  const initialPlacementRecommendationByHostId = useMemo(() => {
    const byId = new Map<string, ProjectHostRecommendation>();
    if (!initialPlacementRecommendations) return byId;
    for (const recommendation of [
      ...initialPlacementRecommendations.candidates,
      ...initialPlacementRecommendations.unavailable,
    ]) {
      byId.set(recommendation.host.id, recommendation);
    }
    return byId;
  }, [initialPlacementRecommendations]);

  function initialPlacementHostCompare(a: Host, b: Host): number {
    const aRecommendation = initialPlacementRecommendationByHostId.get(a.id);
    const bRecommendation = initialPlacementRecommendationByHostId.get(b.id);
    if (aRecommendation || bRecommendation) {
      const aScore = aRecommendation?.score ?? Number.NEGATIVE_INFINITY;
      const bScore = bRecommendation?.score ?? Number.NEGATIVE_INFINITY;
      if (aScore !== bScore) return bScore - aScore;
    }
    return autoSelectCompare(a, b);
  }

  const selectableHosts = useMemo(() => {
    return filteredHosts.filter(
      (h) =>
        h.can_place !== false && (isInitialPlacement || h.id !== currentHostId),
    );
  }, [filteredHosts, isInitialPlacement, currentHostId]);

  const bestSelectableHost = useMemo(() => {
    const preferred = selectableHosts.find((h) => h.id === selectedHostId);
    if (preferred) return preferred;
    if (isInitialPlacement && initialPlacementRecommendations) {
      const selectable = new Set(selectableHosts.map((host) => host.id));
      const recommended = initialPlacementRecommendations.candidates.find(
        (entry) => selectable.has(entry.host.id),
      );
      if (recommended) return recommended.host;
    }
    return [...selectableHosts].sort(autoSelectCompare)[0];
  }, [
    initialPlacementRecommendations,
    isInitialPlacement,
    selectableHosts,
    selectedHostId,
  ]);

  const noSelectableTarget =
    !loading && hosts.length > 0 && selectableHosts.length === 0;

  const grouped = useMemo(() => {
    const groups: { label: string; items: Host[] }[] = [];
    const addGroup = (label: string, items: Host[]) => {
      if (items.length) groups.push({ label, items });
    };

    const filtered = filteredHosts;

    const current = filtered.filter((h) => h.id === currentHostId);
    const owned = filtered.filter(
      (h) =>
        h.scope === "owned" && (isInitialPlacement || h.id !== currentHostId),
    );
    const collab = filtered.filter(
      (h) =>
        h.scope === "collab" && (isInitialPlacement || h.id !== currentHostId),
    );
    const pool = filtered.filter(
      (h) =>
        h.scope === "pool" && (isInitialPlacement || h.id !== currentHostId),
    );
    const poolByTier = new Map<number, Host[]>();
    for (const host of pool) {
      const tier = host.tier ?? 0;
      const list = poolByTier.get(tier) ?? [];
      list.push(host);
      poolByTier.set(tier, list);
    }

    addGroup("Current host", current);
    addGroup(`Your hosts (${owned.length})`, owned);
    addGroup(`Collaborator hosts (${collab.length})`, collab);
    for (const tier of Array.from(poolByTier.keys()).sort((a, b) => a - b)) {
      const items = poolByTier.get(tier) ?? [];
      addGroup(`Shared pool (tier ${tier}) (${items.length})`, items);
    }

    const items: any[] = [];
    for (const g of groups) {
      items.push({ type: "header", label: g.label });
      items.push(
        ...g.items
          .sort(
            isInitialPlacement
              ? initialPlacementHostCompare
              : autoSelectCompare,
          )
          .map((h) => ({ type: "host", host: h })),
      );
    }
    return items;
  }, [
    filteredHosts,
    currentHostId,
    isCreate,
    isInitialPlacement,
    initialPlacementRecommendationByHostId,
  ]);

  const availableRegions = useMemo(() => {
    const regions = new Set<string>();
    for (const host of hosts) {
      const mapped = mapCloudRegionToR2Region(host.region);
      if (mapped) regions.add(mapped);
    }
    return Array.from(regions);
  }, [hosts]);

  const load = async () => {
    setLoading(true);
    try {
      const list = await webapp_client.conat_client.hub.hosts.listHosts({
        catalog: true,
      });
      setHosts(list);
    } catch (err) {
      console.error("failed to load hosts", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) {
      load().catch(console.error);
      if (regionFilter) {
        setRegionFilterState(regionFilter);
      }
      setAutoExpandedRemote(false);
    }
  }, [active, regionFilter, selectedHostId]);

  useEffect(() => {
    if (
      !active ||
      !isInitialPlacement ||
      !regionFilter ||
      loading ||
      autoExpandedRemote ||
      regionFilterState !== regionFilter
    ) {
      return;
    }
    if (
      initialPlacementRecommendations?.projectRegionCandidates.length === 0 &&
      initialPlacementRecommendations.remoteCandidates.length > 0
    ) {
      setRegionFilterState(undefined);
      setAutoExpandedRemote(true);
    }
  }, [
    active,
    autoExpandedRemote,
    initialPlacementRecommendations,
    isInitialPlacement,
    loading,
    regionFilter,
    regionFilterState,
  ]);

  useEffect(() => {
    if (!active) return;
    if (selected && selectableHosts.some((h) => h.id === selected)) return;
    setSelected(bestSelectableHost?.id);
  }, [active, selected, selectableHosts, bestSelectableHost]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {showOfflineMoveWarning && currentHostId && !currentHostAvailable && (
        <Alert
          type="warning"
          showIcon
          title={
            currentHost
              ? `Source host is ${currentHost.status}`
              : "Source host is unavailable"
          }
          description="Moving now will use the most recent backup. If it is older than the last edit, you will be asked to confirm."
          style={{ marginBottom: 12 }}
        />
      )}
      <Typography.Paragraph type="secondary">
        {isCreate ? (
          <>
            Pick a project host for this new project. Placement tags show when a
            host is normal, stressed, or blocked for automatic placement.
          </>
        ) : isAssign ? (
          <>
            Pick a project host for this project. Since the project is not
            assigned to a host yet, no existing host-local files or snapshots
            will be discarded.
          </>
        ) : (
          <>
            Pick a project host to move this project to. Placement tags show
            when a host is normal, stressed, or blocked for automatic placement.
          </>
        )}
      </Typography.Paragraph>
      {isMove ? (
        <Alert
          type="warning"
          showIcon
          title={
            currentHost?.status === "deprovisioned"
              ? "Source host is deprovisioned. The host disk no longer exists; this move restores from backups."
              : "Files in /tmp (if any) will be discarded. All previous snapshots will be discarded after the move. SSH access must be reconfigured after the move."
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {crossRegionCutoverSelected ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="This move will also change the project's backup region."
          description={`CoCalc will restore from the current ${sourceProjectRegionLabel} backups, create a new backup in ${selectedHostRegionLabel}, then switch the project's backup region after that backup succeeds. After the cutover, all previous backups from ${sourceProjectRegionLabel} will be discarded.`}
        />
      ) : null}
      {isInitialPlacement &&
        autoExpandedRemote &&
        regionFilter &&
        initialPlacementRecommendations?.recommended && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            title={`No available host in ${R2_REGION_LABELS[regionFilter] ?? regionFilter}.`}
            description={`Showing remote hosts instead. Region mainly affects interactive latency, such as typing in terminals or waiting for notebook output; project host and region can be changed later.`}
          />
        )}
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" onClick={load} loading={loading}>
          Refresh
        </Button>
        <Button
          size="small"
          onClick={() => setShowUnavailable((v) => !v)}
          type={showUnavailable ? "primary" : "default"}
        >
          {showUnavailable ? "Hide unavailable" : "Show unavailable"}
        </Button>
        {!lockRegion && (
          <Dropdown
            menu={{
              items: [
                { key: "all", label: "All regions" },
                ...availableRegions.map((region) => ({
                  key: region,
                  label: R2_REGION_LABELS[region] ?? region,
                })),
              ],
              onClick: ({ key }) =>
                setRegionFilterState(key === "all" ? undefined : key),
            }}
            trigger={["click"]}
          >
            <Button size="small">
              Region:{" "}
              {regionFilterState
                ? (R2_REGION_LABELS[regionFilterState] ?? regionFilterState)
                : "All"}
            </Button>
          </Dropdown>
        )}
        {lockRegion && regionFilterState && (
          <Tag color="geekblue">
            Region: {R2_REGION_LABELS[regionFilterState] ?? regionFilterState}
          </Tag>
        )}
      </Space>
      {noSelectableTarget && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={
            isCreate
              ? "No available host can be used for this new project."
              : isAssign
                ? "No available host can be assigned to this project."
                : "No available destination host can be used for this move."
          }
          description="Try another region, start/provision a host, or adjust host permissions."
        />
      )}
      <Radio.Group
        style={{ width: "100%" }}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <List
          bordered
          dataSource={grouped}
          loading={loading}
          locale={{ emptyText: "No available hosts" }}
          renderItem={(item) => {
            if (item.type === "header") {
              return (
                <List.Item style={{ background: "#f7f7f7" }}>
                  <Typography.Text strong>{item.label}</Typography.Text>
                </List.Item>
              );
            }
            const host = item.host as Host;
            const disabled =
              (isMove && host.id === currentHostId) || host.can_place === false;
            const muted = !host.can_place;
            return (
              <List.Item style={muted ? { opacity: 0.6 } : undefined}>
                <Space
                  orientation="vertical"
                  style={{ width: "100%" }}
                  size="small"
                >
                  <Space
                    align="center"
                    style={{ width: "100%", justifyContent: "space-between" }}
                  >
                    <Space wrap>
                      <Radio value={host.id} disabled={disabled}>
                        {host.name}
                      </Radio>
                      {isSpotHost(host) && <SpotHostTag host={host} />}
                      <Tooltip
                        title={getHostStatusTooltip(
                          host.status,
                          Boolean(host.deleted),
                          host.provider_observed_at,
                        )}
                      >
                        <Tag color={STATUS_COLOR[host.status] ?? "default"}>
                          {host.status}
                        </Tag>
                      </Tooltip>
                      {host.tier != null && (
                        <Tag color={host.can_place ? "blue" : "default"}>
                          Tier {host.tier}
                        </Tag>
                      )}
                      <HostPressureTag pressure={host.pressure} />
                      {host.can_place !== false ? (
                        <Tag color="green">Available</Tag>
                      ) : (
                        <Tag icon={<Icon name="lock" />} color="default">
                          Locked
                        </Tag>
                      )}
                    </Space>
                    <Space>
                      <Tag>{host.region}</Tag>
                      <Tag>{host.size}</Tag>
                      {host.gpu && <Tag color="purple">GPU</Tag>}
                    </Space>
                  </Space>
                  <Typography.Text type="secondary">
                    {projectsLabel}: {host.projects ?? 0}
                  </Typography.Text>
                  <HostPlacementSummary
                    host={host}
                    compact
                    detailMode="popover"
                    showNormal
                  />
                  {isMove && host.id === currentHostId && (
                    <Typography.Text type="secondary">
                      This {projectLabel.toLowerCase()} is already on this host.
                    </Typography.Text>
                  )}
                  {host.can_place === false && host.reason_unavailable && (
                    <Typography.Text type="secondary" italic>
                      {host.reason_unavailable}
                    </Typography.Text>
                  )}
                  {muted && <Divider style={{ margin: "4px 0" }} dashed />}
                </Space>
              </List.Item>
            );
          }}
        />
      </Radio.Group>
      <Space wrap style={{ justifyContent: "flex-end", width: "100%" }}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          type="primary"
          disabled={!selected || noSelectableTarget}
          loading={loading}
          onClick={() => {
            if (!selected) return;
            const host = hosts.find((h) => h.id === selected);
            if (!host) return;
            onSelect(selected, host);
          }}
        >
          {isCreate ? "Use host" : isAssign ? "Assign to host" : "Move to host"}
        </Button>
      </Space>
    </Space>
  );
}
