import { useState } from "react";
import { Alert, Button, Descriptions, Modal, Typography } from "antd";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { ComputeVolume } from "@cocalc/conat/hub/api/compute";
import { moneyToCurrency } from "@cocalc/util/money";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { VolumePersonalFundingApi } from "@cocalc/util/compute-volume-personal-funding";
import VolumePersonalFunding from "./compute-volume-personal-funding";
import {
  volumeCourseSource,
  volumeFundingLabel,
  volumeFundingUnavailable,
} from "./compute-volume-funding";

function amount(value?: string) {
  if (value == null) return "Unavailable";
  try {
    return moneyToCurrency(value);
  } catch {
    return "Unavailable";
  }
}
function date(value?: string) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time)
    ? new Date(time).toLocaleString()
    : "Unavailable";
}

export function VolumeRetentionNotice() {
  return (
    <Alert
      showIcon
      type="warning"
      title="Independent home-volume retention"
      description="This volume remains billable when its VM stops or is deleted. Its course allowance pays for storage and up to 72 hours of reserved cleanup grace within the allowance. Its own funding and deletion deadlines apply. There is no automatic personal charge or automatic backup."
    />
  );
}

export function VolumeFundingDetailsButton({
  volume,
  label,
  personalApi,
}: {
  volume: ComputeVolume;
  label?: string;
  personalApi?: VolumePersonalFundingApi;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="link"
        style={{
          maxWidth: "100%",
          height: "auto",
          whiteSpace: "normal",
          textAlign: "left",
        }}
        aria-label={`Funding and retention for ${volume.name}`}
        onClick={() => setOpen(true)}
      >
        {label ?? volumeFundingLabel(volume)}
      </Button>
      <Modal
        open={open}
        title={`Storage funding: ${volume.name}`}
        onCancel={() => setOpen(false)}
        footer={null}
        width={520}
        modalRender={(node) => (
          <KeyboardBoundary boundary="volume-funding">{node}</KeyboardBoundary>
        )}
      >
        <VolumeFundingStatus volume={volume} />
        {personalApi &&
          volume.funding_status?.funding_version &&
          volume.state !== "deleted" && (
            <VolumePersonalFunding
              key={volume.id}
              volumeId={volume.id}
              fundingVersion={volume.funding_status.funding_version}
              canSwitch={
                volume.state === "ready" &&
                !volume.attached_vm_id &&
                volume.attachment_state === "detached"
              }
              api={personalApi}
            />
          )}
      </Modal>
    </>
  );
}

export default function VolumeFundingStatus({
  volume,
}: {
  volume: ComputeVolume;
}) {
  const source = volumeCourseSource(volume);
  const funding = volume.funding_status;
  return (
    <section
      aria-label={`Funding for home volume ${volume.name}`}
      style={{ overflowWrap: "anywhere" }}
    >
      <Typography.Text strong>{volumeFundingLabel(volume)}</Typography.Text>
      {source && volumeFundingUnavailable(volume) && (
        <Alert
          showIcon
          type="warning"
          title="Volume funding status is unavailable, expired, or out of date."
        />
      )}
      <Descriptions
        column={1}
        size="small"
        styles={{
          label: {
            color: UI_COLORS.secondary,
            flex: "0 0 45%",
            whiteSpace: "normal",
          },
          content: { minWidth: 0, flex: 1 },
        }}
        items={[
          {
            key: "owner",
            label: "Volume owner",
            children: volume.owner_account_id,
          },
          {
            key: "payer",
            label: "Storage payer",
            children: source
              ? funding?.label ||
                funding?.payer_account_id ||
                (source.kind === "course"
                  ? source.payer_account_id || "Course sponsor"
                  : volume.owner_account_id)
              : volume.funding_mode === "site-funded"
                ? "Site"
                : volume.owner_account_id,
          },
          ...(source
            ? [
                {
                  key: "state",
                  label: "Funding state",
                  children: funding?.state ?? "Unavailable",
                },
                {
                  key: "spent",
                  label: "Spent",
                  children: amount(funding?.spent_usd),
                },
                {
                  key: "committed",
                  label: "Committed to this volume",
                  children: amount(funding?.committed_usd),
                },
                {
                  key: "protected",
                  label: "Protected storage and cleanup",
                  children: amount(funding?.protected_storage_usd),
                },
                {
                  key: "until",
                  label: "Storage funded until",
                  children: date(funding?.authorized_until),
                },
                {
                  key: "delete",
                  label: "Volume deletion deadline",
                  children: date(funding?.storage_delete_at),
                },
                {
                  key: "asof",
                  label: "Updated",
                  children: date(funding?.as_of),
                },
              ]
            : []),
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        This volume keeps its own payer and retention policy when attached to a
        VM. Deleting the VM does not delete the home volume. No automatic backup
        is made.
      </Typography.Paragraph>
    </section>
  );
}
