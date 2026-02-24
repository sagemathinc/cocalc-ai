/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Chat Editor Actions
*/

import {
  StructuredEditorActions as CodeEditorActions,
  CodeEditorState,
} from "../base-editor/actions-structured";
import { FrameTree } from "../frame-tree/types";
import { ChatActions } from "@cocalc/frontend/chat/actions";
import {
  getInitialState,
  ChatState,
  ChatStore,
} from "@cocalc/frontend/chat/store";
import { handleSyncDBChange, initFromSyncDB } from "@cocalc/frontend/chat/sync";
import { redux_name } from "@cocalc/frontend/app-framework";
import { aux_file } from "@cocalc/util/misc";
import type { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import { delay } from "awaiting";
import { newest_content } from "@cocalc/frontend/chat/utils";
import type { ChatMessageTyped } from "@cocalc/frontend/chat/types";
import { ChatMessageCache } from "@cocalc/frontend/chat/message-cache";
import { parseChatPreviewRows } from "@cocalc/frontend/chat/preview";
import {
  log_opened_time,
  mark_open_phase,
} from "@cocalc/frontend/project/open-file";

const FRAME_TYPE = "chatroom";
const FAST_OPEN_CHAT_STATUS = "Loading live collaboration...";

type ChatEditorState = CodeEditorState & ChatState;

export class Actions extends CodeEditorActions<ChatEditorState> {
  protected syncDocOptions = {
    ignoreInitialChanges: true,
    change_throttle: 3000,
  };
  private chatActions: { [frameId: string]: ChatActions } = {};
  private auxPath: string;
  private messageCache?: ChatMessageCache;
  private chatFastOpenToken = 0;
  private chatFastOpenApplied = false;

  private startOptimisticChatFastOpen(syncdb: any): void {
    const fs = this._get_project_actions()?.fs?.();
    if (typeof fs?.readFile !== "function") return;
    const token = ++this.chatFastOpenToken;
    void (async () => {
      try {
        const raw = await fs.readFile(this.path, "utf8");
        if (this.isClosed() || token !== this.chatFastOpenToken) return;
        if (syncdb?.get_state?.() === "ready") return;
        const content =
          typeof raw === "string"
            ? raw
            : ((raw as any)?.toString?.("utf8") ?? `${raw ?? ""}`);
        const parsed = parseChatPreviewRows(content);
        const applied = this.messageCache?.applyPreviewRows(parsed.rows);
        if (!applied?.applied) return;
        this.chatFastOpenApplied = true;
        this.setState({
          is_loaded: true,
          read_only: true,
          status: FAST_OPEN_CHAT_STATUS,
          rtc_status: "loading",
        });
        mark_open_phase(this.project_id, this.path, "optimistic_ready", {
          bytes: content.length,
          rows: parsed.parsedRows,
          parse_errors: parsed.parseErrors,
        });
        log_opened_time(this.project_id, this.path);
      } catch {
        // fall back to normal sync-ready path
      }
    })();
  }

  _init2(): void {
    this.auxPath = aux_file(this.path, "tasks");
    const store = this.store;
    this.setState({
      ...getInitialState(),
      project_id: this.project_id,
      path: this.path,
    });
    const syncdb = this._syncstring;
    // Single shared message cache for all chat frames attached to this syncdoc.
    this.messageCache = new ChatMessageCache(syncdb);
    this.startOptimisticChatFastOpen(syncdb);
    syncdb.once("ready", () => {
      initFromSyncDB({ syncdb, store });
      if (this.chatFastOpenApplied) {
        this.chatFastOpenApplied = false;
        if (this.store?.get("status") === FAST_OPEN_CHAT_STATUS) {
          this.setState({ status: "" });
        }
        this.setState({ rtc_status: "live" });
        mark_open_phase(this.project_id, this.path, "handoff_done");
      }
    });
    syncdb.on("change", (changes) => {
      handleSyncDBChange({ store, syncdb, changes });
    });
  }

  foldAIThreads(id: string) {
    this.chatActions[id]?.foldAllThreads(true);
  }

  foldAllThreads(id: string) {
    this.chatActions[id]?.foldAllThreads(false);
  }

  getChatActions(frameId?): ChatActions | undefined {
    if (frameId == null) {
      for (const actions of Object.values(this.chatActions)) {
        return actions;
      }
      return undefined;
    }
    if (this.chatActions[frameId] != null) {
      return this.chatActions[frameId];
    }

    if (this._get_frame_type(frameId) != FRAME_TYPE) {
      // if frame is not of type FRAME_TYPE, no chat actions are defined
      return;
    }

    const syncdb = this._syncstring;
    const auxPath = this.auxPath + frameId;
    const reduxName = redux_name(this.project_id, auxPath);
    const actions = this.redux.createActions(reduxName, ChatActions);
    if (!this.messageCache) {
      throw Error("messageCache must be defined");
    }
    // our store is not exactly a ChatStore but it's close enough
    actions.set_syncdb(syncdb, this.store as ChatStore, this.messageCache);
    actions.frameId = frameId;
    actions.frameTreeActions = this as any;
    this.chatActions[frameId] = actions;
    return actions;
  }

  undo() {
    this.getChatActions()?.undo();
  }
  redo() {
    this.getChatActions()?.redo();
  }

  help() {
    this.getChatActions()?.help();
  }

  close_frame(frameId: string): void {
    super.close_frame(frameId); // actually closes the frame itself
    // now clean up if it is a chat frame:
    if (this.chatActions[frameId] != null) {
      this.closeChatFrame(frameId);
    }
  }

  closeChatFrame(frameId: string): void {
    const actions = this.chatActions[frameId];
    if (actions == null) {
      return;
    }
    actions.dispose?.();
    delete this.chatActions[frameId];
    const name = actions.name;
    this.redux.removeActions(name);
  }

  close(): void {
    if (this._state == "closed") {
      return;
    }
    for (const frameId in this.chatActions) {
      this.closeChatFrame(frameId);
    }
    this.messageCache?.dispose?.();
    this.messageCache = undefined;
    super.close();
  }

  _raw_default_frame_tree(): FrameTree {
    return { type: FRAME_TYPE };
  }

  async export_to_markdown(): Promise<void> {
    try {
      await this.getChatActions()?.export_to_markdown();
    } catch (error) {
      this.set_error(`${error}`);
    }
  }

  scrollToBottom = (frameId) => {
    this.getChatActions(frameId)?.scrollToIndex(-1);
  };

  scrollToTop = (frameId) => {
    this.getChatActions(frameId)?.scrollToIndex(0);
  };

  async gotoFragment(fragmentId: FragmentId) {
    const { chat } = fragmentId as any;
    if (!chat) {
      return;
    }
    const frameId = await this.waitUntilFrameReady({
      type: FRAME_TYPE,
    });
    if (!frameId) {
      return;
    }
    for (const d of [1, 10, 50, 500, 1000]) {
      const actions = this.getChatActions(frameId);
      actions?.scrollToDate(chat);
      await delay(d);
    }
  }

  getSearchIndexData = () => {
    const messages: Map<string, ChatMessageTyped> | undefined =
      this.messageCache?.getMessages();
    if (!messages) {
      return {};
    }
    const data: { [id: string]: string } = {};
    for (const [id, message] of messages) {
      if (message == null) continue;
      data[id] = newest_content(message);
    }
    return { data, fragmentKey: "chat" };
  };
}
