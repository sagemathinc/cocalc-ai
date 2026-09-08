import { Alert, Button, Descriptions, Form, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { CloudflareBootstrapResult } from "@cocalc/conat/hub/api/system";
import { handleErrorMessage } from "@cocalc/conat/util";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import SecretSettingInput from "./secret-setting-input";
import type { FreshAuthActionRunner } from "@cocalc/frontend/auth/fresh-auth";

function bootstrapTokenUrl(domain: string): string {
  // Template URL format: https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
  // Do not substitute account_api_tokens, which manages account-owned tokens.
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify([{ key: "api_tokens", type: "edit" }]),
    accountId: "*",
    zoneId: "all",
    name: `CoCalc temporary bootstrap${domain.trim() ? ` - ${domain.trim()}` : ""}`,
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${params}`;
}

export default function CloudflareBootstrap({
  domain,
  tunnelPrefix,
  hostSuffix,
  r2BucketPrefix,
  onSaved,
  onBusy,
  token,
  setToken,
  runFreshAuthAction,
  disabled,
}: {
  domain: string;
  tunnelPrefix: string;
  hostSuffix: string;
  r2BucketPrefix: string;
  onSaved: (result: CloudflareBootstrapResult) => void;
  onBusy: (busy: boolean) => void;
  token: string;
  setToken: (token: string) => void;
  runFreshAuthAction: FreshAuthActionRunner;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [result, setResult] = useState<CloudflareBootstrapResult>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function bootstrap() {
    if (disabled || busy || !token.trim() || !domain.trim()) return;
    const request = {
      browser_id: webapp_client.browser_id,
      domain: domain.trim(),
      token: token.trim(),
      tunnelPrefix,
      hostSuffix,
      r2BucketPrefix,
    };
    setToken("");
    setBusy(true);
    onBusy(true);
    setError(false);
    setCancelled(false);
    setResult(undefined);
    try {
      // Keep the one-time secret only in this pending request while fresh auth
      // completes. The auth runner retries only a fresh-auth rejection.
      const completed = await runFreshAuthAction(async () => {
        const response: CloudflareBootstrapResult = handleErrorMessage(
          await webapp_client.conat_client.callHubApi({
            name: "system.bootstrapCloudflareConfiguration",
            args: [request],
            timeout: 5 * 60_000,
          }),
        );
        if (!mounted.current) return;
        setResult(response);
        if (response.tunnel_token.ok) onSaved(response);
      });
      if (!completed && mounted.current) setCancelled(true);
    } catch {
      // Do not display RPC exceptions: they could contain the submitted secret.
      if (mounted.current) setError(true);
    } finally {
      request.token = "";
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }

  return (
    <section aria-label="Cloudflare bootstrap">
      <Typography.Paragraph type="secondary">
        Give CoCalc a temporary token to configure Cloudflare automatically.
        CoCalc saves narrower automation and R2 credentials for ongoing use, not
        this temporary token.
      </Typography.Paragraph>
      <Typography.Paragraph>
        Go to{" "}
        <Typography.Link
          href={bootstrapTokenUrl(domain)}
          target="_blank"
          rel="noreferrer"
          style={{ overflowWrap: "anywhere" }}
        >
          https://dash.cloudflare.com/profile/api-tokens
        </Typography.Link>
        .
        <br />
        Set the <strong>End Date</strong> to <strong>today</strong>.
        <br />
        Create the token with the prefilled permission, then paste it below.
      </Typography.Paragraph>
      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: "pointer" }}>
          Permissions, security, and token handling
        </summary>
        <Typography.Paragraph style={{ marginTop: 12 }}>
          The prefilled permission is <strong>User / API Tokens / Edit</strong>.
          It is powerful: it can create other tokens, including tokens with R2
          access. CoCalc uses it only during setup and attempts to revoke it
          afterward. Cloudflare's form uses dates, not a duration in minutes;
          setting the End Date to today limits its lifetime if cleanup fails.
          Site-admin fresh authentication may be required.
        </Typography.Paragraph>
        <Typography.Text strong>What CoCalc does</Typography.Text>
        <ul>
          <li>
            Verify it and create an ephemeral Zone Read discovery token across
            all zones with a 10-minute TTL, solely to find the matching zone and
            account. Only the durable token is scoped to the selected account
            and zone.
          </li>
          <li>
            Create and save one durable automation token scoped to that account
            and zone for tunnels, DNS, R2 bucket administration, Workers, and
            required zone settings. Account permissions cover Workers, tunnels
            and R2 buckets throughout the selected account; they are not
            restricted to this site's resource names. DNS and zone permissions
            are limited to the selected zone.
          </li>
          <li>
            Create separate R2 S3 credentials restricted to this site's six
            regional backup buckets and blob bucket, including future buckets
            with those exact names. Existing complete credentials are preserved,
            not rotated. The S3 token has object read/write access, not bucket
            administration, DNS, Workers, or token-management permissions.
          </li>
          <li>
            Configure visitor location headers and attempt to revoke both
            bootstrap and discovery tokens.
          </li>
          <li>
            Use saved credentials for retryable bucket and Worker provisioning
            in the next step. This flow is auditable in the CoCalc source code.
          </li>
        </ul>
        <Typography.Text strong>What CoCalc does not do</Typography.Text>
        <ul>
          <li>
            Persist the bootstrap token, return it to the browser, send it to
            project hosts or user projects, or use it for ongoing operations.
            The browser clears the input on submit or when you leave setup; the
            token remains only in memory while the setup request completes.
          </li>
          <li>
            Give the durable token API-token-management permission or
            permissions scoped to other accounts or zones. The temporary
            read-only discovery token can list zones to find the match.
          </li>
          <li>
            Make the R2 bucket public or return the S3 secret to the browser.
            Bootstrap saves credentials; the separate provisioning and
            diagnostic actions verify storage access before enabling blob
            delivery. Changing the account or bucket prefix of existing S3
            credentials requires explicit manual configuration and does not
            migrate data.
          </li>
        </ul>
      </details>
      <Form.Item
        label="Temporary bootstrap token"
        htmlFor="cloudflare-bootstrap-token"
      >
        <SecretSettingInput
          id="cloudflare-bootstrap-token"
          value={token}
          onChange={setToken}
          disabled={disabled || busy}
        />
      </Form.Item>
      <Button
        onClick={bootstrap}
        loading={busy}
        disabled={
          disabled ||
          busy ||
          !token.trim() ||
          !domain.trim() ||
          !tunnelPrefix.trim() ||
          !r2BucketPrefix.trim()
        }
      >
        Bootstrap and save Cloudflare
      </Button>
      <div role="status" aria-live="polite">
        {busy && (
          <Typography.Paragraph>
            Creating and saving the durable automation token...
          </Typography.Paragraph>
        )}
        {error && (
          <Alert
            type="error"
            title="Cloudflare bootstrap did not complete"
            description="The input has been cleared. Check saved settings before retrying; setup may have completed if the connection was interrupted. Delete any remaining temporary bootstrap or discovery tokens in Cloudflare, then create a new short-lived bootstrap token if needed."
          />
        )}
        {cancelled && (
          <Alert
            type="info"
            title="Cloudflare bootstrap verification cancelled"
            description="The temporary token input has been cleared. Paste the token again to retry while it is still valid, or delete it in Cloudflare."
          />
        )}
        {result && (
          <>
            <Alert
              type={result.tunnel_token.ok ? "success" : "warning"}
              title={
                result.tunnel_token.ok
                  ? "Durable Cloudflare configuration saved server-side"
                  : "Cloudflare bootstrap needs attention"
              }
              description={
                result.tunnel_token.ok
                  ? "Automation and R2 credentials are saved server-side. Run provisioning and diagnostics to verify storage access; no secrets are returned to the browser."
                  : "Review the cleanup notes and saved settings before retrying. Configuration may not have been saved. No returned tokens are applied by the browser."
              }
            />
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
                {result.tunnel_token.ok ? "Ready" : "Needs attention"}{" "}
                {result.tunnel_token.message}
              </Descriptions.Item>
              <Descriptions.Item label="Visitor location headers">
                {result.visitor_location_headers.ok
                  ? "Ready"
                  : "Needs attention"}{" "}
                {result.visitor_location_headers.message}
              </Descriptions.Item>
              <Descriptions.Item label="R2 administration">
                {result.r2.ok ? "Ready" : "Needs attention"} {result.r2.message}
              </Descriptions.Item>
              <Descriptions.Item label="Notes">
                {result.notes.join(" ")}
              </Descriptions.Item>
            </Descriptions>
            <Alert
              type={result.bootstrap_token_invalidated ? "success" : "warning"}
              title={
                result.bootstrap_token_invalidated
                  ? "Temporary bootstrap token revoked"
                  : "Delete the temporary bootstrap token manually in Cloudflare"
              }
              description={
                result.bootstrap_token_id
                  ? `Bootstrap token ID: ${result.bootstrap_token_id}`
                  : "Check Cloudflare API Tokens for temporary tokens requiring cleanup."
              }
            />
          </>
        )}
      </div>
    </section>
  );
}
