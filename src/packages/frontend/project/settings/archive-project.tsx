/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { InboxOutlined } from "@ant-design/icons";
import { Button, Popconfirm } from "antd";
import type { ButtonProps } from "antd";
import { FormattedMessage, useIntl } from "react-intl";
import { useActions } from "@cocalc/frontend/app-framework";
import { labels } from "@cocalc/frontend/i18n";
import { CancelText } from "@cocalc/frontend/i18n/components";

interface Props {
  project_id: string;
  disabled?: boolean;
  size?: ButtonProps["size"];
}

export function ArchiveProject({ project_id, disabled, size }: Props) {
  const actions = useActions("projects");
  const intl = useIntl();
  const projectLabelLower = intl.formatMessage(labels.project).toLowerCase();

  const explanation = (
    <div style={{ maxWidth: "320px" }}>
      <FormattedMessage
        id="project.settings.archive-project.explanation"
        defaultMessage="Archiving removes the active copy of this {projectLabelLower} from the project host. If the latest backup is older than the latest edits, CoCalc will stop the {projectLabelLower}, create a final backup, then archive it. Starting it again later will restore it from backup, which takes longer, but archived {projectLabelLower}s do not count toward active storage usage."
        values={{ projectLabelLower }}
      />
    </div>
  );

  return (
    <Popconfirm
      placement="bottom"
      arrow={{ pointAtCenter: true }}
      title={explanation}
      icon={<InboxOutlined />}
      onConfirm={() => actions?.archive_project(project_id)}
      okText={
        <FormattedMessage
          id="project.settings.archive-project.ok"
          defaultMessage="Archive {projectLabelLower}"
          values={{ projectLabelLower }}
        />
      }
      cancelText={<CancelText />}
    >
      <Button disabled={disabled || actions == null} size={size}>
        <InboxOutlined />{" "}
        <FormattedMessage
          id="project.settings.archive-project.label"
          defaultMessage="Archive"
        />
      </Button>
    </Popconfirm>
  );
}
