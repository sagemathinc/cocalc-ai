import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { myAgentsUIEnabled } from "./workspace-ui-preference";

export function useMyAgentsUI(): boolean {
  return myAgentsUIEnabled(useTypedRedux("account", "other_settings"));
}
