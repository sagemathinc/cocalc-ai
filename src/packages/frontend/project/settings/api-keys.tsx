/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback } from "react";
import { Alert } from "antd";
import ApiKeysTables from "@cocalc/frontend/components/api-keys";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { SettingBox } from "@cocalc/frontend/components";

interface Props {
  project_id: string;
  mode?: "project" | "flyout";
}

export function ApiKeys({ project_id, mode = "project" }: Props) {
  const manage = useCallback(
    async (opts) => {
      return await webapp_client.project_client.api_keys({
        ...opts,
        project_id,
      });
    },
    [project_id],
  );

  if (mode === "flyout") {
    return (
      <ApiKeysTables
        manage={manage}
        mode={mode}
        allowCreate={false}
        allowEdit={false}
        createDisabledMessage="Project-specific CoCalc API keys are disabled. Use account API keys instead."
      />
    );
  } else {
    return (
      <SettingBox title="API Keys" icon={"api"}>
        <Alert
          message="Project-specific CoCalc API keys are disabled."
          description="Use account API keys instead. Existing project-specific keys are shown only so they can be deleted."
          type="info"
          style={{ marginBottom: 16 }}
        />
        <ApiKeysTables manage={manage} allowCreate={false} allowEdit={false} />
      </SettingBox>
    );
  }
}
