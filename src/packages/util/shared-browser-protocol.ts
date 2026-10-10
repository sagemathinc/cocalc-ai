/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What the CoCalc frontend's shared browser viewer and the browser service in
the project say to each other.  They talk over a conat socket on the
project's subject, like a terminal: the connection is the user's own
authenticated one, so nothing else (another site, a page in the browser)
can reach the viewer's controls.

The viewer sends JSON messages (ViewerMessage) and requests
(ViewerRequest); the service sends JSON messages (ServiceMessage) and the
screen as binary frames, each with a sequence number in the FRAME_HEADER
header, which the viewer acknowledges once drawn.  The service keeps only a
few frames in flight per viewer and replaces the rest by the newest one, so
a slow link gets fewer frames, never a growing backlog.
*/

import type { SharedBrowserRunsOn } from "./shared-browser";

/** The conat subject of a shared browser's viewer socket. */
export function sharedBrowserSubject(project_id: string, appId: string) {
  return `browser.project-${project_id}.${appId}`;
}

export type Driver = "agent" | "human";

export interface SharedBrowserTab {
  id: string;
  url: string;
  title: string;
  // The page's icon (its URL; the viewer gets it with a favicon request).
  icon?: string;
}

export interface SharedBrowserState {
  driver: Driver;
  // The agent asked the human to take over (e.g. to log in).
  ask: { message: string; at: string } | null;
  tabs: SharedBrowserTab[];
  active: string | null;
  viewport: { width: number; height: number };
  dialog: { type: string; message: string; defaultPrompt?: string } | null;
  select: {
    options: { label: string; disabled?: boolean; group?: string }[];
    selected: number;
  } | null;
  fileChooser: { mode: string } | null;
  agents: number;
  // Agent commands are waiting for the human to hand back.
  agentWaiting: boolean;
  cdp: string;
  viewers: number;
  // Whether a browser is attached; "waiting" while a .browser file's
  // browser on the user's computer is not connected.
  connection: "connected" | "waiting";
  // Where a .browser file's browser runs (null: the project's own browser,
  // which always runs in the project), and how to connect a computer.
  runsOn: SharedBrowserRunsOn | null;
  connectCommand: string | null;
  // What the start page calls this browser (e.g. the file's name).
  title: string;
  // The tab's page zoom (1 = 100%), like a browser's zoom: the page lays out
  // for a narrower window at a higher pixel ratio.  New tabs get the last one.
  zoom: number;
  // A browser in its own container: on its own network ("own": the internet,
  // as the project's policy allows) or the project's ("project": its
  // localhost servers too).  null: it runs in the project or on a computer.
  network: SharedBrowserNetwork | null;
}

export type SharedBrowserNetwork = "own" | "project";

// The screen's picture quality: see the service's QUALITY.
export type ViewQuality = "sharp" | "balanced" | "fast";

// The header carrying a frame's sequence number.
export const FRAME_HEADER = "frame";

// Frames a viewer may have unacknowledged before newer ones wait.
export const FRAMES_IN_FLIGHT = 3;

export type MouseEventType =
  | "mousePressed"
  | "mouseReleased"
  | "mouseMoved"
  | "mouseWheel";

export type ViewerMessage =
  // First, and again after every reconnect.  view: the place showing it
  // ("frame:<id>" for an editor frame, "card:<id>"), so a frame that comes
  // back shows its own tab; client: the page load it is in (one person's
  // browser tab), so a split gets a tab of its own; site: the CoCalc site
  // the user is on, for the command that connects their computer.
  | { type: "hello"; view?: string; client?: string; site?: string }
  | { type: "ack"; seq: number }
  | { type: "visible"; visible: boolean }
  | { type: "resize"; width: number; height: number; quality?: ViewQuality }
  | { type: "tab"; id: string }
  | { type: "zoom"; zoom: number }
  | { type: "takeover" }
  | { type: "handback" }
  | { type: "runsOn"; value: SharedBrowserRunsOn }
  | { type: "network"; value: SharedBrowserNetwork }
  // The rest act on the page, and only while the human drives.
  | { type: "newTab" }
  | { type: "closeTab"; id: string }
  | {
      type: "mouse";
      event: MouseEventType;
      x: number;
      y: number;
      button?: "none" | "left" | "middle" | "right";
      buttons?: number;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      type: "key";
      event: "keyDown" | "rawKeyDown" | "keyUp";
      key: string;
      code: string;
      text?: string;
      keyCode: number;
      modifiers?: number;
    }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "history"; delta: -1 | 1 }
  | { type: "reload" }
  | { type: "dialog"; accept: boolean; promptText?: string }
  | { type: "select"; index: number }
  | { type: "file"; paths: string[] };

export type ServiceMessage =
  | { type: "state"; state: SharedBrowserState }
  // What is selected in the viewer's tab, for the human's clipboard.
  | { type: "selection"; text: string }
  // The page copied this (e.g. its copy button), while the human drives.
  | { type: "copied"; text: string }
  | { type: "error"; message: string };

export type ViewerRequest =
  // A new tab's start page.
  | { type: "start" }
  // A site's icon (a tab's, or a recent site's on the start page).
  | { type: "favicon"; url: string };

export interface StartPageServer {
  port: number;
  url: string;
  label: string;
}

export interface StartPageSite {
  url: string;
  title: string;
}

export interface StartPageData {
  servers: StartPageServer[];
  recent: StartPageSite[];
}

// A favicon request's answer: the image, or null.
export type FaviconData = { type: string; body: Uint8Array } | null;
