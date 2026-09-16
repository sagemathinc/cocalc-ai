import { Alert, Descriptions, Typography } from "antd";
import type { CloudflareBootstrapResult } from "@cocalc/conat/hub/api/system";

export default function CloudflareBootstrapResultView({
  result,
}: {
  result: CloudflareBootstrapResult;
}) {
  const saved = result.tunnel_token.ok;
  const details = (
    <div style={{ marginTop: 12, overflowWrap: "anywhere" }}>
      {saved && (
        <Typography.Paragraph>
          Automation and R2 credentials are saved server-side. Run provisioning
          and diagnostics to verify storage access; no secrets are returned to
          the browser.
        </Typography.Paragraph>
      )}
      {(saved || result.durable_token_id) && (
        <Descriptions column={1} size="small">
          <Descriptions.Item label="Account">
            {result.account_name} {result.account_id}
          </Descriptions.Item>
          <Descriptions.Item label="Zone">
            {result.zone_name} {result.zone_id}
          </Descriptions.Item>
          <Descriptions.Item label="Durable token ID">
            {result.durable_token_id}
          </Descriptions.Item>
          <Descriptions.Item label="Durable permissions">
            {result.permissions?.join(", ")}
          </Descriptions.Item>
          <Descriptions.Item label="Tunnel capability">
            {saved ? "Ready" : "Needs attention"}{" "}
            {result.failure ? undefined : result.tunnel_token.message}
          </Descriptions.Item>
          <Descriptions.Item label="Visitor location headers">
            {result.visitor_location_headers.ok
              ? "Ready"
              : saved
                ? "Needs attention"
                : "Not run"}{" "}
            {result.visitor_location_headers.message}
          </Descriptions.Item>
          <Descriptions.Item label="R2 administration">
            {result.r2.ok ? "Ready" : "Needs attention"} {result.r2.message}
          </Descriptions.Item>
        </Descriptions>
      )}
      {result.notes.length > 0 && (
        <Typography.Paragraph style={{ marginTop: 12 }}>
          {result.notes.join(" ")}
        </Typography.Paragraph>
      )}
      <Typography.Paragraph style={{ marginTop: 12, marginBottom: 0 }}>
        {result.bootstrap_token_invalidated
          ? "Temporary bootstrap token revoked."
          : "Delete the temporary bootstrap token manually in Cloudflare."}
        {result.bootstrap_token_id && (
          <> Bootstrap token ID: {result.bootstrap_token_id}</>
        )}
      </Typography.Paragraph>
    </div>
  );
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Alert
        showIcon
        type={saved ? "success" : "warning"}
        title={
          saved
            ? "Cloudflare configuration saved"
            : "Cloudflare bootstrap needs attention"
        }
        description={
          saved ? (
            <details>
              <summary style={{ cursor: "pointer" }}>Details</summary>
              {details}
            </details>
          ) : (
            <>
              <Typography.Paragraph>
                {result.failure ?? result.tunnel_token.message}
              </Typography.Paragraph>
              <Typography.Paragraph>
                {result.settings_status === "not_saved"
                  ? "No site settings were changed. Later configuration checks were not run. Review token cleanup below, then retry with a new bootstrap token."
                  : result.settings_status === "saved"
                    ? "Settings were saved on the seed bay. Follow the recovery instructions above before running diagnostics. No returned tokens are applied by the browser."
                    : "Saving may have partially completed. Review the cleanup notes and saved settings before retrying. No returned tokens are applied by the browser."}
              </Typography.Paragraph>
              {details}
            </>
          )
        }
      />
      {saved && (!result.visitor_location_headers.ok || !result.r2.ok) && (
        <Alert
          showIcon
          type="warning"
          title="Configuration needs attention"
          description={
            <>
              {!result.visitor_location_headers.ok && (
                <div>
                  Visitor location headers:{" "}
                  {result.visitor_location_headers.message ??
                    "Not verified. Run diagnostics."}
                </div>
              )}
              {!result.r2.ok && (
                <div>
                  R2: {result.r2.message ?? "Not verified. Run diagnostics."}
                </div>
              )}
            </>
          }
        />
      )}
      {result.cleanup_required && result.bootstrap_token_invalidated && (
        <Alert
          showIcon
          type="warning"
          title="Temporary Cloudflare tokens need manual cleanup"
          description={result.notes.join(" ")}
        />
      )}
      {!result.bootstrap_token_invalidated && (
        <Alert
          showIcon
          type="warning"
          title="Delete the temporary bootstrap token manually in Cloudflare"
          description={
            result.bootstrap_token_id
              ? `Bootstrap token ID: ${result.bootstrap_token_id}`
              : "Check Cloudflare API Tokens for temporary tokens requiring cleanup."
          }
        />
      )}
    </div>
  );
}
