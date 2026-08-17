/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import {
  createHeadlessChatClient,
  type ChatSnapshot,
  type HeadlessChatClient,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import { COLORS } from "@cocalc/util/theme";
import NetInfo from "@react-native-community/netinfo";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  PlatformColor,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Markdown } from "../../../chat/markdown";
import { loadChatDraft, saveChatDraft } from "../../../chat/drafts";
import { ensureProjectRunning } from "../../../cocalc/project-runtime";
import {
  getActiveSiteSession,
  peekActiveSiteSession,
} from "../../../cocalc/session-registry";
import { openProjectHost } from "../../../cocalc/site-session";
import { projectWebUrl } from "../../../cocalc/web-links";

function useChatSnapshot(
  client: HeadlessChatClient | undefined,
  projectId: string,
  path: string,
): ChatSnapshot {
  const fallback = useMemo<ChatSnapshot>(
    () => ({
      revision: 0,
      connection: "closed",
      ready: false,
      project_id: projectId,
      path,
      threads: [],
      messages: [],
    }),
    [path, projectId],
  );
  const subscribe = useCallback(
    (notify: () => void) =>
      client ? client.subscribe(() => notify()) : () => undefined,
    [client],
  );
  const getSnapshot = useCallback(
    () => client?.getSnapshot() ?? fallback,
    [client, fallback],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function Message({ item }: { item: ProjectedChatMessage }) {
  const human = item.role === "human";
  return (
    <View
      accessibilityLabel={`${human ? "You" : item.role} message${item.state ? `, ${item.state}` : ""}`}
      style={[
        styles.message,
        human ? styles.humanMessage : styles.agentMessage,
      ]}
    >
      <View style={styles.messageHeader}>
        <Text style={styles.messageRole}>
          {human ? "You" : item.role === "agent" ? "Codex" : "System"}
        </Text>
        {item.state ? (
          <Text style={styles.messageState}>{item.state}</Text>
        ) : null}
      </View>
      {item.activity?.markdown ? (
        <View accessibilityLabel="Codex activity" style={styles.activity}>
          <Markdown value={item.activity.markdown} />
        </View>
      ) : item.activity?.state === "loading" && item.generating ? (
        <Text accessibilityLiveRegion="polite" style={styles.activityStatus}>
          Loading Codex activity…
        </Text>
      ) : item.activity?.state === "error" && item.generating ? (
        <Text accessibilityRole="alert" style={styles.activityError}>
          Codex activity could not be recovered: {item.activity.error}
        </Text>
      ) : null}
      <Markdown value={item.content || (item.generating ? "Working…" : "")} />
      <Pressable
        accessibilityLabel={`Copy ${human ? "your" : "Codex"} message`}
        accessibilityRole="button"
        hitSlop={10}
        onPress={() => void Clipboard.setStringAsync(item.content)}
      >
        <Text style={styles.smallLink}>Copy</Text>
      </Pressable>
    </View>
  );
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{
    projectId?: string;
    profile?: string;
    host?: string;
    chatPath?: string;
    thread?: string;
    title?: string;
  }>();
  const projectId = `${params.projectId ?? ""}`;
  const profileId = `${params.profile ?? ""}`;
  const hostId = `${params.host ?? ""}`;
  const chatPath = `${params.chatPath ?? ""}`;
  const threadId = `${params.thread ?? ""}`;
  const [client, setClient] = useState<HeadlessChatClient>();
  const clientRef = useRef<HeadlessChatClient | undefined>(undefined);
  const generation = useRef(0);
  const listRef = useRef<FlatList<ProjectedChatMessage>>(null);
  const shouldFollowNewest = useRef(true);
  const userControlsScroll = useRef(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState<string>();
  const snapshot = useChatSnapshot(client, projectId, chatPath);
  const draftKey = useMemo(
    () => ({ profileId, projectId, path: chatPath, threadId }),
    [chatPath, profileId, projectId, threadId],
  );

  const disconnect = useCallback(async () => {
    const previous = clientRef.current;
    clientRef.current = undefined;
    setClient(undefined);
    await previous?.close();
  }, []);

  const connect = useCallback(async () => {
    const current = ++generation.current;
    await disconnect();
    setError(undefined);
    setStatus("Connecting…");
    if (!projectId || !profileId || !hostId || !chatPath || !threadId) {
      setError("The chat route is incomplete.");
      return;
    }
    try {
      const session = await getActiveSiteSession(profileId);
      await ensureProjectRunning(session, projectId, setStatus);
      if (current !== generation.current) return;
      const lease = await openProjectHost(session, {
        project_id: projectId,
        host_id: hostId,
      });
      if (current !== generation.current) return;
      const next = createHeadlessChatClient({
        account_id: session.profile.account_id,
        project_id: projectId,
        path: chatPath,
        projectHostClient: lease.client,
        selected_thread_id: threadId,
      });
      clientRef.current = next;
      setClient(next);
      await next.open();
      if (current !== generation.current) {
        await next.close();
        return;
      }
      setStatus("Live collaborative chat");
    } catch (err) {
      if (current === generation.current) {
        setError(err instanceof Error ? err.message : `${err}`);
        setStatus("Disconnected");
      }
    }
  }, [chatPath, disconnect, hostId, profileId, projectId, threadId]);

  useEffect(() => {
    void loadChatDraft(draftKey).then(setDraft);
  }, [draftKey]);

  const scrollToNewest = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: false });
  }, []);
  const hasMessages = snapshot.messages.length > 0;

  const updateFollowNewest = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (userControlsScroll.current) return;
      const distanceFromNewest =
        nativeEvent.contentSize.height -
        nativeEvent.layoutMeasurement.height -
        nativeEvent.contentOffset.y;
      shouldFollowNewest.current = distanceFromNewest < 80;
    },
    [],
  );

  useEffect(() => {
    if (!snapshot.ready || !hasMessages) return;
    shouldFollowNewest.current = true;
    const frame = requestAnimationFrame(scrollToNewest);
    const first = setTimeout(scrollToNewest, 100);
    const settled = setTimeout(scrollToNewest, 400);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(first);
      clearTimeout(settled);
    };
  }, [hasMessages, scrollToNewest, snapshot.ready, threadId]);

  useEffect(() => {
    const timer = setTimeout(() => void saveChatDraft(draftKey, draft), 250);
    return () => clearTimeout(timer);
  }, [draft, draftKey]);

  useEffect(() => {
    void connect();
    return () => {
      generation.current += 1;
      void disconnect();
    };
  }, [connect, disconnect]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (!clientRef.current) void connect();
      } else if (state === "background") {
        generation.current += 1;
        peekActiveSiteSession()?.projectHosts.invalidateProject(projectId);
        void disconnect();
      }
    });
    const unsubscribeNetwork = NetInfo.addEventListener((network) => {
      if (
        network.isConnected &&
        AppState.currentState === "active" &&
        snapshot.connection === "disconnected"
      ) {
        peekActiveSiteSession()?.projectHosts.invalidateProject(projectId);
        void connect();
      }
    });
    return () => {
      subscription.remove();
      unsubscribeNetwork();
    };
  }, [connect, disconnect, projectId, snapshot.connection]);

  const selectedThread = snapshot.threads.find(
    (thread) => thread.thread_id === threadId,
  );
  const canSend =
    snapshot.ready &&
    !submitting &&
    !!draft.trim() &&
    (selectedThread?.agent_kind === "acp" ||
      selectedThread?.acp_config != null);

  const send = async () => {
    const activeClient = clientRef.current;
    const text = draft.trim();
    if (!activeClient || !canSend || !text) return;
    shouldFollowNewest.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const session = await getActiveSiteSession(profileId);
      await ensureProjectRunning(session, projectId, setStatus);
      await activeClient.sendToExistingCodexThread({
        thread_id: threadId,
        text,
      });
      setDraft("");
      await saveChatDraft(draftKey, "");
      setStatus("Prompt accepted by Codex");
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
      setStatus("Prompt was not accepted");
    } finally {
      setSubmitting(false);
    }
  };

  const interrupt = async () => {
    const activeClient = clientRef.current;
    if (!activeClient || interrupting) return;
    setInterrupting(true);
    setError(undefined);
    try {
      await activeClient.interrupt(threadId);
      setStatus("Interrupt confirmed");
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setInterrupting(false);
    }
  };

  const openBrowser = async () => {
    try {
      const session = await getActiveSiteSession(profileId);
      await Linking.openURL(
        projectWebUrl(session.profile, projectId, chatPath),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };

  const running = selectedThread?.state === "running";

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title: `${params.title || "Codex"}`,
        }}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
        style={styles.flex}
      >
        <View style={styles.statusBar}>
          <Text accessibilityLiveRegion="polite" style={styles.statusText}>
            {snapshot.connection === "connected"
              ? `${status} · ${selectedThread?.state ?? "idle"}`
              : status}
          </Text>
          <Pressable
            accessibilityLabel="Open chat in browser"
            accessibilityRole="button"
            onPress={() => void openBrowser()}
          >
            <Text style={styles.smallLink}>Web</Text>
          </Pressable>
        </View>
        {error ? (
          <View style={styles.errorBox}>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <Pressable
              accessibilityLabel="Retry chat connection"
              accessibilityRole="button"
              onPress={() => void connect()}
            >
              <Text style={styles.link}>Retry connection</Text>
            </Pressable>
          </View>
        ) : null}
        {!snapshot.ready && !error ? (
          <ActivityIndicator
            accessibilityLabel="Loading chat"
            style={styles.loader}
          />
        ) : null}
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.messages}
          data={snapshot.messages}
          keyExtractor={(item) => item.message_id}
          ListEmptyComponent={
            snapshot.ready ? (
              <Text style={styles.emptyText}>No messages in this thread.</Text>
            ) : null
          }
          onContentSizeChange={() =>
            shouldFollowNewest.current && scrollToNewest()
          }
          onLayout={() => {
            if (shouldFollowNewest.current) scrollToNewest();
          }}
          onMomentumScrollBegin={() => {
            userControlsScroll.current = true;
          }}
          onMomentumScrollEnd={(event) => {
            userControlsScroll.current = false;
            updateFollowNewest(event);
          }}
          onScrollBeginDrag={() => {
            userControlsScroll.current = true;
            shouldFollowNewest.current = false;
          }}
          onScrollEndDrag={(event) => {
            userControlsScroll.current = false;
            updateFollowNewest(event);
          }}
          onScroll={updateFollowNewest}
          ref={listRef}
          renderItem={({ item }) => <Message item={item} />}
          scrollEventThrottle={16}
        />
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Message Codex"
            editable={snapshot.ready && !submitting}
            multiline
            onChangeText={setDraft}
            placeholder="Message Codex"
            placeholderTextColor={PlatformColor("placeholderText")}
            style={styles.input}
            value={draft}
          />
          <View style={styles.actions}>
            {running ? (
              <Pressable
                accessibilityLabel="Interrupt Codex turn"
                accessibilityRole="button"
                disabled={interrupting}
                onPress={() => void interrupt()}
                style={({ pressed }) => [
                  styles.interruptButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.interruptText}>
                  {interrupting ? "Interrupting…" : "Interrupt"}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Send message to Codex"
              accessibilityRole="button"
              disabled={!canSend}
              onPress={() => void send()}
              style={({ pressed }) => [
                styles.sendButton,
                !canSend && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.sendText}>
                {submitting ? "Sending…" : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PlatformColor("systemBackground") },
  flex: { flex: 1 },
  statusBar: {
    alignItems: "center",
    borderBottomColor: PlatformColor("separator"),
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  statusText: { color: PlatformColor("secondaryLabel"), flex: 1, fontSize: 13 },
  loader: { flex: 1 },
  messages: { gap: 10, padding: 12 },
  message: { borderRadius: 12, gap: 8, maxWidth: "94%", padding: 12 },
  humanMessage: {
    alignSelf: "flex-end",
    backgroundColor: PlatformColor("secondarySystemBackground"),
  },
  agentMessage: {
    alignSelf: "flex-start",
    backgroundColor: PlatformColor("tertiarySystemBackground"),
  },
  messageHeader: { flexDirection: "row", gap: 8 },
  activity: {
    borderLeftColor: PlatformColor("separator"),
    borderLeftWidth: 3,
    paddingLeft: 10,
  },
  activityStatus: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 13,
  },
  activityError: { color: COLORS.BS_RED, fontSize: 13 },
  messageRole: {
    color: PlatformColor("label"),
    fontSize: 13,
    fontWeight: "700",
  },
  messageState: { color: PlatformColor("secondaryLabel"), fontSize: 13 },
  smallLink: { color: COLORS.ANTD_LINK_BLUE, fontSize: 13, fontWeight: "600" },
  link: { color: COLORS.ANTD_LINK_BLUE, fontSize: 15, fontWeight: "600" },
  emptyText: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 16,
    padding: 24,
    textAlign: "center",
  },
  errorBox: { gap: 6, padding: 12 },
  errorText: { color: COLORS.BS_RED, fontSize: 14 },
  composer: {
    borderTopColor: PlatformColor("separator"),
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    padding: 10,
  },
  input: {
    backgroundColor: PlatformColor("secondarySystemBackground"),
    borderRadius: 12,
    color: PlatformColor("label"),
    fontSize: 16,
    maxHeight: 150,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  sendButton: {
    backgroundColor: COLORS.COCALC_BLUE,
    borderRadius: 9,
    minHeight: 40,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  sendText: {
    color: COLORS.TOP_BAR.ACTIVE,
    fontSize: 15,
    fontWeight: "700",
  },
  interruptButton: {
    borderColor: COLORS.BS_RED,
    borderRadius: 9,
    borderWidth: 1,
    minHeight: 40,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  interruptText: { color: COLORS.BS_RED, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
