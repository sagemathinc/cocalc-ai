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

  if (lite) {
    return null;
  }

  const ssh_keys = project.getIn([
    "users",
    webapp_client.account_id as string,
    "ssh_keys",
  ]);

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
        <Paragraph>
          <A href="https://doc.cocalc.com/account/ssh.html">
            <Icon name="life-ring" /> Docs...
          </A>
        </Paragraph>
      </>
    </SSHKeyList>
  );
}
