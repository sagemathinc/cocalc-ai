import useDiskUsage, { type StorageVisibleSummary } from "./use-disk-usage";
import {
  Alert,
  Button,
  Modal,
  Progress,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import ShowError from "@cocalc/frontend/components/error";
import { human_readable_size } from "@cocalc/util/misc";
import { useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { redux } from "@cocalc/frontend/app-framework";
import { dirname, posix } from "path";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

function bucketPercent(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((100 * bytes) / total);
}

function relativeLabel(bucket: StorageVisibleSummary): string {
  return bucket.key === "home" ? "/root" : bucket.label;
}

export default function DiskUsage({
  project_id,
  style,
}: {
  project_id: string;
  style?;
}) {
  const [expand, setExpand] = useState<boolean>(false);
  const { visible, loading, error, setError, refresh, quotas } = useDiskUsage({
    project_id,
  });
  const quota = quotas[0] ?? null;
  const [selectedBucketKey, setSelectedBucketKey] = useState<
    "home" | "scratch"
  >("home");

  const selectedBucket =
    visible.find((bucket) => bucket.key === selectedBucketKey) ?? visible[0];

  const percent =
    quota == null || quota.size <= 0
      ? 0
      : Math.round((100 * quota.used) / quota.size);
  const quotaStatus = percent > 80 ? "exception" : undefined;
  const visibleTotal = Math.max(
    visible.reduce((sum, bucket) => sum + bucket.usage.bytes, 0),
    1,
  );

  const summary = (
    <Button
      onClick={() => {
        refresh();
        setExpand(!expand);
      }}
      style={{
        ...style,
        alignItems: "center",
        display: "flex",
        gap: "10px",
        height: "auto",
        justifyContent: "flex-start",
        padding: "6px 10px",
        textAlign: "left",
      }}
    >
      <Icon name="disk-round" />
      <Space size={10} wrap>
        <Text strong>Project quota</Text>
        {quota != null ? (
          <>
            <Progress
              style={{ width: "60px", marginBottom: 0 }}
              percent={percent}
              status={quotaStatus}
              showInfo={false}
            />
            <Text>
              {human_readable_size(quota.used)} /{" "}
              {human_readable_size(quota.size)}
            </Text>
          </>
        ) : (
          <Spin delay={1000} />
        )}
        {visible.map((bucket) => (
          <Tag key={bucket.key}>
            {relativeLabel(bucket)} {human_readable_size(bucket.usage.bytes)}
          </Tag>
        ))}
        {loading && <Spin delay={1000} />}
      </Space>
    </Button>
  );

  return (
    <>
      {summary}
      {expand && (
        <Modal
          onOk={() => setExpand(false)}
          onCancel={() => setExpand(false)}
          open
          width={700}
        >
          <ShowError error={error} setError={setError} />
          <h5 style={{ marginTop: 0 }}>
            <Icon name="disk-round" /> Project storage overview
            <Button
              onClick={() => refresh()}
              style={{ float: "right", marginRight: "30px" }}
            >
              Reload
            </Button>
          </h5>
          {quota != null && (
            <>
              <div style={{ textAlign: "center" }}>
                <Progress
                  type="circle"
                  percent={percent}
                  status={quotaStatus}
                  format={() => `${percent}%`}
                />
              </div>
              <div style={{ marginTop: "15px" }}>
                <b>{quota.label}:</b> {human_readable_size(quota.used)} out of{" "}
                {human_readable_size(quota.size)}
                <div style={{ color: COLORS.GRAY_M, marginTop: "8px" }}>
                  Counted quota usage may differ from visible file sizes because
                  compression, deduplication, snapshots, and storage accounting
                  do not have the same semantics as browsing `/root` or
                  `/scratch`.
                </div>
              </div>
            </>
          )}
          {percent >= 100 && (
            <Alert
              style={{ margin: "15px 0" }}
              showIcon
              message="OVER QUOTA"
              description="Delete files or increase your quota."
              type="error"
            />
          )}
          {visible.length > 0 && (
            <>
              <hr />
              <div style={{ marginBottom: "10px" }}>
                <b>Visible storage</b>
              </div>
              {visible.map((bucket) => (
                <div
                  key={bucket.key}
                  style={{
                    alignItems: "center",
                    display: "flex",
                    gap: "10px",
                    marginBottom: "8px",
                  }}
                >
                  <div style={{ minWidth: "70px" }}>
                    <Text strong>{relativeLabel(bucket)}</Text>
                  </div>
                  <Progress
                    style={{ flex: 1, marginBottom: 0 }}
                    percent={bucketPercent(bucket.usage.bytes, visibleTotal)}
                    showInfo={false}
                  />
                  <div style={{ minWidth: "120px", textAlign: "right" }}>
                    {human_readable_size(bucket.usage.bytes)}
                  </div>
                </div>
              ))}
            </>
          )}
          {selectedBucket != null && (
            <>
              <hr />
              <div style={{ marginBottom: "10px" }}>
                <Space size={12} wrap>
                  <b>Find space in</b>
                  <Segmented
                    options={visible.map((bucket) => ({
                      label: relativeLabel(bucket),
                      value: bucket.key,
                    }))}
                    onChange={(value) =>
                      setSelectedBucketKey(value as "home" | "scratch")
                    }
                    value={selectedBucket.key}
                  />
                </Space>
              </div>
              <div>
                {selectedBucket.usage.children
                  .filter(
                    ({ bytes }) =>
                      bytes / Math.max(selectedBucket.usage.bytes, 1) > 0.01,
                  )
                  .map(({ path, bytes }) => {
                    const absolutePath = posix.join(selectedBucket.path, path);
                    return (
                      <div
                        key={`${selectedBucket.key}:${path}`}
                        style={{ width: "100%", display: "flex" }}
                      >
                        <Progress
                          style={{ flex: 1, marginRight: "30px" }}
                          percent={bucketPercent(
                            bytes,
                            Math.max(selectedBucket.usage.bytes, 1),
                          )}
                        />
                        <a
                          style={{ flex: 1 }}
                          onClick={async () => {
                            const actions = redux.getProjectActions(project_id);
                            const fs = actions.fs();
                            const stats = await fs.stat(absolutePath);
                            const nextPath = stats.isDirectory()
                              ? absolutePath
                              : dirname(absolutePath);
                            actions.set_current_path(nextPath);
                            setExpand(false);
                          }}
                        >
                          {absolutePath}
                        </a>
                      </div>
                    );
                  })}
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
