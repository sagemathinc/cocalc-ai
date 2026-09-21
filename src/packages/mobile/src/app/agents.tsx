/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link,
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  loadNamedAgentWorkspace,
  saveNamedAgentOrganization,
  filterNamedAgents,
} from "@cocalc/chat-client/named-agents";
import {
  organizeAgents,
  markAgentActive,
  setAgentPinned,
  setAgentHidden,
} from "@cocalc/chat-client/agent-organization";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { usePalette } from "../ui/palette";

import {
  isPreviewProfile,
  previewWorkspace,
  savePreviewOrganization,
} from "../preview/fixtures";

type Workspace = Awaited<ReturnType<typeof loadNamedAgentWorkspace>>;

export default function AgentsScreen() {
  const { profile } = useLocalSearchParams<{ profile: string }>();
  const colors = usePalette();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const state = useRef<Workspace | undefined>(undefined);

  useEffect(() => {
    state.current = undefined;
    setWorkspace(undefined);
    setSearch("");
  }, [profile]);

  const refresh = useCallback(async () => {
    if (mutation.current) return;
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = isPreviewProfile(profile)
        ? previewWorkspace()
        : await (async () => {
            const session = await getActiveSiteSession(profile);
            return loadNamedAgentWorkspace(
              session.hubApi,
              session.profile.account_id,
            );
          })();
      if (current !== generation.current) return;
      state.current = next;
      setWorkspace(next);
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [profile]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") void refresh();
      });
      return () => {
        generation.current++;
        subscription.remove();
      };
    }, [refresh]),
  );

  const persist = async (organization: Workspace["organization"]) => {
    if (mutation.current) return;
    mutation.current = true;
    const current = ++generation.current;
    setLoading(false);
    setSaving(true);
    setError(undefined);
    try {
      if (isPreviewProfile(profile)) {
        savePreviewOrganization(organization);
      } else {
        const session = await getActiveSiteSession(profile);
        await saveNamedAgentOrganization(
          session.hubApi,
          session.profile.account_id,
          organization,
        );
      }
      if (current === generation.current && state.current) {
        const next = { ...state.current, organization };
        state.current = next;
        setWorkspace(next);
      }
    } catch (err) {
      if (current === generation.current)
        setError(
          `Could not save organization: ${err instanceof Error ? err.message : err}`,
        );
    } finally {
      mutation.current = false;
      setSaving(false);
    }
  };

  const open = (agent: NamedAgent) => {
    if (!agent.available) return;
    if (state.current)
      void persist(
        markAgentActive(state.current.organization, agent.endpoint.agent_id),
      );
    router.push({
      pathname: "/project/[projectId]/chat",
      params: {
        profile,
        projectId: agent.endpoint.project_id,
        chatPath: agent.path,
        thread: agent.thread_id,
        title: agent.name,
      },
    });
  };
  const groups = workspace
    ? organizeAgents(workspace.directory.agents, workspace.organization)
    : undefined;
  const pinned = new Set(
    groups?.pinned.map((agent) => agent.endpoint.agent_id),
  );
  const rows = filterNamedAgents(
    showHidden
      ? (groups?.hidden ?? [])
      : [...(groups?.pinned ?? []), ...(groups?.unpinned ?? [])],
    search,
  );
  const openWebAgents = async () => {
    if (isPreviewProfile(profile)) {
      setError("Browser management is unavailable in local preview.");
      return;
    }
    try {
      const session = await getActiveSiteSession(profile);
      await Linking.openURL(
        `${session.profile.canonical_app_url.replace(/\/+$/, "")}/agents`,
      );
    } catch (err) {
      setError(`Could not open Agents in the browser: ${err}`);
    }
  };
  return (
    <SafeAreaView
      edges={["bottom"]}
      style={[styles.page, { backgroundColor: colors.page }]}
    >
      <Stack.Screen
        options={{
          title: isPreviewProfile(profile)
            ? "My Agents · Preview"
            : "My Agents",
          headerRight: () => (
            <Link
              href="/transport"
              accessibilityLabel="Manage accounts"
              style={{ color: colors.link }}
            >
              Accounts
            </Link>
          ),
        }}
      />
      <View style={[styles.row, { borderColor: colors.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            showHidden ? "Show active agents" : "Show hidden agents"
          }
          onPress={() => setShowHidden(!showHidden)}
          style={styles.button}
        >
          <Text style={{ color: colors.link }}>
            {showHidden ? "Active agents" : "Hidden agents"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Manage agents in browser"
          onPress={() => void openWebAgents()}
          style={styles.button}
        >
          <Text style={{ color: colors.link }}>Manage in web</Text>
        </Pressable>
      </View>
      <TextInput
        accessibilityLabel="Search agents"
        placeholder="Search agents"
        placeholderTextColor={colors.muted}
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
        style={[
          styles.search,
          {
            color: colors.text,
            backgroundColor: colors.inset,
            borderColor: colors.controlBorder,
          },
        ]}
      />
      {error ? (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={{ color: colors.danger }}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading agents"
            onPress={() => void refresh()}
            style={styles.button}
          >
            <Text style={{ color: colors.link }}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(agent) => agent.endpoint.agent_id}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void refresh()}
          />
        }
        contentContainerStyle={rows.length ? undefined : styles.empty}
        ListEmptyComponent={
          loading && !workspace ? (
            <ActivityIndicator accessibilityLabel="Loading agents" />
          ) : (
            <Text style={{ color: colors.secondary }}>
              {workspace?.directory.enabled === false
                ? "Agents are not enabled for this account."
                : search
                  ? "No agents match your search."
                  : "No visible named agents yet. Create or restore an agent in the web Agents workspace."}
            </Text>
          )
        }
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: colors.border }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}${item.available ? "" : ", unavailable"}`}
              accessibilityState={{ disabled: !item.available }}
              disabled={!item.available}
              onPress={() => open(item)}
              style={styles.agent}
            >
              <Text style={[styles.name, { color: colors.text }]}>
                {item.name}
              </Text>
              {item.description ? (
                <Text numberOfLines={2} style={{ color: colors.secondary }}>
                  {item.description}
                </Text>
              ) : null}
              <Text style={{ color: colors.muted }}>
                {item.project_title || "Project"}
                {!item.available ? " · Unavailable" : ""}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Manage ${item.name}`}
              onPress={() => {
                if (isPreviewProfile(profile)) {
                  setError("Agent settings are unavailable in local preview.");
                  return;
                }
                router.push({
                  pathname: "/agent-details",
                  params: {
                    profile,
                    agentId: item.endpoint.agent_id,
                    projectId: item.endpoint.project_id,
                  },
                });
              }}
              style={styles.button}
            >
              <Text style={{ color: colors.link }}>Details</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${showHidden ? "Restore" : pinned.has(item.endpoint.agent_id) ? "Unpin" : "Pin"} ${item.name}`}
              accessibilityState={{ disabled: saving }}
              disabled={saving}
              onPress={() => {
                if (state.current)
                  void persist(
                    (showHidden ? setAgentHidden : setAgentPinned)(
                      state.current.directory.agents,
                      state.current.organization,
                      item.endpoint.agent_id,
                      showHidden ? false : !pinned.has(item.endpoint.agent_id),
                    ),
                  );
              }}
              style={styles.button}
            >
              <Text style={{ color: colors.link }}>
                {showHidden
                  ? "Restore"
                  : pinned.has(item.endpoint.agent_id)
                    ? "Unpin"
                    : "Pin"}
              </Text>
            </Pressable>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1 },
  search: {
    margin: 16,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
    fontSize: 17,
  },
  notice: { paddingHorizontal: 16 },
  empty: { flexGrow: 1, justifyContent: "center", padding: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
  },
  agent: { flex: 1, gap: 6, paddingVertical: 18 },
  name: { fontSize: 18, fontWeight: "600" },
  button: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    padding: 8,
  },
});
