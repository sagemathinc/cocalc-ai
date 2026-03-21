import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { SyncOutlined } from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import type { Host, HostRootfsImage } from "@cocalc/conat/hub/api/hosts";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { human_readable_size, plural } from "@cocalc/util/misc";

type HostRootfsCachePanelProps = {
  host: Host;
  canManage: boolean;
  inventory?: {
    entries: HostRootfsImage[];
    loading: boolean;
    error?: string;
    refreshing: boolean;
    actionKey?: string;
    refresh: () => Promise<void>;
    pull: (image: string) => Promise<void>;
    remove: (image: string) => Promise<void>;
  };
};

function shortDigest(value?: string): string | undefined {
  const digest = `${value ?? ""}`.trim();
  if (!digest) return undefined;
  if (digest.length <= 28) return digest;
  return `${digest.slice(0, 24)}...`;
}

function sectionLabel(section?: string): string | undefined {
  switch (section) {
    case "official":
      return "Official";
    case "mine":
      return "Mine";
    case "collaborators":
      return "Collaborator";
    case "public":
      return "Public";
    default:
      return undefined;
  }
}

export function HostRootfsCachePanel({
  host,
  canManage,
  inventory,
}: HostRootfsCachePanelProps) {
  const [pullImage, setPullImage] = React.useState<string>();
  const { images: catalogImages, loading: catalogLoading } = useRootfsImages([
    managedRootfsCatalogUrl(),
  ]);

  const catalogByImage = React.useMemo(
    () => new Map(catalogImages.map((entry) => [entry.image, entry])),
    [catalogImages],
  );
  const pullOptions = React.useMemo(
    () =>
      catalogImages.map((entry) => ({
        value: entry.image,
        label: `${entry.label} (${entry.image})`,
      })),
    [catalogImages],
  );
  const totals = React.useMemo(() => {
    const size = (inventory?.entries ?? []).reduce(
      (sum, entry) => sum + (entry.size_bytes ?? 0),
      0,
    );
    const projects = (inventory?.entries ?? []).reduce(
      (sum, entry) => sum + entry.project_count,
      0,
    );
    return { size, projects };
  }, [inventory?.entries]);

  React.useEffect(() => {
    if (pullImage || pullOptions.length === 0) return;
    setPullImage(pullOptions[0].value);
  }, [pullImage, pullOptions]);

  if (!canManage) {
    return null;
  }

  const hostRunning = host.status === "running";

  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Space wrap align="center">
        <Typography.Text strong>RootFS cache</Typography.Text>
        {inventory && (
          <Button
            type="text"
            size="small"
            icon={<SyncOutlined spin={inventory.refreshing} />}
            onClick={() => {
              inventory.refresh().catch((err) => {
                console.error("failed to refresh host rootfs cache", err);
              });
            }}
          >
            Refresh
          </Button>
        )}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Pull and evict managed RootFS images on this host. Deleting an image
        only clears the local cache; stopped projects will pull it again on the
        next start.
      </Typography.Text>
      {!hostRunning && (
        <Alert
          type="info"
          showIcon
          message="Host must be running to inspect or manage its RootFS cache."
        />
      )}
      {inventory?.error && (
        <Alert type="warning" showIcon message={inventory.error} />
      )}
      {hostRunning && inventory && (
        <>
          <Space wrap size={[8, 8]}>
            <Tag>
              {inventory.entries.length}{" "}
              {plural(inventory.entries.length, "cached image")}
            </Tag>
            <Tag>{human_readable_size(totals.size)}</Tag>
            <Tag>
              {totals.projects} {plural(totals.projects, "project reference")}
            </Tag>
          </Space>
          <Space.Compact style={{ width: "100%" }}>
            <Select
              style={{ flex: 1 }}
              showSearch
              placeholder="Select managed RootFS image to cache"
              options={pullOptions}
              value={pullImage}
              loading={catalogLoading}
              onChange={(value) => setPullImage(value)}
              filterOption={(input, option) =>
                `${option?.label ?? ""}`
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
            <Button
              type="primary"
              loading={inventory.actionKey?.startsWith("pull:")}
              disabled={!pullImage}
              onClick={() => {
                if (!pullImage) return;
                inventory.pull(pullImage).catch((err) => {
                  console.error("failed to pull host rootfs image", err);
                });
              }}
            >
              Pull
            </Button>
          </Space.Compact>
          {inventory.loading ? (
            <Typography.Text type="secondary">
              Loading RootFS cache…
            </Typography.Text>
          ) : inventory.entries.length === 0 ? (
            <Typography.Text type="secondary">
              No cached RootFS images yet.
            </Typography.Text>
          ) : (
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              {inventory.entries.map((entry) => {
                const catalogEntry = catalogByImage.get(entry.image);
                const running = entry.running_project_count > 0;
                const actionKey = inventory.actionKey;
                return (
                  <Card
                    key={entry.image}
                    size="small"
                    bodyStyle={{ padding: "12px" }}
                  >
                    <Space
                      orientation="vertical"
                      size="small"
                      style={{ width: "100%" }}
                    >
                      <Space wrap align="center">
                        <Typography.Text strong>
                          {catalogEntry?.label ?? entry.image}
                        </Typography.Text>
                        {catalogEntry?.official && (
                          <Tag color="green">Official</Tag>
                        )}
                        {!catalogEntry?.official &&
                          sectionLabel(catalogEntry?.section) && (
                            <Tag>{sectionLabel(catalogEntry?.section)}</Tag>
                          )}
                        <Tag>{human_readable_size(entry.size_bytes ?? 0)}</Tag>
                        <Tag>
                          {entry.project_count}{" "}
                          {plural(entry.project_count, "project")}
                        </Tag>
                        {running && (
                          <Tag color="green">
                            {entry.running_project_count}{" "}
                            {plural(
                              entry.running_project_count,
                              "running project",
                            )}
                          </Tag>
                        )}
                      </Space>
                      <Typography.Text copyable={{ text: entry.image }}>
                        Image: <code>{entry.image}</code>
                      </Typography.Text>
                      {entry.digest && (
                        <Typography.Text copyable={{ text: entry.digest }}>
                          Digest: <code>{shortDigest(entry.digest)}</code>
                        </Typography.Text>
                      )}
                      {entry.cache_path && (
                        <Typography.Text copyable={{ text: entry.cache_path }}>
                          Cache path: <code>{entry.cache_path}</code>
                        </Typography.Text>
                      )}
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        Cached:{" "}
                        {entry.cached_at
                          ? new Date(entry.cached_at).toLocaleString()
                          : "unknown"}
                        {entry.project_ids.length > 0
                          ? ` · ${entry.project_ids.length} ${plural(
                              entry.project_ids.length,
                              "project",
                            )} on this host`
                          : ""}
                      </Typography.Text>
                      <Space wrap>
                        <Popconfirm
                          title={
                            running
                              ? "Stop the running projects that use this image before deleting the local cache."
                              : "Delete this RootFS image from the host cache?"
                          }
                          okText="Delete"
                          cancelText="Cancel"
                          disabled={running}
                          onConfirm={() => {
                            inventory.remove(entry.image).catch((err) => {
                              console.error(
                                "failed to delete host rootfs image",
                                err,
                              );
                            });
                          }}
                        >
                          <Button
                            size="small"
                            danger
                            disabled={running}
                            loading={actionKey === `delete:${entry.image}`}
                          >
                            Delete cache
                          </Button>
                        </Popconfirm>
                      </Space>
                    </Space>
                  </Card>
                );
              })}
            </Space>
          )}
        </>
      )}
    </Space>
  );
}
