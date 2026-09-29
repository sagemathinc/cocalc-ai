import { redux } from "@cocalc/frontend/app-framework";
import type { PageState } from "@cocalc/frontend/app/store";
import { parsePersonalUrl } from "@cocalc/util/personal-urls";
import type { ResolvedPersonalUrl } from "@cocalc/util/personal-urls";
import {
  cancelPersonalUrlNavigation,
  personalUrlNavigationIsCurrent,
  watchPersonalUrlNavigation,
  onPersonalUrlOwnerChange,
} from "./personal-url-state";

const emptySelection = {
  active_agent_id: undefined,
  active_agent_name: undefined,
  library_open: false,
  library_project_id: undefined,
  library_entry_id: undefined,
  collaborators_open: false,
  collaborators_view: undefined,
  collaborators_project_id: undefined,
  collaborators_project_ids: undefined,
  collaborators_person_id: undefined,
  collaborators_contact_id: undefined,
  collaborators_invitation_id: undefined,
  collaborators_resource_kind: undefined,
  collaborators_resource_id: undefined,
  collaborators_alias: undefined,
  collaborators_alias_kind: undefined,
  collaborators_alias_owner: undefined,
  collaborators_route_error: undefined,
};

/** Only canonical, viewer-authorized IDs reach the existing workspace views. */
export function personalUrlSelection(
  result: ResolvedPersonalUrl,
  viewer: string,
): Partial<PageState> {
  const target = result.target;
  if (result.status !== "resolved" || !target)
    throw Error("Personal URL did not resolve to authorized content");
  switch (target.kind) {
    case "agent":
      return result.owner.account_id === viewer
        ? { active_agent_id: target.agent_id }
        : {
            collaborators_open: true,
            collaborators_view: "conversations",
            collaborators_project_id: target.project_id,
            collaborators_resource_kind: "agent",
            collaborators_resource_id: target.agent_id,
          };
    case "artifact":
      return {
        library_open: true,
        library_project_id: target.project_id,
        library_entry_id: target.entry_id,
      };
    case "conversation":
      return {
        collaborators_open: true,
        collaborators_view: "conversations",
        collaborators_project_id: target.project_id,
        collaborators_resource_kind: target.resource_kind,
        collaborators_resource_id: target.resource_id,
      };
    case "person":
      return {
        collaborators_open: true,
        collaborators_view: "people",
        collaborators_person_id: target.person_id,
      };
  }
}

/** Reauthorize the same owner's URL, not the new viewer's similarly named alias. */
export async function resolvePersonalUrl(
  input: string,
  preserveSelection = false,
): Promise<void> {
  let url = input.replace(/^\//, "");
  let ownerAccountId: string | undefined;
  const revision = cancelPersonalUrlNavigation();
  const account = redux.getStore("account");
  const viewer = account?.get("account_id");
  const accountSignedIn = !!account?.get("is_logged_in");
  let signedIn: boolean | undefined;
  let webappClient: typeof import("./webapp-client").webapp_client | undefined;
  let client:
    | typeof import("./webapp-client").webapp_client.conat_client
    | undefined;
  const page = redux.getActions("page");
  const current = () =>
    personalUrlNavigationIsCurrent(revision) &&
    account?.get("account_id") === viewer &&
    (!webappClient ||
      ((!!account?.get("is_logged_in") || webappClient.is_signed_in()) ===
        signedIn &&
        webappClient.conat_client === client)) &&
    redux.getStore("page")?.get("personal_url") === url;
  page.setState({
    ...(preserveSelection ? {} : emptySelection),
    personal_url: url,
    personal_url_viewer: viewer,
    personal_url_owner_account_id: undefined,
    personal_url_project_id: undefined,
    personal_url_status: preserveSelection ? "resolved" : "loading",
    personal_url_error: undefined,
  });
  const accountChanged = () => {
    if (!personalUrlNavigationIsCurrent(revision)) return;
    if (redux.getStore("page")?.get("personal_url") !== url) return;
    if (
      account?.get("account_id") === viewer &&
      (webappClient
        ? (!!account?.get("is_logged_in") || webappClient.is_signed_in()) ===
            signedIn && webappClient.conat_client === client
        : !!account?.get("is_logged_in") === accountSignedIn)
    )
      return;
    void resolvePersonalUrl(url);
  };
  account?.on?.("change", accountChanged);
  const stopWatchingOwner = onPersonalUrlOwnerChange((changed) => {
    if (ownerAccountId === changed && current())
      void resolvePersonalUrl(url, true);
  });
  watchPersonalUrlNavigation(() => {
    account?.removeListener?.("change", accountChanged);
    stopWatchingOwner();
  });
  if (!viewer) return;
  try {
    parsePersonalUrl(url);
    // Page actions import navigation helpers during Redux initialization. Load
    // the client only for a request, never as a side effect of importing them.
    const { webapp_client } = await import("./webapp-client");
    if (!current()) return;
    webappClient = webapp_client;
    client = webappClient.conat_client;
    signedIn = !!account?.get("is_logged_in") || webappClient.is_signed_in();
    if (!signedIn) return;
    const result = await client.hub.personalUrls.resolveUrl({ url: `/${url}` });
    if (!current()) return;
    if (result.status === "access-denied") {
      page.setState({
        ...emptySelection,
        personal_url_status: "error",
        personal_url_project_id: result.project_id,
        personal_url_error:
          "Your account does not have access to this project.",
      });
      return;
    }
    if (result.status !== "resolved") throw Error("Personal alias unavailable");
    const { replace_url } = await import("./history");
    if (!current()) return;
    const selection = personalUrlSelection(result, viewer);
    ownerAccountId = result.owner.account_id;
    parsePersonalUrl(result.canonical_path);
    url = result.canonical_path.replace(/^\//, "");
    page.setState({
      ...(preserveSelection ? {} : emptySelection),
      ...selection,
      personal_url: url,
      personal_url_status: "resolved",
      personal_url_viewer: viewer,
      personal_url_owner_account_id: result.owner.account_id,
      personal_url_project_id: undefined,
      personal_url_error: undefined,
    });
    replace_url(`/${url}`);
  } catch {
    if (!current()) return;
    page.setState({
      ...emptySelection,
      personal_url_status: "error",
      personal_url_error:
        "This personal alias is unavailable, or your account does not have access.",
    });
  }
}
