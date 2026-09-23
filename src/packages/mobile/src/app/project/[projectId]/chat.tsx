/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { MarkdownImageContext } from "../../../chat/markdown-image";
import { createMarkdownImageResolver } from "../../../cocalc/markdown-images";
import { PaymentSummary } from "../../../chat/payment-summary";
import { ChatSettings } from "../../../chat/settings";

import {
  createRemoteHeadlessChatClient,
  type ChatSnapshot,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import type { AppearancePalette } from "@cocalc/util/appearance-palette";
import { usePalette } from "../../../ui/palette";
import NetInfo from "@react-native-community/netinfo";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { useLiveVoice } from "../../../live/use-live";
import { LiveVoiceControls } from "../../../live/controls";
import { useSpeech } from "../../../speech/use-speech";
import { useHeaderHeight } from "expo-router/react-navigation";
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
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Markdown } from "../../../chat/markdown";
import {
  clearChatDraftIfUnchanged,
  loadChatDraft,
  saveChatDraft,
} from "../../../chat/drafts";
import { ensureProjectRunning } from "../../../cocalc/project-runtime";
import {
  getActiveSiteSession,
  peekActiveSiteSession,
} from "../../../cocalc/session-registry";
import { openProjectHost } from "../../../cocalc/site-session";
import { projectWebUrl } from "../../../cocalc/web-links";

import {
  isPreviewProfile,
  resumePreviewChat,
  type ConversationClient,
} from "../../../preview/fixtures";

function useChatSnapshot(
  client: ConversationClient | undefined,
  profileId: string,
  projectId: string,
  path: string,
  threadId: string,
): ChatSnapshot {
  const fallback = useMemo<ChatSnapshot>(
    () => ({
      revision: 0,
      connection: "closed",
      ready: false,
      project_id: projectId,
      path,
      selected_thread_id: threadId,
      threads: [],
      messages: [],
    }),
    [path, profileId, projectId, threadId],
  );
  const cached = useRef({ fallback, snapshot: fallback, source: fallback });
  if (cached.current.fallback !== fallback)
    cached.current = { fallback, snapshot: fallback, source: fallback };
  const subscribe = useCallback(
    (notify: () => void) =>
      client ? client.subscribe(() => notify()) : () => undefined,
    [client],
  );
  const getSnapshot = useCallback(() => {
    if (client) {
      const next = client.getSnapshot();
      if (next !== cached.current.source) {
        const previous = cached.current.snapshot;
        cached.current.source = next;
        cached.current.snapshot =
          !next.ready && previous.messages.length
            ? {
                ...next,
                messages: previous.messages,
                threads: previous.threads,
              }
            : next;
      }
    }
    return cached.current.snapshot;
  }, [client, fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function Message({
  item,
  read,
  speechBusy,
}: {
  item: ProjectedChatMessage;
  read: (item: ProjectedChatMessage) => void;
  speechBusy: boolean;
}) {
  const colors = usePalette();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const human = item.role === "human";
  const thinkingPlaceholder =
    !human &&
    /^\s*(?::robot:|🤖)?\s*Thinking(?:\.{3}|…)\s*$/.test(item.content);

  return (
    <View
      style={[
        styles.message,
        human ? styles.humanMessage : styles.agentMessage,
      ]}
    >
      <View style={styles.messageHeader}>
        <Text style={styles.messageRole}>
          {human ? "You" : item.role === "agent" ? "Codex" : "System"}
        </Text>
        {item.generating ? (
          <View
            accessibilityLabel="Codex running"
            accessibilityLiveRegion="polite"
            accessibilityRole="text"
            style={styles.runningBadge}
          >
            <ActivityIndicator
              accessibilityElementsHidden
              color={colors.secondary}
              size={12}
            />
            <Text style={styles.runningText}>Running</Text>
          </View>
        ) : item.state ? (
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
      {thinkingPlaceholder || (item.generating && !item.content) ? null : (
        <Markdown value={item.content} />
      )}
      <View style={styles.messageActions}>
        {item.role === "agent" && !item.generating && !!item.content && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Read response aloud"
            testID={`read-response-${item.message_id}`}
            accessibilityState={{ disabled: speechBusy }}
            disabled={speechBusy}
            onPress={() => read(item)}
            style={styles.messageAction}
          >
            <Text style={styles.smallLink}>Read aloud</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.messageAction}
          accessibilityLabel={`Copy ${human ? "your" : "Codex"} message`}
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => void Clipboard.setStringAsync(item.content)}
        >
          <Text style={styles.smallLink}>Copy</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const headerHeight = useHeaderHeight();
  const colors = usePalette();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
  const chatPath = `${params.chatPath ?? ""}`;
  const resolveImage = useMemo(
    () => createMarkdownImageResolver(profileId, projectId, chatPath),
    [profileId, projectId, chatPath],
  );
  const threadId = `${params.thread ?? ""}`;
  const [client, setClient] = useState<ConversationClient>();
  const clientRef = useRef<ConversationClient | undefined>(undefined);
  const generation = useRef(0);
  const listRef = useRef<FlatList<ProjectedChatMessage>>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState<string>();
  const snapshot = useChatSnapshot(
    client,
    profileId,
    projectId,
    chatPath,
    threadId,
  );
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
    if (current !== generation.current) return;
    setError(undefined);
    setStatus("Connecting…");
    if (!projectId || !profileId || !chatPath || !threadId) {
      setError("The chat route is incomplete.");
      return;
    }
    try {
      if (isPreviewProfile(profileId)) {
        const next = resumePreviewChat(threadId);
        clientRef.current = next;
        setClient(next);
        setStatus("Local preview · no network");
        return;
      }
      const session = await getActiveSiteSession(profileId);
      const resolvedHost = await resolveNamedAgentHost(
        session.hubApi,
        session.profile.account_id,
        projectId,
      );
      if (current !== generation.current) return;
      const lease = await openProjectHost(session, {
        project_id: projectId,
        host_id: resolvedHost,
      });
      if (current !== generation.current) return;
      const next = createRemoteHeadlessChatClient({
        account_id: session.profile.account_id,
        project_id: projectId,
        path: chatPath,
        projectHostClient: lease.client,
        selected_thread_id: threadId,
        initial_message_limit: 8,
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
  }, [chatPath, disconnect, profileId, projectId, threadId]);

  useEffect(() => {
    let active = true;
    setDraftLoaded(false);
    setDraft("");
    void loadChatDraft(draftKey)
      .then((value) => {
        if (active) {
          setDraft(value);
          setDraftLoaded(true);
        }
      })
      .catch((err) => {
        if (active) setError(`Could not restore your draft: ${err}`);
      });
    return () => {
      active = false;
    };
  }, [draftKey, draftRevision]);

  // Inverted layout starts at the newest message without measuring or scrolling
  // through older Markdown. Never mutate the shared chronological snapshot.
  const newestFirstMessages = useMemo(
    () => [...snapshot.messages].reverse(),
    [snapshot.messages],
  );

  const changeDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    void saveChatDraft(draftKey, value).catch((err) =>
      setError(`Could not save your draft: ${err}`),
    );
  };

  const speech = useSpeech(profileId, projectId, chatPath, threadId, (text) => {
    const before = draftRef.current;
    changeDraft(`${before}${before && !/\s$/.test(before) ? " " : ""}${text}`);
  });
  const live = useLiveVoice(profileId, projectId, threadId, client, snapshot);
  const speechBusy = speech.state.phase !== "idle" || live.phase !== "idle";

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
        setStatus("Paused · reconnecting when you return");
        generation.current += 1;
        if (!isPreviewProfile(profileId))
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
        if (!isPreviewProfile(profileId))
          peekActiveSiteSession()?.projectHosts.invalidateProject(projectId);
        void connect();
      }
    });
    return () => {
      subscription.remove();
      unsubscribeNetwork();
    };
  }, [connect, disconnect, profileId, projectId, snapshot.connection]);

  const selectedThread = snapshot.threads.find(
    (thread) => thread.thread_id === threadId,
  );
  const canSend =
    !!client &&
    (!speechBusy || speech.state.phase === "speaking") &&
    snapshot.ready &&
    snapshot.connection === "connected" &&
    draftLoaded &&
    !submitting &&
    !!draft.trim() &&
    (selectedThread?.agent_kind === "acp" ||
      selectedThread?.acp_config != null);

  const send = async (guidance = false) => {
    const activeClient = clientRef.current;
    const text = draft.trim();
    if (!activeClient || !canSend || !text) return;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setSubmitting(true);
    setError(undefined);
    try {
      if (!isPreviewProfile(profileId)) {
        const session = await getActiveSiteSession(profileId);
        await ensureProjectRunning(session, projectId, setStatus);
      }
      await (
        guidance
          ? activeClient.sendGuidanceToCodexThread.bind(activeClient)
          : activeClient.sendToExistingCodexThread.bind(activeClient)
      )({
        thread_id: threadId,
        text,
      });
      // Clear the submitted draft even if its screen closed during admission,
      // but never remove a newer draft created in a reopened conversation.
      await clearChatDraftIfUnchanged(draftKey, draft).catch((err) => {
        if (clientRef.current === activeClient)
          setError(
            `Message accepted, but the saved draft could not be cleared. Do not resend it. ${err}`,
          );
      });
      if (clientRef.current !== activeClient) return;
      setDraft("");
      setStatus(
        guidance ? "Guidance accepted by Codex" : "Prompt accepted by Codex",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
      setStatus(
        "Could not confirm submission. Check the conversation before sending again.",
      );
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
    if (isPreviewProfile(profileId)) {
      setError("Browser chat is unavailable in local preview.");
      return;
    }
    try {
      const session = await getActiveSiteSession(profileId);
      await Linking.openURL(
        `${projectWebUrl(session.profile, projectId, chatPath)}#thread=${encodeURIComponent(threadId)}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };

  const running = selectedThread?.state === "running";
  const loadOlder = async () => {
    const activeClient = clientRef.current;
    if (!activeClient?.loadOlderMessages || loadingOlder) return;
    setLoadingOlder(true);
    try {
      await activeClient.loadOlderMessages(
        (snapshot.message_window?.limit ?? 30) + 30,
      );
    } catch (err) {
      setError(`Could not load earlier messages: ${err}`);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title: `${params.title || "Codex"}`,
        }}
      />
      {settingsOpen && client && (
        <ChatSettings
          profile={profileId}
          project={projectId}
          thread={threadId}
          config={selectedThread?.acp_config}
          client={client}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={headerHeight}
        style={styles.flex}
      >
        <View style={styles.statusBar}>
          <Text accessibilityLiveRegion="polite" style={styles.statusText}>
            {snapshot.connection === "connected"
              ? `${status} · ${selectedThread?.state ?? "idle"}`
              : status}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Agent settings"
            disabled={!client || !snapshot.ready}
            onPress={() => setSettingsOpen(true)}
            style={{ padding: 12, minHeight: 44 }}
          >
            <Text style={styles.smallLink}>Settings</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Open chat in browser"
            accessibilityRole="button"
            onPress={() => void openBrowser()}
          >
            <Text style={styles.smallLink}>Web</Text>
          </Pressable>
        </View>
        {client && snapshot.ready && (
          <PaymentSummary
            profile={profileId}
            project={projectId}
            config={selectedThread?.acp_config}
            onPress={() => setSettingsOpen(true)}
          />
        )}
        {error ? (
          <View style={styles.errorBox}>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <Pressable
              accessibilityLabel="Retry chat connection"
              accessibilityRole="button"
              onPress={() => {
                if (!draftLoaded) setDraftRevision((n) => n + 1);
                void connect();
              }}
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
          style={styles.flex}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={styles.messages}
          key={threadId}
          inverted
          initialNumToRender={3}
          maxToRenderPerBatch={3}
          windowSize={5}
          maintainVisibleContentPosition={{
            minIndexForVisible: 0,
            autoscrollToTopThreshold: 80,
          }}
          data={newestFirstMessages}
          keyExtractor={(item) => item.message_id}
          ListFooterComponent={
            snapshot.message_window?.has_older ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load earlier messages"
                accessibilityState={{ disabled: loadingOlder }}
                disabled={loadingOlder}
                onPress={() => void loadOlder()}
                style={{ padding: 16 }}
              >
                <Text style={styles.link}>
                  {loadingOlder ? "Loading…" : "Load earlier messages"}
                </Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            snapshot.ready ? (
              <Text style={styles.emptyText}>No messages in this thread.</Text>
            ) : null
          }
          ref={listRef}
          renderItem={({ item }) => (
            <MarkdownImageContext.Provider value={resolveImage}>
              <Message
                item={item}
                speechBusy={speechBusy}
                read={(item) =>
                  void speech.controller.read(item.content, item.message_id)
                }
              />
            </MarkdownImageContext.Provider>
          )}
        />
        <View style={styles.composer}>
          <LiveVoiceControls
            live={live}
            disabled={
              speech.state.phase !== "idle" ||
              submitting ||
              snapshot.connection !== "connected"
            }
          />
          {speech.state.error ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {speech.state.error}
            </Text>
          ) : null}
          {speech.state.phase !== "idle" ? (
            <View style={styles.actions}>
              <Text accessibilityLiveRegion="polite" style={styles.statusText}>
                {speech.state.phase === "recording"
                  ? "Recording · up to 90 seconds"
                  : speech.state.phase === "transcribing"
                    ? "Transcribing…"
                    : speech.state.phase === "speaking"
                      ? "Read-aloud · preparing or playing"
                      : "Preparing microphone…"}
              </Text>
              {speech.state.phase === "recording" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Finish dictation"
                  onPress={() => void speech.controller.finish()}
                  style={styles.messageAction}
                >
                  <Text style={styles.link}>Finish</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  speech.state.phase === "speaking"
                    ? "Stop read-aloud"
                    : "Cancel dictation"
                }
                onPress={speech.controller.cancel}
                style={styles.messageAction}
              >
                <Text style={styles.link}>
                  {speech.state.phase === "speaking" ? "Stop" : "Cancel"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {live.phase === "idle" ? (
            <TextInput
              accessibilityLabel="Message Codex"
              editable={draftLoaded && !submitting}
              multiline
              onChangeText={changeDraft}
              placeholder="Message Codex"
              placeholderTextColor={colors.muted}
              style={styles.input}
              value={draft}
            />
          ) : null}
          <View style={styles.actions}>
            {live.phase === "idle" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dictate message"
                accessibilityState={{
                  disabled: speechBusy || !draftLoaded || submitting,
                }}
                disabled={speechBusy || !draftLoaded || submitting}
                onPress={() => void speech.controller.start()}
                style={styles.messageAction}
              >
                <Text style={styles.link}>Dictate</Text>
              </Pressable>
            ) : null}
            {running && live.phase === "idle" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send guidance to running agent"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={() => void send(true)}
                style={{ padding: 12 }}
              >
                <Text style={styles.link}>Guide</Text>
              </Pressable>
            ) : null}
            {running ? (
              <Pressable
                accessibilityLabel="Interrupt Codex turn"
                accessibilityRole="button"
                disabled={interrupting || !client}
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
            {live.phase === "idle" ? (
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
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: AppearancePalette) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.page },
    flex: { flex: 1 },
    statusBar: {
      alignItems: "center",
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    statusText: { color: colors.secondary, flex: 1, fontSize: 13 },
    loader: { flex: 1 },
    messages: { gap: 10, padding: 12 },
    message: { borderRadius: 12, gap: 8, maxWidth: "94%", padding: 12 },
    humanMessage: {
      alignSelf: "flex-end",
      backgroundColor: colors.inset,
    },
    agentMessage: {
      alignSelf: "flex-start",
    },
    messageActions: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
    messageAction: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 4,
    },
    messageHeader: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    runningBadge: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    runningText: { color: colors.secondary, fontSize: 12, fontWeight: "600" },
    activity: {
      borderLeftColor: colors.border,
      borderLeftWidth: 3,
      paddingLeft: 10,
    },
    activityStatus: {
      color: colors.secondary,
      fontSize: 13,
    },
    activityError: { color: colors.danger, fontSize: 13 },
    messageRole: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700",
    },
    messageState: { color: colors.secondary, fontSize: 13 },
    smallLink: { color: colors.link, fontSize: 13, fontWeight: "600" },
    link: { color: colors.link, fontSize: 15, fontWeight: "600" },
    emptyText: {
      color: colors.secondary,
      fontSize: 16,
      padding: 24,
      textAlign: "center",
    },
    errorBox: { gap: 6, padding: 12 },
    errorText: { color: colors.danger, fontSize: 14 },
    composer: {
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 8,
      padding: 10,
    },
    input: {
      backgroundColor: colors.inset,
      borderRadius: 12,
      color: colors.text,
      fontSize: 16,
      maxHeight: 150,
      minHeight: 46,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      justifyContent: "flex-end",
    },
    sendButton: {
      backgroundColor: colors.primary,
      borderRadius: 9,
      minHeight: 48,
      paddingHorizontal: 18,
      paddingVertical: 10,
    },
    sendText: {
      color: colors.onPrimary,
      fontSize: 15,
      fontWeight: "700",
    },
    interruptButton: {
      borderColor: colors.danger,
      borderRadius: 9,
      borderWidth: 1,
      minHeight: 48,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    interruptText: { color: colors.danger, fontSize: 15, fontWeight: "600" },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.72 },
  });
