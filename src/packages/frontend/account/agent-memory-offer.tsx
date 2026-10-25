/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A one-time offer to turn on agent memory, shown above the composer of
// agent threads while memory is off. "Not now" asks again after two weeks;
// "Don't ask again" never asks. The choice is an account setting, so it
// follows the person across browsers. Turning memory on goes through the same
// consent dialog (with the full disclosure) as Settings > AI.

import { Alert, Button, Space } from "antd";
import { useState } from "react";
import { redux, useAccountOtherSetting } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import { lite } from "@cocalc/frontend/lite";
import {
  confirmEnableAgentMemory,
  useAgentMemoryStatus,
} from "./agent-memory-settings";
import { personalAgentApi } from "@cocalc/frontend/agents/api";

export const AGENT_MEMORY_OFFER_SETTING = "agent_memory_offer";
export const AGENT_MEMORY_OFFER_NEVER = "never";
export const AGENT_MEMORY_OFFER_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** Whether the person declined the offer: for good, or until a later time. */
export function agentMemoryOfferDeclined(
  value: unknown,
  now = Date.now(),
): boolean {
  if (value === AGENT_MEMORY_OFFER_NEVER) return true;
  if (typeof value !== "string") return false;
  const until = Date.parse(value);
  return Number.isFinite(until) && until > now;
}

function setOfferChoice(value: string): void {
  redux
    .getActions("account")
    ?.set_other_settings(AGENT_MEMORY_OFFER_SETTING, value);
}

export function AgentMemoryOffer() {
  const choice = useAccountOtherSetting<string>(AGENT_MEMORY_OFFER_SETTING);
  // Memory is not available in CoCalc Lite; a declined offer costs no
  // request at all.
  if (lite || agentMemoryOfferDeclined(choice)) return null;
  return <AgentMemoryOfferCard />;
}

function AgentMemoryOfferCard() {
  const { status, error } = useAgentMemoryStatus();
  const [failure, setFailure] = useState("");
  // Only once the account's memory is known to be off (an error, for example
  // an older hub, shows nothing).
  if (!status || error || status.enabled) return null;
  const turnOn = () =>
    void confirmEnableAgentMemory(async () => {
      try {
        setFailure("");
        await personalAgentApi().manageAgentMemory({
          op: "set-enabled",
          enabled: true,
        });
      } catch (err) {
        setFailure(`${err}`);
        throw err;
      }
    });
  return (
    <Alert
      type="info"
      showIcon
      icon={<Icon name="database" />}
      style={{ margin: "0 8px 8px" }}
      title="Let your agents remember what matters"
      description={
        <>
          With agent memory on, Claude and Codex keep short notes across
          sessions: your preferences and corrections, project conventions, how
          to build and test. You can review or delete notes at any time.
          {failure && (
            // Its own alert (a live region), shown once the dialog closed.
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 8 }}
              title={`Agent memory was not turned on: ${failure}`}
            />
          )}
        </>
      }
      action={
        <Space orientation="vertical" size={4}>
          <Button size="small" type="primary" onClick={turnOn}>
            Turn on…
          </Button>
          <Button
            size="small"
            onClick={() =>
              setOfferChoice(
                new Date(
                  Date.now() + AGENT_MEMORY_OFFER_SNOOZE_MS,
                ).toISOString(),
              )
            }
          >
            Not now
          </Button>
          <Button
            size="small"
            type="text"
            onClick={() => setOfferChoice(AGENT_MEMORY_OFFER_NEVER)}
          >
            Don't ask again
          </Button>
        </Space>
      }
    />
  );
}
