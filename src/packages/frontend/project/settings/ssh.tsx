/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Typography } from "antd";
import { useIntl } from "react-intl";
import SSHKeyList from "@cocalc/frontend/account/ssh-keys/ssh-key-list";
import { redux } from "@cocalc/frontend/app-framework";
import { A, Icon } from "@cocalc/frontend/components";
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
  const hostName = hostInfo?.get?.("name");
  const localProxy = !!hostInfo?.get?.("local_proxy");

  if (lite) {
    return null;
  }

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
            <p>
              {localProxy
                ? `SSH target (via hub${hostName ? ` · ${hostName}` : ""}):`
                : `SSH target${hostName ? ` (${hostName})` : ""}:`}
            </p>
            <Paragraph>
              <Text code>{sshCommand}</Text>
            </Paragraph>
            {localProxy && (
              <Paragraph type="secondary">
                This SSH target routes through the hub’s reverse tunnel.
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
