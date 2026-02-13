/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Tooltip, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import SSHKeyList from "@cocalc/frontend/account/ssh-keys/ssh-key-list";
import { redux } from "@cocalc/frontend/app-framework";
import { A, Icon } from "@cocalc/frontend/components";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { Project } from "./types";
import { lite } from "@cocalc/frontend/lite";

const { Text, Paragraph } = Typography;

interface Props {
  project: Project;
  account_id?: string;
  mode?: "project" | "flyout";
}

export function SSHPanel({ project, mode = "project" }: Props) {
  const intl = useIntl();
  const projectLabelLower = intl.formatMessage(labels.project).toLowerCase();
  const hostInfo = useHostInfo(project.get("host_id"));
  const projectId = project.get("project_id") as string;
  const sshServer = hostInfo?.get?.("ssh_server");
  const localProxy = !!hostInfo?.get?.("local_proxy");
  const [sshCopied, setSshCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  const ssh_keys = project.getIn([
    "users",
    webapp_client.account_id as string,
    "ssh_keys",
  ]);
  const sshInfo = (() => {
    if (typeof sshServer !== "string") return null;
    const trimmed = sshServer.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[")) {
      const match = trimmed.match(/^\[(.*)\]:(\d+)$/);
      if (match) {
        return { host: match[1], port: match[2] };
      }
      return { host: trimmed };
    }
    const match = trimmed.match(/^(.*):(\d+)$/);
    if (match) {
      return { host: match[1], port: match[2] };
    }
    return { host: trimmed };
  })();
  const sshCommand =
    sshInfo && sshInfo.host
      ? sshInfo.port
        ? `ssh -p ${sshInfo.port} ${projectId}@${sshInfo.host}`
        : `ssh ${projectId}@${sshInfo.host}`
      : null;

  useEffect(() => {
    setSshCopied(false);
    if (copyTimeoutRef.current != null) {
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, [sshCommand]);

  if (lite) {
    return null;
  }

  const handleCopy = () => {
    setSshCopied(true);
    if (copyTimeoutRef.current != null) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setSshCopied(false);
      copyTimeoutRef.current = null;
    }, 1200);
  };

  return (
    <SSHKeyList
      ssh_keys={ssh_keys}
      project_id={project.get("project_id")}
      mode={mode}
    >
      <>
        <p>
          To SSH to your {projectLabelLower} add your public key below, or{" "}
          <Button
            type="link"
            onClick={() => {
              redux
                .getProjectActions(project.get("project_id"))
                .open_file({ path: ".ssh/authorized_keys" });
            }}
          >
            add your key to ~/.ssh/authorized_keys
          </Button>
        </p>
        <p>
          The {projectLabelLower} <Text strong>must be running</Text> in order
          to connect via ssh. It is not necessary to restart the{" "}
          {projectLabelLower} after you add or remove a key.
        </p>
        {sshCommand && (
          <>
            <p>{localProxy ? "SSH target (via hub):" : "SSH target:"}</p>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
                marginBottom: 4,
              }}
            >
              <CopyButton value={sshCommand} size="small" />
              <CopyToClipboard text={sshCommand} onCopy={handleCopy}>
                <Tooltip title="Copied!" open={sshCopied}>
                  <Text
                    code
                    style={{
                      fontSize: "13pt",
                      padding: "6px 8px",
                      flex: 1,
                      wordBreak: "break-all",
                      cursor: "pointer",
                    }}
                  >
                    {sshCommand}
                  </Text>
                </Tooltip>
              </CopyToClipboard>
            </div>
            {localProxy && (
              <Paragraph type="secondary" style={{ marginTop: 0 }}>
                This SSH target routes through the hub’s reverse tunnel. Ensure
                you can reach the hub host and port from your machine.
              </Paragraph>
            )}
          </>
        )}
        <Paragraph>
          <A href="https://doc.cocalc.com/account/ssh.html">
            <Icon name="life-ring" /> Docs...
          </A>
        </Paragraph>
      </>
    </SSHKeyList>
  );
}
