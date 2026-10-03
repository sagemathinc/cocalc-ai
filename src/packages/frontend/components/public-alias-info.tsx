/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Popover } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import type { PersonalUrlKind } from "@cocalc/util/personal-urls";

// Aliases other than people's are public names: say exactly what that means.
export function PublicAliasInfo({ kind }: { kind: PersonalUrlKind }) {
  const what =
    kind === "projects"
      ? "project"
      : kind === "agents"
        ? "agent"
        : kind === "artifacts"
          ? "artifact"
          : "conversation";
  return (
    <Popover
      trigger={["hover", "click"]}
      title="Aliases are public names"
      content={
        <div style={{ maxWidth: 340 }}>
          <p>
            An alias makes a readable link like{" "}
            <code>/u/your-username/{kind}/alias</code> that you can share
            anywhere.
          </p>
          <p>
            Anyone who knows your username and the alias can find out which{" "}
            {what} it points to, including its project id. It does not give them
            access: they can only open it if they are already a collaborator on
            that project.
          </p>
          <p style={{ marginBottom: 0 }}>
            Don't put anything secret in an alias, and don't rely on a project
            id staying secret.
          </p>
        </div>
      }
    >
      <button
        type="button"
        aria-label="About public aliases"
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "help",
          color: "inherit",
        }}
      >
        <Icon name="info-circle" />
      </button>
    </Popover>
  );
}
