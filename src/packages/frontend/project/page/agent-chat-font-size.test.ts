/** @jest-environment jsdom */

import { redux } from "@cocalc/frontend/app-framework";
import { PageStore } from "@cocalc/frontend/app/store";
import {
  AGENT_CHAT_FONT_MAX,
  AGENT_CHAT_FONT_MIN,
  readAgentChatFontSize,
  writeAgentChatFontSize,
} from "./agent-chat-font-size";

function initPageStore() {
  if ((redux as any).hasStore?.("page")) {
    redux.removeStore("page");
  }
  redux.createStore("page", PageStore, {
    active_top_tab: "settings",
    show_connection: false,
    connection_status: "connecting",
    connection_quality: "good",
    cookie_warning: false,
    local_storage_warning: false,
    num_ghost_tabs: 0,
  } as any);
}

describe("agent chat font size", () => {
  beforeEach(() => {
    window.localStorage.clear();
    initPageStore();
  });

  afterEach(() => {
    redux.removeStore("page");
  });

  it("reads from persisted storage with fallback and clamping", () => {
    expect(readAgentChatFontSize(15)).toBe(15);
    window.localStorage.setItem("agent-chat-font-size-v1", "999");
    expect(readAgentChatFontSize(13)).toBe(AGENT_CHAT_FONT_MAX);
    window.localStorage.setItem("agent-chat-font-size-v1", "1");
    expect(readAgentChatFontSize(13)).toBe(AGENT_CHAT_FONT_MIN);
  });

  it("writes the font size to local storage and the page store", () => {
    expect(writeAgentChatFontSize(18)).toBe(18);
    expect(window.localStorage.getItem("agent-chat-font-size-v1")).toBe("18");
    expect(redux.getStore("page")?.get("agent_chat_font_size")).toBe(18);
  });
});
