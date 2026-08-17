/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import {
  AgentSessionIndex,
  type AgentSessionRecord,
} from "@cocalc/chat-client";
import { COLORS } from "@cocalc/util/theme";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  PlatformColor,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getActiveSiteSession } from "../../../cocalc/session-registry";
import { openProjectHost } from "../../../cocalc/site-session";
import { projectWebUrl } from "../../../cocalc/web-links";

const ACTIVE_STATUS = new Set(["active", "running"]);

function sortSessions(records: AgentSessionRecord[]): AgentSessionRecord[] {
  return [...records].sort((a, b) => {
    const active =
      Number(ACTIVE_STATUS.has(b.status)) - Number(ACTIVE_STATUS.has(a.status));
    if (active) return active;
    return new Date(b.updated_at).valueOf() - new Date(a.updated_at).valueOf();
  });
}

export default function ProjectAgentsScreen() {
  const params = useLocalSearchParams<{
    projectId?: string;
    profile?: string;
    host?: string;
    title?: string;
  }>();
  const projectId = `${params.projectId ?? ""}`;
  const profileId = `${params.profile ?? ""}`;
  const hostId = `${params.host ?? ""}`;
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const indexRef = useRef<AgentSessionIndex | undefined>(undefined);
  const generation = useRef(0);

  const closeIndex = useCallback(() => {
    indexRef.current?.close();
    indexRef.current = undefined;
  }, []);

  const load = useCallback(async () => {
    const current = ++generation.current;
    closeIndex();
    setError(undefined);
    if (!projectId || !profileId || !hostId) {
      setError(
        !hostId
          ? "This project is not assigned to a project host yet. Open it in the browser once, then retry."
          : "The project route is incomplete.",
      );
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const session = await getActiveSiteSession(profileId);
      const lease = await openProjectHost(session, {
        project_id: projectId,
        host_id: hostId,
      });
      if (current !== generation.current) return;
      const index = new AgentSessionIndex({
        client: lease.client,
        project_id: projectId,
      });
      indexRef.current = index;
      index.subscribe((records) => setSessions(sortSessions(records)));
      await index.open();
    } catch (err) {
      if (current === generation.current) {
        setError(err instanceof Error ? err.message : `${err}`);
      }
    } finally {
      if (current === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [closeIndex, hostId, profileId, projectId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      closeIndex();
    };
  }, [closeIndex, load]);

  const openBrowser = async (path?: string) => {
    try {
      const session = await getActiveSiteSession(profileId);
      await Linking.openURL(projectWebUrl(session.profile, projectId, path));
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };

  const openChat = (item: AgentSessionRecord) => {
    router.push({
      pathname: "/project/[projectId]/chat",
      params: {
        projectId,
        profile: profileId,
        host: hostId,
        chatPath: item.chat_path,
        thread: item.thread_key,
        title: item.title || "Codex chat",
      },
    });
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title: `${params.title || "Project"} agents`,
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={sessions.length ? styles.list : styles.empty}
        data={sessions}
        keyExtractor={(item) => `${item.chat_path}:${item.thread_key}`}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
          />
        }
        ListHeaderComponent={
          error ? (
            <View style={styles.notice}>
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
              <Pressable
                accessibilityLabel="Retry loading agent sessions"
                accessibilityRole="button"
                onPress={() => void load()}
              >
                <Text style={styles.link}>Retry</Text>
              </Pressable>
            </View>
          ) : null
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator accessibilityLabel="Loading agent sessions" />
          ) : (
            <View style={styles.notice}>
              <Text accessibilityRole="header" style={styles.emptyTitle}>
                No indexed agent sessions
              </Text>
              <Text style={styles.secondary}>
                This first mobile slice opens existing Codex sessions. Create
                the first one in the web app, then pull to refresh.
              </Text>
              <Pressable
                accessibilityLabel="Open project in browser"
                accessibilityRole="button"
                onPress={() => void openBrowser()}
              >
                <Text style={styles.link}>Open project in browser</Text>
              </Pressable>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityLabel={`Open ${item.title || "Codex session"}, ${item.status}`}
            accessibilityRole="button"
            onPress={() => openChat(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowHeader}>
              <Text numberOfLines={1} style={styles.title}>
                {item.title || "Codex session"}
              </Text>
              <Text
                style={[
                  styles.status,
                  ACTIVE_STATUS.has(item.status) && styles.active,
                ]}
              >
                {item.status}
              </Text>
            </View>
            <Text numberOfLines={1} style={styles.secondary}>
              {[item.model, item.reasoning].filter(Boolean).join(" · ") ||
                item.chat_path}
            </Text>
            <Text style={styles.date}>
              Updated {new Date(item.updated_at).toLocaleString()}
            </Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PlatformColor("systemBackground") },
  list: { paddingBottom: 24 },
  empty: { flexGrow: 1, justifyContent: "center" },
  notice: { gap: 10, padding: 24 },
  emptyTitle: {
    color: PlatformColor("label"),
    fontSize: 20,
    fontWeight: "600",
  },
  error: { color: COLORS.BS_RED, fontSize: 15 },
  link: { color: COLORS.ANTD_LINK_BLUE, fontSize: 16, fontWeight: "600" },
  row: {
    borderTopColor: PlatformColor("separator"),
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowHeader: { alignItems: "center", flexDirection: "row", gap: 10 },
  title: {
    color: PlatformColor("label"),
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
  },
  status: { color: PlatformColor("secondaryLabel"), fontSize: 13 },
  active: { color: COLORS.BS_GREEN_D },
  secondary: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 14,
    lineHeight: 20,
  },
  date: { color: PlatformColor("tertiaryLabel"), fontSize: 12 },
  pressed: { backgroundColor: PlatformColor("systemGray6") },
});
