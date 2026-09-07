/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { FormattedMessage, useIntl } from "react-intl";

import { useRedux } from "@cocalc/frontend/app-framework";
import { Paragraph, Text } from "@cocalc/frontend/components";
import { DocsLink } from "@cocalc/frontend/docs/link";
import { labels } from "@cocalc/frontend/i18n";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

import SSHKeyList from "./ssh-key-list";

export default function GlobalSSHKeys() {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectsLabel = intl.formatMessage(labels.projects);
  const projectLabelLower = projectLabel.toLowerCase();
  const projectsLabelLower = projectsLabel.toLowerCase();
  const ssh_keys = useRedux("account", "ssh_keys");

  return (
    <div style={{ marginTop: "1em" }}>
      <SSHKeyList
        help={
          <Paragraph>
            <FormattedMessage
              id="account.global-ssh-keys.help"
              defaultMessage={`To connect, open the target {projectLabel}'s
          SSH settings and use the CoCalc CLI command shown there. The CLI
          writes the correct managed route to your SSH config. For SSH between
          {projectsLabel}, use the project-to-project setup in the target
          {projectLabel}'s SSH settings.`}
              values={{
                projectLabel: projectLabelLower,
                projectsLabel: projectsLabelLower,
              }}
            />
          </Paragraph>
        }
        ssh_keys={ssh_keys}
      >
        <Paragraph style={{ color: UI_COLORS.secondary }}>
          <FormattedMessage
            id="account.global-ssh-keys.info"
            defaultMessage={`The SSH keys listed here allow you to connect via SSH
            to <strong><i>all {projectsLabel}</i></strong> on which you are a collaborator.
            Alternatively, set SSH keys that grant access only to a {projectLabel} in the settings for that {projectLabel}.
            See <A>the docs</A>
            or the SSH part of the settings page in a {projectLabel} for further instructions.
            Adding keys here simply automates them being added to the file ~/.ssh/authorized_keys`}
            values={{
              projectLabel: projectLabelLower,
              projectsLabel: projectsLabelLower,
              strong: (c) => <Text strong>{c}</Text>,
              i: (c) => <i>{c}</i>,
              A: (c) => (
                <DocsLink
                  href="/docs/terminal/ssh-access"
                  slug="terminal/ssh-access"
                >
                  {c}
                </DocsLink>
              ),
            }}
          />
        </Paragraph>
      </SSHKeyList>
    </div>
  );
}
