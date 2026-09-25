/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useCallback, useRef, useState } from "react";
import {
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  normalizeAgentName,
  type NamedAgent,
} from "@cocalc/conat/agents/personal";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { usePalette } from "../ui/palette";

export default function AgentDetailsScreen() {
  const { profile, agentId, projectId } = useLocalSearchParams<{
    profile: string;
    agentId: string;
    projectId: string;
  }>();
  const colors = usePalette();
  const [agent, setAgent] = useState<NamedAgent>();
  const [identity, setIdentity] = useState<AgentIdentity>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(undefined);
    setAgent(undefined);
    setIdentity(undefined);
    try {
      const session = await getActiveSiteSession(profile);
      const [directory, nextIdentity] = await Promise.all([
        session.hubApi.agent.listNamedAgents({}),
        session.hubApi.agent.getIdentity({
          project_id: projectId,
          agent_id: agentId,
        }),
      ]);
      const next = directory.agents.find(
        (value) =>
          value.endpoint.agent_id === agentId &&
          value.endpoint.project_id === projectId,
      );
      if (!next) throw new Error("This named agent is no longer available.");
      if (generation.current !== current) return;
      setAgent(next);
      setIdentity(nextIdentity);
      setName(next.name);
      setDescription(next.description ?? "");
    } catch (err) {
      if (generation.current === current)
        setError(`${err instanceof Error ? err.message : err}`);
    }
  }, [profile, agentId, projectId]);
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        generation.current++;
      };
    }, [load]),
  );

  const save = async () => {
    if (!agent || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    const current = generation.current;
    try {
      const normalized = normalizeAgentName(name);
      const session = await getActiveSiteSession(profile);
      const next = await session.hubApi.agent.nameAgent({
        endpoint: agent.endpoint,
        name: normalized,
        description,
        project_title: agent.project_title,
        thread_title: agent.thread_title,
      });
      if (generation.current === current) {
        setAgent(next);
        setName(next.name);
      }
    } catch (err) {
      if (generation.current === current)
        setError(`${err instanceof Error ? err.message : err}`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const openThread = (thread: string, replace = false, next = identity) => {
    if (!next) return;
    const destination = {
      pathname: "/project/[projectId]/chat" as const,
      params: {
        profile,
        projectId,
        chatPath: next.path,
        thread,
        title: agent?.name ?? "Agent",
      },
    };
    if (replace) router.replace(destination);
    else router.push(destination);
  };
  const fresh = async () => {
    if (!identity || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    const current = generation.current;
    try {
      const session = await getActiveSiteSession(profile);
      const next = await session.hubApi.agent.startFreshConversation({
        project_id: projectId,
        agent_id: agentId,
        expected_thread_id: identity.thread_id,
      });
      if (generation.current === current) {
        setIdentity(next);
        openThread(next.thread_id, true, next);
      }
    } catch (err) {
      if (generation.current === current)
        setError(
          `Could not confirm the new conversation. Reload agent details before trying again. ${err instanceof Error ? err.message : err}`,
        );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const confirmFresh = () =>
    Alert.alert(
      "Start a fresh conversation?",
      "Keep this agent's identity, settings, networks, and files. Previous messages remain in conversation history but are not included in the new context. Finish or cancel running and queued work and disable scheduled work first.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Start fresh conversation", onPress: () => void fresh() },
      ],
    );
  return (
    <SafeAreaView
      edges={["bottom"]}
      style={{ flex: 1, backgroundColor: colors.page }}
    >
      <Stack.Screen
        options={{
          title: agent ? `@${agent.name}` : "Agent details",
          headerLargeTitle: false,
        }}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.container}
      >
        {error ? (
          <View>
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              {error}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reload agent details"
              disabled={busy}
              onPress={() => void load()}
              style={styles.button}
            >
              <Text style={{ color: colors.link }}>Reload</Text>
            </Pressable>
          </View>
        ) : null}
        {!agent && !error ? (
          <ActivityIndicator accessibilityLabel="Loading agent details" />
        ) : null}
        {agent ? (
          <>
            <Text style={{ color: colors.secondary }}>
              {agent.project_title || "Project"}
            </Text>
            <Text style={{ color: colors.text }}>Agent name</Text>
            <TextInput
              accessibilityLabel="Agent name"
              value={name}
              onChangeText={setName}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={32}
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.controlBorder },
              ]}
            />
            <Text style={{ color: colors.secondary }}>
              Start with a letter; use letters, numbers, and hyphens.
            </Text>
            <Text style={{ color: colors.text }}>Description</Text>
            <TextInput
              accessibilityLabel="Agent description"
              value={description}
              onChangeText={setDescription}
              editable={!busy}
              multiline
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.controlBorder },
              ]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save agent details"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void save()}
              style={[styles.button, { backgroundColor: colors.primary }]}
            >
              <Text style={{ color: colors.onPrimary }}>
                {busy ? "Working…" : "Save details"}
              </Text>
            </Pressable>
            <Text
              accessibilityRole="header"
              style={[styles.heading, { color: colors.text }]}
            >
              Conversations
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open current conversation"
              disabled={busy || !identity}
              onPress={() => identity && openThread(identity.thread_id)}
              style={styles.button}
            >
              <Text style={{ color: colors.link }}>Current conversation</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start fresh conversation"
              accessibilityState={{ disabled: busy || !identity }}
              disabled={busy || !identity}
              onPress={confirmFresh}
              style={styles.button}
            >
              <Text style={{ color: colors.link }}>
                Start fresh conversation
              </Text>
            </Pressable>
            <Text style={{ color: colors.secondary }}>
              Past conversations open without changing this agent's current
              context.
            </Text>
            {[...(identity?.conversation_history ?? [])]
              .reverse()
              .map((item) => (
                <Pressable
                  key={item.thread_id}
                  accessibilityRole="button"
                  accessibilityLabel={`Open conversation ended ${new Date(item.ended_at).toLocaleString()}`}
                  disabled={busy}
                  onPress={() => openThread(item.thread_id)}
                  style={styles.button}
                >
                  <Text style={{ color: colors.link }}>
                    Ended {new Date(item.ended_at).toLocaleString()}
                  </Text>
                </Pressable>
              ))}
            {identity && !identity.conversation_history?.length ? (
              <Text style={{ color: colors.secondary }}>
                No past conversations yet.
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    minHeight: 48,
    fontSize: 17,
  },
  heading: { fontSize: 22, fontWeight: "600", marginTop: 20 },
  button: {
    minHeight: 48,
    padding: 12,
    borderRadius: 10,
    justifyContent: "center",
  },
});
