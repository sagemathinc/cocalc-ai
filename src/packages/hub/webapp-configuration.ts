/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// This unifies the entire webapp configuration – endpoint /customize
// The main goal is to optimize this, to use as little DB interactions
// as necessary, use caching, etc.
// This manages the webapp's configuration based on the hostname
// (allows whitelabeling).

import { delay } from "awaiting";
import { isEmpty } from "lodash";
import LRU from "lru-cache";
import { getLogger } from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { PostgreSQL } from "@cocalc/database/postgres/types";
import { get_passport_manager, PassportManager } from "@cocalc/server/hub/auth";
import { EXTRAS as SERVER_SETTINGS_EXTRAS } from "@cocalc/util/db-schema/site-settings-extras";
import { site_settings_conf as SITE_SETTINGS_CONF } from "@cocalc/util/schema";
import type { CustomAIModelPublic } from "@cocalc/util/types/ai";
import { parseDomain, ParseResultType } from "parse-domain";
import { resolvePublicViewerDns } from "@cocalc/util/public-viewer-origin";
import getServerSettings, {
  ServerSettingsDynamic,
} from "./servers/server-settings";
import { have_active_registration_tokens } from "./utils";
import {
  getCocalcProduct,
  isLaunchpadProduct,
  isRocketProduct,
} from "@cocalc/server/launchpad/mode";
import { getLaunchpadCloudflaredStatus } from "@cocalc/server/launchpad/onprem-sshd";

const logger = getLogger("hub:webapp-config");

const CACHE = new LRU({ max: 1000, ttl: 30 * 1000 });
const WEBAPP_CONFIG_SLOW_STEP_MS = 100;

export function clear_cache(): void {
  CACHE.clear();
}

type Theme = { [key: string]: string | boolean };

interface Config {
  // todo
  configuration: any;
  registration: any;
  strategies: object;
  ollama: { [key: string]: CustomAIModelPublic };
  custom_openai: { [key: string]: CustomAIModelPublic };
}

const LAUNCHPAD_CLOUDFLARED_STATUS_TIMEOUT_MS = 250;
const VANITY_LOOKUP_TIMEOUT_MS = 250;

async function get_passport_manager_async(): Promise<PassportManager> {
  // the only issue here is, that the http server already starts up before the
  // passport manager is configured – but, the passport manager depends on the http server
  // we just retry during that initial period of uncertainty…
  let ms = 100;
  let loggedWaiting = false;
  while (true) {
    const pp_manager = get_passport_manager();
    if (pp_manager != null) {
      return pp_manager;
    } else {
      if (!loggedWaiting) {
        logger.debug("waiting for passport manager", { retry_in_ms: ms });
        loggedWaiting = true;
      }
      await delay(ms);
      ms = Math.min(10000, 1.3 * ms);
    }
  }
}

async function getLaunchpadCloudflaredStatusSafe(): Promise<
  Awaited<ReturnType<typeof getLaunchpadCloudflaredStatus>> | undefined
> {
  try {
    const status = await Promise.race([
      getLaunchpadCloudflaredStatus(),
      new Promise<undefined>((resolve) =>
        setTimeout(
          () => resolve(undefined),
          LAUNCHPAD_CLOUDFLARED_STATUS_TIMEOUT_MS,
        ),
      ),
    ]);
    if (status == null) {
      logger.warn(
        `launchpad cloudflared status lookup timed out after ${LAUNCHPAD_CLOUDFLARED_STATUS_TIMEOUT_MS}ms`,
      );
    }
    return status;
  } catch (err) {
    logger.warn(`launchpad cloudflared status lookup failed -- ${err}`);
    return undefined;
  }
}

export class WebappConfiguration {
  private readonly db: PostgreSQL;
  private data?: ServerSettingsDynamic;

  constructor({ db }) {
    this.db = db;
    void this.init().catch((err) => {
      logger.warn(`webapp configuration initialization failed -- ${err}`);
    });
  }

  private async traceSlowStep<T>(
    label: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const elapsed = Date.now() - start;
      if (elapsed >= WEBAPP_CONFIG_SLOW_STEP_MS) {
        logger.debug("slow webapp configuration step", {
          step: label,
          elapsed_ms: elapsed,
        });
      }
      return result;
    } catch (err) {
      logger.warn("webapp configuration step failed", {
        step: label,
        elapsed_ms: Date.now() - start,
        err: `${err}`,
      });
      throw err;
    }
  }

  private async init(): Promise<void> {
    const start = Date.now();
    // this.data.pub updates automatically – do not modify it!
    this.data = await getServerSettings();
    await get_passport_manager_async();
    const elapsed = Date.now() - start;
    if (elapsed >= WEBAPP_CONFIG_SLOW_STEP_MS) {
      logger.debug("webapp configuration initialized", { elapsed_ms: elapsed });
    }
  }

  // server settings with whitelabeling settings
  // TODO post-process all values
  public async settings(vID: string) {
    const { rows } = await getPool().query(
      "SELECT settings FROM whitelabeling WHERE id = $1",
      [vID],
    );
    if (this.data == null) {
      // settings not yet initialized
      return {};
    }
    const data = rows[0];
    if (data != null) {
      return { ...this.data.all, ...data.settings };
    } else {
      return this.data.all;
    }
  }

  // derive the vanity ID from the host string
  private get_vanity_id(host: string): string | undefined {
    const host_parsed = parseDomain(host);
    if (host_parsed.type === ParseResultType.Listed) {
      // vanity for vanity.cocalc.com or foo.p for foo.p.cocalc.com
      return host_parsed.subDomains.join(".");
    }
    return undefined;
  }

  private async theme(vID: string): Promise<Theme> {
    const { rows } = await getPool().query(
      "SELECT theme FROM whitelabeling WHERE id = $1",
      [vID],
    );
    const data = rows[0];
    if (data != null) {
      // post-process data, but do not set default values…
      const theme: Theme = {};
      for (const [key, value] of Object.entries(data.theme)) {
        const config = SITE_SETTINGS_CONF[key] ?? SERVER_SETTINGS_EXTRAS[key];
        if (typeof config?.to_val == "function") {
          theme[key] = config.to_val(value, data.theme);
        } else {
          if (typeof value == "string" || typeof value == "boolean") {
            theme[key] = value;
          }
        }
      }
      return theme;
    } else {
      return {};
    }
  }

  private async get_vanity(vID): Promise<object> {
    if (vID != null && vID !== "") {
      return await this.theme(vID);
    } else {
      return {};
    }
  }

  private async get_vanity_safe(vID): Promise<object> {
    if (vID == null || vID === "") {
      return {};
    }
    const timedOut = Symbol("vanity-timeout");
    try {
      const vanity = await Promise.race<object | typeof timedOut>([
        this.get_vanity(vID),
        new Promise<symbol>((resolve) =>
          setTimeout(() => resolve(timedOut), VANITY_LOOKUP_TIMEOUT_MS),
        ),
      ]);
      if (vanity === timedOut) {
        logger.warn(
          `vanity lookup timed out for '${vID}' after ${VANITY_LOOKUP_TIMEOUT_MS}ms`,
        );
        return {};
      }
      return vanity as object;
    } catch (err) {
      logger.warn(`vanity lookup failed for '${vID}' -- ${err}`);
      return {};
    }
  }

  // returns the global configuration + eventually vanity specific site config settings
  private async get_configuration({
    host,
    country,
    cloudflareRegion,
    cloudflareRegionCode,
    cloudflareCity,
    cloudflareContinent,
    cloudflareTimezone,
    cloudflareLatitude,
    cloudflareLongitude,
  }) {
    if (this.data == null) {
      // settings not yet initialized
      return {};
    }
    const vID = this.get_vanity_id(host);
    const config = this.data.pub;
    const vanity = await this.get_vanity_safe(vID);
    const cloudflareStatus = isLaunchpadProduct()
      ? await getLaunchpadCloudflaredStatusSafe()
      : undefined;
    return {
      ...config,
      ...vanity,
      ...{
        country,
        cloudflare_region: cloudflareRegion,
        cloudflare_region_code: cloudflareRegionCode,
        cloudflare_city: cloudflareCity,
        cloudflare_continent: cloudflareContinent,
        cloudflare_timezone: cloudflareTimezone,
        cloudflare_latitude: cloudflareLatitude,
        cloudflare_longitude: cloudflareLongitude,
        dns: host,
        public_viewer_dns:
          resolvePublicViewerDns({
            publicViewerDns: (config as any).public_viewer_dns,
            dns: host,
          }) ?? "",
        cocalc_product: getCocalcProduct(),
        is_launchpad: isLaunchpadProduct(),
        is_rocket: isRocketProduct(),
        launchpad_cloudflare_tunnel_status: cloudflareStatus,
      },
    };
  }

  private async get_strategies(): Promise<object> {
    const key = "strategies";
    let strategies = CACHE.get(key);
    if (strategies == null) {
      // wait until this.passport_manager is initialized.
      // this could happen right at the start of the server
      const passport_manager = await get_passport_manager_async();
      strategies = passport_manager.get_strategies_v2();
      CACHE.set(key, strategies);
    }
    return strategies as object;
  }

  // derives the public ollama model configuration from the private one
  private get_ollama_public(): { [key: string]: CustomAIModelPublic } {
    if (this.data == null) {
      throw new Error("server settings not yet initialized");
    }
    const ollama = this.data.all.ollama_configuration;
    return processCustomLLM(ollama, "Ollama");
  }

  private get_custom_openai_public(): { [key: string]: CustomAIModelPublic } {
    if (this.data == null) {
      throw new Error("server settings not yet initialized");
    }
    const custom_openai = this.data.all.custom_openai_configuration;
    return processCustomLLM(custom_openai, "OpenAI (custom)");
  }

  private async get_config({
    country,
    host,
    cloudflareRegion,
    cloudflareRegionCode,
    cloudflareCity,
    cloudflareContinent,
    cloudflareTimezone,
    cloudflareLatitude,
    cloudflareLongitude,
  }): Promise<Config> {
    let loggedWaitingForSettings = false;
    while (this.data == null) {
      if (!loggedWaitingForSettings) {
        logger.debug("waiting for server settings to initialize");
        loggedWaitingForSettings = true;
      }
      await delay(100);
    }

    const [configuration, registration, ollama, custom_openai] =
      await Promise.all([
        this.traceSlowStep("configuration", () =>
          this.get_configuration({
            host,
            country,
            cloudflareRegion,
            cloudflareRegionCode,
            cloudflareCity,
            cloudflareContinent,
            cloudflareTimezone,
            cloudflareLatitude,
            cloudflareLongitude,
          }),
        ),
        this.traceSlowStep("registration", () =>
          have_active_registration_tokens(this.db),
        ),
        this.traceSlowStep("ollama", () => this.get_ollama_public()),
        this.traceSlowStep("custom_openai", () =>
          this.get_custom_openai_public(),
        ),
      ]);
    const strategies = await this.traceSlowStep("strategies", () =>
      this.get_strategies(),
    );
    return {
      configuration,
      registration,
      strategies,
      ollama,
      custom_openai,
    };
  }

  // it returns a shallow copy, hence you can modify/add keys in the returned map!
  public async get({
    country,
    host,
    cloudflareRegion,
    cloudflareRegionCode,
    cloudflareCity,
    cloudflareContinent,
    cloudflareTimezone,
    cloudflareLatitude,
    cloudflareLongitude,
  }): Promise<Config> {
    const key = [
      "config",
      country ?? "",
      host ?? "",
      cloudflareRegionCode ?? "",
      cloudflareRegion ?? "",
      cloudflareCity ?? "",
      cloudflareContinent ?? "",
      cloudflareTimezone ?? "",
      cloudflareLatitude ?? "",
      cloudflareLongitude ?? "",
    ].join("::");
    let config = CACHE.get(key);
    if (config == null) {
      config = await this.get_config({
        country,
        host,
        cloudflareRegion,
        cloudflareRegionCode,
        cloudflareCity,
        cloudflareContinent,
        cloudflareTimezone,
        cloudflareLatitude,
        cloudflareLongitude,
      });
      CACHE.set(key, config);
    }
    return config as Config;
  }
}

// for Ollama or Custom OpenAI
function processCustomLLM(
  data: any,
  displayFallback,
): { [key: string]: CustomAIModelPublic } {
  if (isEmpty(data)) return {};

  const ret: { [key: string]: CustomAIModelPublic } = {};
  for (const key in data) {
    const conf = data[key];
    const cocalc = conf.cocalc ?? {};
    if (cocalc.disabled) continue;
    const model = conf.model ?? key;
    ret[key] = {
      model,
      display: cocalc.display ?? `${displayFallback} ${model}`,
      icon: cocalc.icon, // fallback is the Ollama or OpenAI icon, frontend does that
      desc: cocalc.desc ?? "",
    };
  }
  return ret;
}
