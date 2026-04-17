/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import $ from "jquery";
import { throttle } from "lodash";
import { delay } from "awaiting";
import { redux } from "../app-framework";
import { IS_TOUCH } from "../feature";
import type { WebappClient } from "./client";
import { lite } from "@cocalc/frontend/lite";

const CHECK_INTERVAL = 30 * 1000;
const SOFT_STANDBY_WARNING_DELAY_MS = CHECK_INTERVAL / 2;
const HARD_STANDBY_DELAY_MS = 5 * 60 * 1000;
//const CHECK_INTERVAL = 7 * 1000;
type IdleStandbyStage = "active" | "soft" | "hard";

export class IdleClient {
  private notification_is_visible: boolean = false;
  private client: WebappClient;
  private idle_timeout: number = 30 * 60 * 1000; // default -- 30 minutes
  private idle_time: number = 0;
  private delayedSoftStandby?;
  private delayedHardStandby?;
  private standbyStage: IdleStandbyStage = "active";

  constructor(client: WebappClient) {
    this.client = client;
    this.init_idle();
  }

  inStandby = () => {
    return this.standbyStage !== "active";
  };

  reset = (): void => {};

  private init_idle = async (): Promise<void> => {
    // Do not bother on touch devices, since they already automatically tend to
    // disconnect themselves very aggressively to save battery life, and it's
    // sketchy trying to ensure that banner will dismiss properly.
    if (IS_TOUCH || lite) {
      // never use idle timeout on touch devices (phones) or in lite mode
      return;
    }

    // Wait a little before setting this stuff up.
    await delay(CHECK_INTERVAL / 3);

    this.idle_time = Date.now() + this.idle_timeout;

    /*
    The this.init_time is a Date in the future.
    It is pushed forward each time this.idle_reset is called.
    The setInterval timer checks every minute, if the current
    time is past this this.init_time.
    If so, the user is 'idle'.
    To keep 'active', call webapp_client.idle_reset as often as you like:
    A document.body event listener here and one for each
    jupyter iframe.body (see jupyter.coffee).
    */

    this.idle_reset();

    // There is no need to worry about cleaning this up, since the client survives
    // for the lifetime of the page.
    setInterval(this.idle_check, CHECK_INTERVAL);

    // Call this idle_reset like a throttled function
    // so will reset timer on *first* call and
    // then periodically while being called
    this.idle_reset = throttle(this.idle_reset, CHECK_INTERVAL / 2);

    // activate a listener on our global body (universal sink for
    // bubbling events, unless stopped!)
    $(document).on(
      "click mousemove keydown focusin touchstart",
      this.idle_reset,
    );
    $("#smc-idle-notification").on(
      "click mousemove keydown focusin touchstart",
      this.idle_reset,
    );

    // Keep visible pages alive. Passive viewing is a legitimate use case:
    // presentations, dashboards, second-monitor watching, and following live
    // project output should not trigger hard standby just because there was no
    // recent input event.
    setInterval(() => {
      if (!document.hidden) {
        this.idle_reset();
      }
    }, CHECK_INTERVAL / 2);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("focus", this.handleVisibilityChange);
  };

  private idle_check = (): void => {
    if (!this.idle_time || lite) return;
    const remaining = this.idle_time - Date.now();
    if (remaining > 0) {
      // console.log(`Standby in ${Math.round(remaining / 1000)}s if not active`);
      return;
    }
    this.show_notification();
    if (!this.delayedSoftStandby && this.standbyStage === "active") {
      // Give the user a brief warning window before we shed project-local
      // resources. Hidden idle tabs first enter a soft standby that keeps the
      // main account connection alive for notifications and presence.
      this.delayedSoftStandby = setTimeout(() => {
        this.delayedSoftStandby = undefined;
        this.enterSoftStandby();
      }, SOFT_STANDBY_WARNING_DELAY_MS);
    }
  };

  // We set this.idle_time to the **moment in in the future** at
  // which the user will be considered idle.
  public idle_reset = (): void => {
    this.hide_notification();
    this.idle_time = Date.now() + this.idle_timeout + 1000;
    if (this.delayedSoftStandby) {
      clearTimeout(this.delayedSoftStandby);
      this.delayedSoftStandby = undefined;
    }
    if (this.delayedHardStandby) {
      clearTimeout(this.delayedHardStandby);
      this.delayedHardStandby = undefined;
    }
    if (this.standbyStage !== "active") {
      this.standbyStage = "active";
      console.log("Leaving standby mode");
      this.client.conat_client.resume();
    }
  };

  // Change the standby timeout to a particular time in minutes.
  // This gets called when the user configuration settings are set/loaded.
  public set_standby_timeout_m = (time_m: number): void => {
    this.idle_timeout = time_m * 60 * 1000;
    this.idle_reset();
  };

  private handleVisibilityChange = (): void => {
    if (!document.hidden) {
      this.idle_reset();
    }
  };

  private enterSoftStandby = (): void => {
    if (this.standbyStage !== "active") {
      return;
    }
    console.log("Entering soft standby mode");
    this.standbyStage = "soft";
    if (typeof this.client.conat_client.softStandby === "function") {
      this.client.conat_client.softStandby();
    } else {
      this.client.conat_client.standby();
    }
    if (!this.delayedHardStandby) {
      this.delayedHardStandby = setTimeout(() => {
        this.delayedHardStandby = undefined;
        this.enterHardStandby();
      }, HARD_STANDBY_DELAY_MS);
    }
  };

  private enterHardStandby = (): void => {
    if (this.standbyStage === "hard") {
      return;
    }
    console.log("Escalating to hard standby mode");
    this.standbyStage = "hard";
    this.client.conat_client.standby();
  };

  private notification_html = (): string => {
    const customize = redux.getStore("customize");
    const site_name = customize.get("site_name");
    const description = customize.get("site_description");
    const logo_rect = customize.get("logo_rectangular");
    const logo_square = customize.get("logo_square");

    // we either have just a customized square logo or square + rectangular -- or just the baked in default
    let html: string = "<div>";
    if (logo_square != "") {
      if (logo_rect != "") {
        html += `<img class="logo-square" src="${logo_square}"><img  class="logo-rectangular" src="${logo_rect}">`;
      } else {
        html += `<img class="logo-square" src="${logo_square}"><h3>${site_name}</h3>`;
      }
      html += `<h4>${description}</h4>`;
    } else {
      // We have to import this here since art can *ONLY* be imported
      // when this is loaded in webpack.
      const { APP_LOGO_WHITE } = require("../art");
      html += `<img class="logo-square" src="${APP_LOGO_WHITE}"><h3>${description}</h3>`;
    }

    return html + "&mdash; click to reconnect &mdash;</div>";
  };

  show_notification = (): void => {
    if (this.notification_is_visible || lite) return;
    const idle = $("#cocalc-idle-notification");
    if (idle.length === 0) {
      const content = this.notification_html();
      const box = $("<div/>", { id: "cocalc-idle-notification" }).html(content);
      $("body").append(box);
      // quick slide up, just to properly slide down the fist time
      box.slideUp(0, () => box.slideDown("slow"));
    } else {
      idle.slideDown("slow");
    }
    this.notification_is_visible = true;
  };

  hide_notification = (): void => {
    if (!this.notification_is_visible) return;
    $("#cocalc-idle-notification").slideUp("slow");
    this.notification_is_visible = false;
  };
}
