/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { COLORS } from "@cocalc/util/theme";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  PlatformColor,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getActiveSiteSession } from "../cocalc/session-registry";
import {
  EMPTY_PROJECT_WINDOW,
  projectStateLabel,
  updateProjectWindow,
  type ProjectWindowState,
} from "../projects/window";

const PAGE_SIZE = 40;

export default function ProjectsScreen() {
  const params = useLocalSearchParams<{ profile?: string }>();
  const profileId = `${params.profile ?? ""}`;
  const [window, setWindow] =
    useState<ProjectWindowState>(EMPTY_PROJECT_WINDOW);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const requestGeneration = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setActiveQuery(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (replace: boolean) => {
      if (!profileId) {
        setError("No CoCalc profile was selected.");
        setLoading(false);
        return;
      }
      const generation = ++requestGeneration.current;
      replace ? setRefreshing(true) : setLoadingMore(true);
      setError(undefined);
      try {
        const session = await getActiveSiteSession(profileId);
        const offset = replace ? 0 : window.offset;
        const page = await session.hubApi.projects.listAccountProjectWindow({
          limit: PAGE_SIZE,
          offset,
          hidden: false,
          search: activeQuery || undefined,
          sort: "last_edited",
        });
        if (generation !== requestGeneration.current) return;
        setWindow((state) =>
          updateProjectWindow({
            state,
            page,
            pageSize: PAGE_SIZE,
            replace,
          }),
        );
      } catch (err) {
        if (generation === requestGeneration.current) {
          setError(err instanceof Error ? err.message : `${err}`);
        }
      } finally {
        if (generation === requestGeneration.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [activeQuery, profileId, window.offset],
  );

  useEffect(() => {
    setWindow(EMPTY_PROJECT_WINDOW);
    setLoading(true);
    void load(true);
    // The offset is intentionally not a dependency for a replacement request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQuery, profileId]);

  const openProject = (project: AccountProjectListWindowRow) => {
    router.push({
      pathname: "/project/[projectId]/agents",
      params: {
        projectId: project.project_id,
        profile: profileId,
        host: project.host_id ?? "",
        title: project.title,
      },
    });
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <Stack.Screen options={{ title: "Projects" }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={window.rows}
        keyExtractor={(item) => item.project_id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
          />
        }
        contentContainerStyle={
          window.rows.length === 0 ? styles.emptyContainer : styles.list
        }
        ListHeaderComponent={
          <View style={styles.searchContainer}>
            <TextInput
              accessibilityLabel="Search projects"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={setQuery}
              placeholder="Search projects"
              placeholderTextColor={PlatformColor("placeholderText")}
              returnKeyType="search"
              style={styles.search}
              value={query}
            />
            {error ? (
              <View style={styles.errorBox}>
                <Text accessibilityRole="alert" style={styles.errorText}>
                  {error}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading projects"
                  onPress={() => void load(true)}
                >
                  <Text style={styles.link}>Retry</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator accessibilityLabel="Loading projects" />
          ) : (
            <Text style={styles.emptyText}>
              {activeQuery
                ? "No projects match this search."
                : "No projects yet."}
            </Text>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator accessibilityLabel="Loading more projects" />
          ) : null
        }
        onEndReached={() => {
          if (window.hasMore && !loadingMore && !loading) void load(false);
        }}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open project ${item.title || "Untitled project"}, ${projectStateLabel(item)}`}
            onPress={() => openProject(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowHeader}>
              <Text numberOfLines={1} style={styles.title}>
                {item.title || "Untitled project"}
              </Text>
              <Text style={styles.state}>{projectStateLabel(item)}</Text>
            </View>
            {item.description ? (
              <Text numberOfLines={2} style={styles.description}>
                {item.description}
              </Text>
            ) : null}
            {item.last_activity_at ? (
              <Text style={styles.date}>
                Active {new Date(item.last_activity_at).toLocaleString()}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: PlatformColor("systemBackground"),
  },
  list: { paddingBottom: 24 },
  emptyContainer: { flexGrow: 1 },
  searchContainer: { gap: 10, padding: 16 },
  search: {
    backgroundColor: PlatformColor("secondarySystemBackground"),
    borderRadius: 10,
    color: PlatformColor("label"),
    fontSize: 17,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  row: {
    borderTopColor: PlatformColor("separator"),
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  title: {
    color: PlatformColor("label"),
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
  },
  state: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 13,
  },
  description: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 15,
    lineHeight: 20,
  },
  date: {
    color: PlatformColor("tertiaryLabel"),
    fontSize: 12,
  },
  emptyText: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 17,
    padding: 24,
    textAlign: "center",
  },
  errorBox: { gap: 6 },
  errorText: { color: COLORS.BS_RED, fontSize: 15 },
  link: { color: COLORS.ANTD_LINK_BLUE, fontSize: 16, fontWeight: "600" },
  pressed: { backgroundColor: PlatformColor("systemGray6") },
});
