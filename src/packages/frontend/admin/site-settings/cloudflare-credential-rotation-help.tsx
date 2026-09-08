import { Button, Divider, Modal } from "antd";
import { useState } from "react";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

// Keep this runbook aligned with server/cloud/cloudflare-bootstrap.ts,
// server/project-backup/index.ts, and project-host/file-server.ts.
export default function CloudflareCredentialRotationHelp() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        style={{ whiteSpace: "normal", height: "auto" }}
      >
        How to rotate Cloudflare credentials
      </Button>
      <Modal
        title="How to rotate Cloudflare credentials"
        open={open}
        onCancel={close}
        width={800}
        styles={{
          body: {
            maxHeight: "65vh",
            overflowY: "auto",
            overflowWrap: "anywhere",
          },
        }}
        modalRender={(node) => (
          <KeyboardBoundary boundary="cloudflare-credential-rotation">
            {node}
          </KeyboardBoundary>
        )}
        footer={<Button onClick={close}>Close guide</Button>}
      >
        <p>
          This is a guide, not an automatic rotation action. Opening it does not
          change or revoke credentials.
        </p>
        <p>
          <strong>Two separate credentials:</strong> administration API tokens
          manage DNS, tunnels, Workers and buckets. R2 S3 access keys read and
          write data, including project backups. The setup wizard replaces
          administration credentials but{" "}
          <strong>preserves existing S3 keys</strong>.
        </p>
        <section aria-labelledby="cloudflare-planned-rotation">
          <h3 id="cloudflare-planned-rotation">Orderly planned rotation</h3>
          <p>
            For administration-token replacement with no known compromise. This
            does not rotate the R2 S3 keys.
          </p>
          <ol>
            <li>
              Inventory the old tokens and their consumers in Cloudflare. Mark
              the retained S3 token <strong>do not delete</strong>; match it to
              the saved <code>r2_access_key_id</code>. Do not assume an old
              token is unused just because a new one exists.
            </li>
            <li>
              Run the Cloudflare setup wizard with a new temporary bootstrap
              token. Keep the account, domain, bucket names and prefix
              unchanged. Existing S3 keys remain in use; no project-host restart
              is needed for this administration-only replacement.
            </li>
            <li>
              Confirm settings have propagated to every bay. Verify Worker
              deployment, blob upload and read, backup and restore, and a fresh
              DNS/tunnel management operation. An already-running tunnel alone
              does not test the new administration token.
            </li>
            <li>
              Observe for 24 hours, then revoke only administration tokens you
              have verified are unused, including by other sites or tools.
              <strong>
                {" "}
                Waiting is observation time, not proof of safety.
              </strong>{" "}
              Keep the retained S3 token valid.
            </li>
          </ol>
        </section>
        <Divider />
        <section aria-labelledby="cloudflare-emergency-rotation">
          <h3 id="cloudflare-emergency-rotation">Emergency rotation</h3>
          <p>
            For suspected credential compromise. Expect interrupted operations
            and downtime; do not wait 24 hours to revoke compromised
            credentials.
          </p>
          <ol>
            <li>
              Immediately revoke compromised tokens in Cloudflare, including S3
              tokens if affected. If their scope is uncertain, revoke all of
              this site's potentially exposed credentials. Keep an independent
              recovery path such as SSH or the VM provider console; Cloudflare
              management may stop working. Account tokens may also serve other
              sites.
            </li>
            <li>
              Replace the saved credentials.{" "}
              <strong>
                Bootstrap alone does not replace an existing, revoked S3 pair.
              </strong>{" "}
              For the default managed buckets, clear and save both{" "}
              <code>r2_access_key_id</code> and{" "}
              <code>r2_secret_access_key</code> in site settings, then run the
              setup wizard with a fresh bootstrap token. It creates new
              administration credentials and a new S3 pair when both fields are
              empty. For custom buckets or separately configured repositories,
              arrange replacement credentials covering those resources too. Keep
              account, buckets, repository paths and repository encryption
              passwords unchanged; credential rotation does not require copying
              or re-encrypting backups.
            </li>
            <li>
              Confirm the replacement settings reached every bay before bringing
              hosts back. Update any deployment secrets or environment overrides
              that would reinstall old values when a hub restarts. Reload any
              consumers that cache credentials; saving settings is not a
              fleet-wide acknowledgement.
            </li>
            <li>
              Reboot every affected project-host VM, including offline hosts
              before returning them to service.{" "}
              <strong>
                Yes: rebooting refreshes managed project-backup keys on the next
                operation.
              </strong>{" "}
              The new project-host process fetches current configuration from
              the hub and overwrites its local rustic profile. Restarting that
              process also clears its cache, but ensure no old rustic child jobs
              survive. Restarting only a user's project is not equivalent.
            </li>
            <li>
              Verify new blob uploads and reads, a backup and restore, Worker
              deployment and DNS/tunnel management. Reissue interrupted jobs as
              needed. Host reboot does not update static rustic TOML files,
              credentials embedded in migration/rootfs jobs, hub backup tools,
              or separately configured services. Replace those credentials and
              restart their jobs separately; do not assume automatic recovery.
            </li>
          </ol>
          <p>
            Worker blob reads use an R2 binding, not the S3 key, so a working
            image URL alone does not prove S3 recovery. Tunnel connector tokens
            are also separate from administration tokens; rotate them if
            exposed. If a machine itself may be compromised, rebooting is not
            remediation: rebuild it from a trusted image and investigate the
            incident.
          </p>
          <p>
            Provider reference:{" "}
            <a
              href="https://developers.cloudflare.com/r2/api/tokens/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cloudflare R2 authentication
            </a>
            .
          </p>
        </section>
      </Modal>
    </>
  );
}
