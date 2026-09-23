/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { createRemoteHeadlessChatClient } from "@cocalc/chat-client";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import type { FilesystemClient } from "@cocalc/conat/files/fs";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";
import * as Crypto from "expo-crypto";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createNamedAgent, type PendingAgentCreation } from "../agents/create";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { openProjectHost } from "../cocalc/site-session";
import { usePalette } from "../ui/palette";

const PAGE_SIZE = 50;
type Project = Pick<
  AccountProjectListWindowRow,
  "project_id" | "title" | "host_id"
>;

export default function NewAgentScreen() {
  const params = useLocalSearchParams<{
    profile?: string;
    projectId?: string;
    host?: string;
    title?: string;
  }>();
  const profile = `${params.profile ?? ""}`;
  const colors = usePalette();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState(
    DEFAULT_PROJECT_RUNTIME_HOME,
  );
  const [project, setProject] = useState<Project | undefined>(
    params.projectId
      ? {
          project_id: `${params.projectId}`,
          title: `${params.title || "Project"}`,
          host_id: params.host ? `${params.host}` : null,
        }
      : undefined,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [hasMoreProjects, setHasMoreProjects] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [projectError, setProjectError] = useState<string>();
  const pending = useRef<PendingAgentCreation | undefined>(undefined);
  const inFlight = useRef(false);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadProjects = useCallback(
    async (offset: number) => {
      const current = ++requestGeneration.current;
      setLoadingProjects(true);
      setProjectError(undefined);
      try {
        const session = await getActiveSiteSession(profile);
        const page = await session.hubApi.projects.listAccountProjectWindow({
          limit: PAGE_SIZE,
          offset,
          hidden: false,
          search: search || undefined,
          sort: "last_edited",
        });
        if (current !== requestGeneration.current) return;
        setProjects((existing) =>
          offset === 0 ? page : [...existing, ...page],
        );
        setHasMoreProjects(page.length === PAGE_SIZE);
      } catch (err) {
        if (current === requestGeneration.current)
          setProjectError(err instanceof Error ? err.message : `${err}`);
      } finally {
        if (current === requestGeneration.current) setLoadingProjects(false);
      }
    },
    [profile, search],
  );

  useEffect(() => {
    void loadProjects(0);
    return () => {
      requestGeneration.current++;
    };
  }, [loadProjects]);

  const create = async () => {
    if (inFlight.current) return;
    setError(undefined);
    let normalizedName: string;
    try {
      normalizedName = normalizeAgentName(name);
    } catch {
      setError(
        "Use 1–32 letters, digits, or internal hyphens; start with a letter.",
      );
      return;
    }
    if (!project?.host_id) {
      setError("Choose a project with an available project host.");
      return;
    }
    if (!workingDirectory.trim().startsWith("/")) {
      setError("Choose an absolute working directory in this project.");
      return;
    }
    const target = project;
    if (pending.current && pending.current.projectId !== target.project_id) {
      setError(
        "Retry creation in the original project, or return and start a new agent.",
      );
      return;
    }
    inFlight.current = true;
    setCreating(true);
    try {
      const session = await getActiveSiteSession(profile);
      const lease = await openProjectHost(session, {
        project_id: target.project_id,
        host_id: target.host_id || "",
      });
      pending.current ??= {
        projectId: target.project_id,
        path: `${DEFAULT_PROJECT_RUNTIME_HOME}/.local/share/cocalc/agents/${Crypto.randomUUID()}.chat`,
        threadId: Crypto.randomUUID(),
      };
      const files = lease.client.call<
        Pick<FilesystemClient, "exists" | "mkdir" | "stat" | "writeFile">
      >(`fs.project-${target.project_id}`, { timeout: 30000 });
      const chat = createRemoteHeadlessChatClient({
        account_id: session.profile.account_id,
        project_id: target.project_id,
        path: pending.current.path,
        selected_thread_id: pending.current.threadId,
        projectHostClient: lease.client,
      });
      await createNamedAgent({
        agentApi: session.hubApi.agent,
        files,
        chat,
        pending: pending.current,
        name: normalizedName,
        description,
        projectTitle: target.title,
        workingDirectory,
      });
      router.replace({
        pathname: "/project/[projectId]/chat",
        params: {
          profile,
          projectId: target.project_id,
          chatPath: pending.current.path,
          thread: pending.current.threadId,
          title: name.trim(),
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  };

  const fieldStyle = {
    color: colors.text,
    backgroundColor: colors.inset,
    borderColor: colors.controlBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
  } as const;
  return (
    <SafeAreaView
      edges={["bottom"]}
      style={{ flex: 1, backgroundColor: colors.page }}
    >
      <Stack.Screen options={{ title: "New Agent" }} />
      <ScrollView
        contentContainerStyle={{ padding: 20, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: colors.secondary, fontSize: 16 }}>
          Create an agent in one of your projects. You can set its payment
          source and model in chat Settings before sending the first message.
        </Text>
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.text, fontWeight: "600" }}>Name</Text>
          <TextInput
            accessibilityLabel="Agent name"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!creating}
            onChangeText={setName}
            placeholder="e.g. research"
            placeholderTextColor={colors.muted}
            style={fieldStyle}
            value={name}
          />
          <Text style={{ color: colors.secondary }}>
            Letters, digits, and hyphens. This is also the agent’s handle.
          </Text>
        </View>
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.text, fontWeight: "600" }}>Project</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose project"
            accessibilityState={{ disabled: creating }}
            disabled={creating}
            onPress={() => setPickerOpen(true)}
            style={fieldStyle}
          >
            <Text style={{ color: colors.text }}>
              {project
                ? project.title
                : loadingProjects
                  ? "Loading projects…"
                  : "Choose a project"}
            </Text>
          </Pressable>
          {project && !project.host_id ? (
            <Text style={{ color: colors.danger }}>
              Open this project in CoCalc first to assign a project host.
            </Text>
          ) : null}
        </View>
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.text, fontWeight: "600" }}>
            Description (optional)
          </Text>
          <TextInput
            accessibilityLabel="Agent description"
            editable={!creating}
            onChangeText={setDescription}
            placeholder="What is this agent for?"
            placeholderTextColor={colors.muted}
            style={fieldStyle}
            value={description}
          />
        </View>
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.text, fontWeight: "600" }}>
            Working directory
          </Text>
          <TextInput
            accessibilityLabel="Working directory"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!creating}
            onChangeText={setWorkingDirectory}
            style={fieldStyle}
            value={workingDirectory}
          />
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.danger }}>
            {error}
          </Text>
        ) : null}
        {projectError ? (
          <Text accessibilityRole="alert" style={{ color: colors.danger }}>
            Could not load projects: {projectError}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            pending.current ? "Retry creating agent" : "Create agent"
          }
          accessibilityState={{ disabled: creating || !project?.host_id }}
          disabled={creating || !project?.host_id}
          onPress={() => void create()}
          style={{
            backgroundColor: colors.link,
            borderRadius: 10,
            padding: 14,
            alignItems: "center",
            opacity: creating || !project?.host_id ? 0.5 : 1,
          }}
        >
          {creating ? (
            <ActivityIndicator
              color={colors.page}
              accessibilityLabel="Creating agent"
            />
          ) : (
            <Text
              style={{ color: colors.page, fontSize: 16, fontWeight: "700" }}
            >
              {pending.current ? "Retry creation" : "Create agent"}
            </Text>
          )}
        </Pressable>
      </ScrollView>
      <Modal
        animationType="slide"
        onRequestClose={() => setPickerOpen(false)}
        presentationStyle="pageSheet"
        visible={pickerOpen}
      >
        <SafeAreaView
          style={{ flex: 1, backgroundColor: colors.page, padding: 16 }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 16,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ color: colors.text, fontSize: 22, fontWeight: "700" }}
            >
              Choose project
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close project picker"
              onPress={() => setPickerOpen(false)}
            >
              <Text style={{ color: colors.link, fontSize: 16 }}>Done</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Search projects"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder="Search projects"
            placeholderTextColor={colors.muted}
            style={fieldStyle}
            value={query}
          />
          {projectError ? (
            <Text
              accessibilityRole="alert"
              style={{ color: colors.danger, marginTop: 12 }}
            >
              {projectError}
            </Text>
          ) : null}
          <FlatList
            data={projects}
            keyExtractor={(item) => item.project_id}
            keyboardShouldPersistTaps="handled"
            onEndReached={() => {
              if (!loadingProjects && hasMoreProjects)
                void loadProjects(projects.length);
            }}
            ListEmptyComponent={
              loadingProjects ? (
                <ActivityIndicator accessibilityLabel="Loading projects" />
              ) : (
                <Text style={{ color: colors.secondary, marginTop: 16 }}>
                  No projects found.
                </Text>
              )
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Select ${item.title}${item.host_id ? "" : ", unavailable"}`}
                accessibilityState={{
                  disabled: !item.host_id,
                  selected: item.project_id === project?.project_id,
                }}
                disabled={!item.host_id}
                onPress={() => {
                  setProject(item);
                  setPickerOpen(false);
                }}
                style={{
                  paddingVertical: 14,
                  borderBottomColor: colors.border,
                  borderBottomWidth: 1,
                  opacity: item.host_id ? 1 : 0.5,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 16 }}>
                  {item.title}
                </Text>
                {!item.host_id ? (
                  <Text style={{ color: colors.secondary }}>
                    No project host yet
                  </Text>
                ) : null}
              </Pressable>
            )}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
