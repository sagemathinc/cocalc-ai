import { useState } from "react";
import { Alert, Button, Empty, Modal, Space, Spin, Typography } from "antd";
import { AuditOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ApiKeyActionReview } from "@cocalc/util/api-key-management";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function ApiKeyActionReviews({
  onExecuted,
}: {
  onExecuted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [reviews, setReviews] = useState<ApiKeyActionReview[]>([]);
  const [selected, setSelected] = useState<ApiKeyActionReview>();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function load() {
    setBusy(true);
    setLoaded(false);
    setError("");
    setSelected(undefined);
    try {
      await runFreshAuthAction(async () => {
        setReviews(
          await webapp_client.conat_client.hub.apiKeys.listActions({}),
        );
        setLoaded(true);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: "execute" | "reject") {
    if (!selected) return;
    const reviewed = selected;
    setBusy(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const result =
          await webapp_client.conat_client.hub.apiKeys.decideAction({
            reviewed,
            decision,
          });
        setReviews((old) =>
          old.filter((item) => item.request_id !== result.request_id),
        );
        setSelected(undefined);
        if (result.status === "executed") await onExecuted();
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        icon={<AuditOutlined aria-hidden="true" />}
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        Review API requests
      </Button>
      <Modal
        title="Review API requests"
        open={open}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        footer={null}
        width={640}
      >
        <KeyboardBoundary boundary="api-key-action-review">
          <Space
            orientation="vertical"
            style={{ width: "100%", overflowWrap: "anywhere" }}
          >
            {error && <Alert type="error" title={error} showIcon />}
            {busy && <Spin aria-label="Loading API requests" />}
            {selected ? (
              <>
                <Typography.Title level={5}>
                  Revoke {selected.target_name || "Unnamed API key"}?
                </Typography.Title>
                <dl>
                  <dt>Target key</dt>
                  <dd>{selected.binding.target_key_id}</dd>
                  <dt>Key ending</dt>
                  <dd>{selected.target_trunc}</dd>
                  <dt>Requesting key</dt>
                  <dd>{selected.binding.requesting_key_id}</dd>
                  <dt>Expires</dt>
                  <dd>{new Date(selected.expires_at).toLocaleString()}</dd>
                </dl>
                <Typography.Paragraph>
                  This permanently revokes the selected API key.
                </Typography.Paragraph>
                <Space wrap>
                  <Button
                    danger
                    type="primary"
                    disabled={busy}
                    onClick={() => void decide("execute")}
                  >
                    Approve revocation
                  </Button>
                  <Button disabled={busy} onClick={() => void decide("reject")}>
                    Reject request
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => setSelected(undefined)}
                  >
                    Back
                  </Button>
                </Space>
              </>
            ) : (
              <>
                <Button
                  icon={<ReloadOutlined aria-hidden="true" />}
                  disabled={busy}
                  onClick={() => void load()}
                >
                  Refresh requests
                </Button>
                {loaded && reviews.length === 0 && (
                  <Empty description="No pending requests" />
                )}
                {loaded &&
                  reviews.map((review) => (
                    <div key={review.request_id}>
                      <Typography.Text>
                        Revoke {review.target_name || "Unnamed API key"} (
                        {review.target_trunc})
                      </Typography.Text>{" "}
                      <Button
                        disabled={busy}
                        onClick={() => setSelected(review)}
                        aria-label={`Review revocation of ${review.target_name || review.binding.target_key_id}`}
                      >
                        Review
                      </Button>
                    </div>
                  ))}
              </>
            )}
          </Space>
        </KeyboardBoundary>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
