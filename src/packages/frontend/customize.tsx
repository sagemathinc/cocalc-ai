/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Site Customize -- dynamically customize the look and configuration
// of CoCalc for the client.

import { fromJS, List } from "immutable";
import { join } from "path";
import {
  Actions,
  rclass,
  React,
  redux,
  Redux,
  rtypes,
  Store,
  TypedMap,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { A, Loading } from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { Locale } from "@cocalc/frontend/i18n";
import { callback2, retry_until_success } from "@cocalc/util/async-utils";
import type { AIServicesAvailable } from "@cocalc/util/db-schema/ai-models";
import type { SignupEmailDomainPublicPolicy } from "@cocalc/util/accounts/signup-email-domain-policy";
import {
  Config,
  PLATFORM_MODE_CLOUD,
  PLATFORM_MODE_SINGLE_NODE,
  PLATFORM_MODE_VALID_VALS,
  site_settings_conf,
} from "@cocalc/util/db-schema/site-defaults";
import { deep_copy, dict } from "@cocalc/util/misc";
import * as theme from "@cocalc/util/theme";
import type { CustomAIModelPublic } from "@cocalc/util/types/ai";
import { DefaultQuotaSetting, Upgrades } from "@cocalc/util/upgrades/quota";
export { TermsOfService } from "@cocalc/frontend/customize/terms-of-service";
import { delay } from "awaiting";
import { init as initLite } from "./lite";

// update every 2 minutes.
const UPDATE_INTERVAL = 2 * 60000;

// Normalize the persisted legacy kucalc setting into the product-facing
// platform mode used by frontend code.
function validatePlatformMode(k?): string {
  if (k == null) return PLATFORM_MODE_SINGLE_NODE;
  const val = k.trim().toLowerCase();
  if ((PLATFORM_MODE_VALID_VALS as readonly string[]).includes(val)) {
    return val;
  }
  console.warn(`site settings customize: invalid platform mode value ${k}`);
  return PLATFORM_MODE_SINGLE_NODE;
}

// populate all default key/values in the "customize" store
const defaultKeyVals: [string, string | string[]][] = [];
for (const k in site_settings_conf) {
  const v: Config = site_settings_conf[k];
  const value: any =
    typeof v.to_val === "function" ? v.to_val(v.default) : v.default;
  defaultKeyVals.push([k, value]);
}
const defaults: any = dict(defaultKeyVals);
defaults.is_commercial = defaults.commercial;
defaults.stripe_enabled = false;
defaults.platform_mode = defaults.kucalc;
defaults._is_configured = false; // will be true after set via call to server
defaults.ssh_remote_target = "";
defaults.ssh_remote_url = "";
defaults.signup_email_domain_public_policy = { mode: "allow_all" };

// CustomizeState is maybe extension of what's in SiteSettings
// so maybe there is a more clever way like this to do it than
// what I did below.
// type SiteSettings = { [k in keyof SiteSettingsConfig]: any  };

export interface CustomizeState {
  time: number; // this will always get set once customize has loaded.
  is_commercial: boolean;
  stripe_enabled: boolean;
  ssh_remote_target?: string;
  ssh_remote_url?: string;

  openai_enabled: boolean;
  agent_openai_codex_enabled: boolean;
  browser_raw_exec_policy?: string;
  google_vertexai_enabled: boolean;
  mistral_enabled: boolean;
  anthropic_enabled: boolean;
  ollama_enabled: boolean;
  custom_openai_enabled: boolean;
  datastore: boolean;
  account_creation_email_instructions: string;
  sign_in_email_instructions: string;
  signup_email_domain_public_policy?: SignupEmailDomainPublicPolicy;
  commercial: boolean;
  default_quotas: TypedMap<DefaultQuotaSetting>;
  dns: string; // e.g. "cocalc.com"
  public_viewer_dns?: string;
  email_enabled: false;
  email_signup: boolean;
  public_signup_without_registration_token: boolean;
  cookie_banner_enabled?: boolean;
  cookie_banner_text?: string;
  google_analytics: string;
  help_email: string;
  zendesk?: boolean;
  iframe_comm_hosts: string[];
  index_info_html: string;
  is_cocalc_com: boolean;
  is_personal: boolean;
  platform_mode: string;
  kucalc: string;
  logo_rectangular: string;
  logo_square: string;
  max_upgrades: TypedMap<Partial<Upgrades>>;

  onprem_quota_heading: string;
  organization_email: string;
  organization_name: string;
  organization_url: string;
  policy_pages: string;
  legacy_migration_enabled?: boolean;
  legacy_migration_page_message?: string;
  share_server: boolean;
  site_description: string;
  site_name: string;
  splash_image: string;
  terms_of_service: string;
  terms_of_service_url: string;
  theming: boolean;
  verify_emails: false;
  launchpad_mode?: string;
  version_min_browser: number;
  version_recommended_browser: number;
  versions: string;
  cocalc_product?: string;
  is_launchpad?: boolean;
  is_rocket?: boolean;
  launchpad_cloudflare_tunnel_status?: {
    enabled: boolean;
    running: boolean;
    hostname?: string;
    error?: string | null;
  };
  // extra setting, injected by the hub, not the DB
  // we expect this to follow "ISO 3166-1 Alpha 2" + K1 (Tor network) + XX (unknown)
  // use a lib like https://github.com/michaelwittig/node-i18n-iso-countries
  country: string;
  cloudflare_region?: string;
  cloudflare_region_code?: string;
  cloudflare_city?: string;
  cloudflare_continent?: string;
  cloudflare_timezone?: string;
  cloudflare_latitude?: string;
  cloudflare_longitude?: string;
  _is_configured: boolean;
  project_hosts_nebius_enabled?: boolean;
  project_hosts_self_host_alpha_enabled?: boolean;
  launcher_default_quick_create?: List<string>;
  project_rootfs_default_image?: string;
  project_rootfs_default_image_gpu?: string;
  project_rootfs_prepull_images?: string;
  rootfs_scan_enabled?: boolean;
  "project_hosts_google-cloud_enabled"?: boolean;
  project_hosts_gcp_surcharge_percent?: number;
  project_hosts_hyperstack_enabled?: boolean;
  project_hosts_lambda_enabled?: boolean;
  project_hosts_nebius_surcharge_percent?: number;

  ollama?: TypedMap<{ [key: string]: TypedMap<CustomAIModelPublic> }>;
  custom_openai?: TypedMap<{ [key: string]: TypedMap<CustomAIModelPublic> }>;

  i18n?: List<Locale>;

  lite?: boolean;
  account_id?: string;
  project_id?: string;
}

export class CustomizeStore extends Store<CustomizeState> {
  async until_configured(): Promise<void> {
    if (this.get("_is_configured")) return;
    await callback2(this.wait, { until: () => this.get("_is_configured") });
  }

  get_iframe_comm_hosts(): string[] {
    const hosts = this.get("iframe_comm_hosts");
    if (hosts == null) return [];
    return hosts.toJS();
  }

  getEnabledAIServices(): AIServicesAvailable {
    return {
      openai: this.get("openai_enabled"),
      google: this.get("google_vertexai_enabled"),
      ollama: this.get("ollama_enabled"),
      custom_openai: this.get("custom_openai_enabled"),
      mistralai: this.get("mistral_enabled"),
      anthropic: this.get("anthropic_enabled"),
      user: false,
    };
  }
}

export class CustomizeActions extends Actions<CustomizeState> {
  reload = async () => {
    await loadCustomizeState();
  };
}

export const store = redux.createStore("customize", CustomizeStore, defaults);
const actions = redux.createActions("customize", CustomizeActions);
// Legacy compatibility value; modern billing UI should use stripe_enabled or
// entitlement state instead.
actions.setState({ is_commercial: true });

// If we are running in the browser, then we customize the schema.  This also gets run on the backend
// to generate static content, which can't be customized.
export let commercial: boolean = defaults.is_commercial;

async function loadCustomizeState() {
  if (typeof process != "undefined") {
    // running in node.js
    return;
  }
  let customize;
  await retry_until_success({
    f: async () => {
      const url = join(appBasePath, "customize");
      try {
        customize = await (await fetch(url)).json();
      } catch (err) {
        const msg = `fetch /customize failed -- retrying - ${err}`;
        console.warn(msg);
        throw new Error(msg);
      }
    },
    start_delay: 2000,
    max_delay: 30000,
  });

  const {
    configuration,
    registration,
    strategies,
    ollama = null, // the derived public information
    custom_openai = null,
  } = customize;
  processLite(configuration);
  processPlatformMode(configuration);
  process_customize(configuration); // this sets _is_configured to true
  process_ollama(ollama);
  process_custom_openai(custom_openai);
  const actions = redux.getActions("account");
  // Which account creation strategies we support.
  actions.setState({ strategies });
  // Set whether or not a registration token is required when creating account.
  actions.setState({ token: !!registration });
}

export async function init() {
  while (true) {
    await loadCustomizeState();
    await delay(UPDATE_INTERVAL);
  }
}

function process_ollama(ollama?) {
  if (!ollama) return;
  actions.setState({ ollama: fromJS(ollama) });
}

function process_custom_openai(custom_openai?) {
  if (!custom_openai) return;
  actions.setState({ custom_openai: fromJS(custom_openai) });
}

function processPlatformMode(obj) {
  // TODO make this a to_val function in site_settings_conf.kucalc when the
  // persisted setting key is migrated.
  obj.platform_mode = validatePlatformMode(obj.platform_mode ?? obj.kucalc);
  // Compatibility alias for old code while frontend call sites migrate.
  obj.kucalc = obj.platform_mode;
  obj.is_cocalc_com = obj.platform_mode == PLATFORM_MODE_CLOUD;
}

function process_customize(obj) {
  const obj_orig = deep_copy(obj);
  for (const k in site_settings_conf) {
    const v = site_settings_conf[k];
    obj[k] =
      obj[k] != null ? obj[k] : (v.to_val?.(v.default, obj_orig) ?? v.default);
  }
  // always set time, so other code can know for sure that customize was loaded.
  // it also might be helpful to know when
  obj["time"] = Date.now();
  set_customize(obj);
}

// "obj" are the already processed values from the database
// this function is also used by hub-landing!
function set_customize(obj) {
  // console.log('set_customize obj=\n', JSON.stringify(obj, null, 2));

  // set some special cases, backwards compatibility
  commercial = obj.is_commercial = obj.commercial;

  obj._is_configured = true;
  actions.setState(obj);
}

interface HelpEmailLink {
  text?: React.ReactNode;
  color?: string;
}

export const HelpEmailLink: React.FC<HelpEmailLink> = React.memo(
  (props: HelpEmailLink) => {
    const { text, color } = props;

    const help_email = useTypedRedux("customize", "help_email");
    const _is_configured = useTypedRedux("customize", "_is_configured");

    const style: React.CSSProperties = {};
    if (color != null) {
      style.color = color;
    }

    if (_is_configured) {
      if (help_email?.length > 0) {
        return (
          <A href={`mailto:${help_email}`} style={style}>
            {text ?? help_email}
          </A>
        );
      } else {
        return (
          <span>
            <em>
              {"["}not configured{"]"}
            </em>
          </span>
        );
      }
    } else {
      return <Loading style={{ display: "inline" }} />;
    }
  },
);

export const SiteName: React.FC = React.memo(() => {
  const site_name = useTypedRedux("customize", "site_name");

  if (site_name != null) {
    return <span>{site_name}</span>;
  } else {
    return <Loading style={{ display: "inline" }} />;
  }
});

interface SiteDescriptionProps {
  style?: React.CSSProperties;
  site_description?: string;
}

const SiteDescription0 = rclass<{ style?: React.CSSProperties }>(
  class SiteDescription extends React.Component<SiteDescriptionProps> {
    public static reduxProps() {
      return {
        customize: {
          site_description: rtypes.string,
        },
      };
    }

    public render(): React.JSX.Element {
      const style =
        this.props.style != undefined
          ? this.props.style
          : { color: "#666", fontSize: "16px" };
      if (this.props.site_description != undefined) {
        return <span style={style}>{this.props.site_description}</span>;
      } else {
        return <Loading style={{ display: "inline" }} />;
      }
    }
  },
);

// TODO: not used?
export function SiteDescription({ style }: { style?: React.CSSProperties }) {
  return (
    <Redux>
      <SiteDescription0 style={style} />
    </Redux>
  );
}

// This generalizes the above in order to pick any selected string value
interface CustomizeStringProps {
  name: string;
}
interface CustomizeStringReduxProps {
  site_name: string;
  site_description: string;
  terms_of_service: string;
  account_creation_email_instructions: string;
  sign_in_email_instructions: string;
  help_email: string;
  logo_square: string;
  logo_rectangular: string;
  splash_image: string;
  index_info_html: string;
  terms_of_service_url: string;
  organization_name: string;
  organization_email: string;
  organization_url: string;
  google_analytics: string;
}

const CustomizeStringElement = rclass<CustomizeStringProps>(
  class CustomizeStringComponent extends React.Component<
    CustomizeStringReduxProps & CustomizeStringProps
  > {
    public static reduxProps = () => {
      return {
        customize: {
          site_name: rtypes.string,
          site_description: rtypes.string,
          terms_of_service: rtypes.string,
          account_creation_email_instructions: rtypes.string,
          sign_in_email_instructions: rtypes.string,
          help_email: rtypes.string,
          logo_square: rtypes.string,
          logo_rectangular: rtypes.string,
          splash_image: rtypes.string,
          index_info_html: rtypes.string,
          terms_of_service_url: rtypes.string,
          organization_name: rtypes.string,
          organization_email: rtypes.string,
          organization_url: rtypes.string,
          google_analytics: rtypes.string,
        },
      };
    };

    shouldComponentUpdate(next) {
      if (this.props[this.props.name] == null) return true;
      return this.props[this.props.name] != next[this.props.name];
    }

    render() {
      return <span>{this.props[this.props.name]}</span>;
    }
  },
);

// TODO: not used?
export function CustomizeString({ name }: CustomizeStringProps) {
  return (
    <Redux>
      <CustomizeStringElement name={name} />
    </Redux>
  );
}

// TODO also make this configurable?
export const CompanyName = function CompanyName() {
  return <span>{theme.COMPANY_NAME}</span>;
};

interface AccountCreationEmailInstructionsProps {
  account_creation_email_instructions: string;
}

const AccountCreationEmailInstructions0 = rclass<{}>(
  class AccountCreationEmailInstructions extends React.Component<AccountCreationEmailInstructionsProps> {
    public static reduxProps = () => {
      return {
        customize: {
          account_creation_email_instructions: rtypes.string,
        },
      };
    };

    render() {
      return (
        <h3 style={{ marginTop: 0, textAlign: "center" }}>
          {this.props.account_creation_email_instructions}
        </h3>
      );
    }
  },
);

// TODO is this used?
export function AccountCreationEmailInstructions() {
  return (
    <Redux>
      <AccountCreationEmailInstructions0 />
    </Redux>
  );
}

export const PolicyPricingPageUrl = join(appBasePath, "pricing");

let liteInitialized = false;
function processLite(configuration) {
  if (!configuration.lite || liteInitialized) {
    return;
  }
  liteInitialized = true;
  initLite(redux, configuration);
}
