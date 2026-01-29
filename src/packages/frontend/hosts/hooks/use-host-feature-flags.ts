import { useRedux, useStore } from "@cocalc/frontend/app-framework";
import { getProviderEnablement } from "../providers/registry";

export const useHostFeatureFlags = () => {
  // Feature flags are stored on the customize Store itself; useStore("customize")
  // (not useRedux(["customize"])) or flags will be undefined.
  const customize = useStore("customize");
  const isAdmin = !!useRedux(["account", "is_admin"]);
  const showLocal =
    isAdmin &&
    typeof window !== "undefined" &&
    window.location.hostname === "localhost";
  return getProviderEnablement({ customize, showLocal });
};
