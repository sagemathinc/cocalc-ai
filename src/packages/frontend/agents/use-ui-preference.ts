import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { agentMessagingUIEnabled } from "./ui-preference";

export function useAgentMessagingUI(): boolean {
  return agentMessagingUIEnabled(useTypedRedux("account", "other_settings"));
}
