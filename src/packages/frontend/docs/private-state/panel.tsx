/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  CheckCircleFilled,
  CheckCircleOutlined,
  EditOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import type { DocsEntry } from "@cocalc/docs";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { COLORS } from "@cocalc/util/theme";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Flex,
  Popconfirm,
  Space,
  Typography,
} from "antd";
import { useEffect, useState } from "react";

import type { DocsPageNoteV1, DocsPrivateEntrySummary } from "./types";

const { Text } = Typography;

function NoteEditor({
  autoFocus,
  initialValue = "",
  onCancel,
  onSave,
}: {
  autoFocus?: boolean;
  initialValue?: string;
  onCancel?: () => void;
  onSave: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();
  return (
    <Flex gap={8} vertical>
      <MarkdownInput
        autoFocus={autoFocus}
        autoGrow
        autoGrowMaxHeight={180}
        cacheId={`docs-private-note:${initialValue}`}
        compact
        enableMentions={false}
        enableUpload={false}
        fontSize={14}
        hideHelp
        minimal
        onChange={setValue}
        onShiftEnter={(next) => {
          if (next.trim()) {
            void onSave(next);
          }
        }}
        placeholder="Private note for this docs page"
        redoMode="local"
        undoMode="local"
        value={value}
      />
      <Space>
        <Button
          disabled={!trimmed}
          loading={saving}
          onClick={async () => {
            if (!trimmed) return;
            setSaving(true);
            try {
              await onSave(value);
              setValue("");
            } finally {
              setSaving(false);
            }
          }}
          size="small"
          type="primary"
        >
          Save note
        </Button>
        {onCancel != null ? (
          <Button disabled={saving} onClick={onCancel} size="small">
            Cancel
          </Button>
        ) : null}
      </Space>
    </Flex>
  );
}

export function DocsPrivateNotesPanel({
  accountId,
  entry,
  error,
  loading,
  markViewed,
  notes,
  onDeleteNote,
  onSaveNote,
  onToggleStar,
  summary,
}: {
  accountId?: string;
  entry: DocsEntry;
  error?: string;
  loading?: boolean;
  markViewed: (entry: DocsEntry) => void | Promise<void>;
  notes: DocsPageNoteV1[];
  onDeleteNote: (note: DocsPageNoteV1) => void | Promise<void>;
  onSaveNote: (
    entry: DocsEntry,
    body: string,
    note?: DocsPageNoteV1,
  ) => void | Promise<void>;
  onToggleStar: (entry: DocsEntry) => void | Promise<void>;
  summary?: DocsPrivateEntrySummary;
}) {
  const [editingNoteId, setEditingNoteId] = useState<string | undefined>();
  const [addingNote, setAddingNote] = useState(false);
  const starred = Boolean(summary?.starred);

  useEffect(() => {
    if (accountId) {
      void markViewed(entry);
    }
  }, [accountId, entry, markViewed]);

  if (!accountId) return null;

  return (
    <Card
      size="small"
      style={{
        background: "#fff",
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderLeft: `4px solid ${starred ? COLORS.STAR : COLORS.GRAY_L}`,
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
      }}
      title={
        <Flex align="center" justify="space-between" gap={8}>
          <Space wrap>
            <Button
              aria-label={starred ? "Unstar docs page" : "Star docs page"}
              icon={
                starred ? (
                  <StarFilled style={{ color: COLORS.STAR }} />
                ) : (
                  <StarOutlined />
                )
              }
              loading={loading}
              onClick={() => void onToggleStar(entry)}
              size="small"
            >
              {starred ? "Starred" : "Star"}
            </Button>
            {!addingNote ? (
              <Button onClick={() => setAddingNote(true)} size="small">
                Add Note
              </Button>
            ) : null}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {notes.length} note{notes.length === 1 ? "" : "s"}
          </Text>
        </Flex>
      }
    >
      <Flex gap="middle" vertical>
        {error ? (
          <Alert
            message="Private docs state is unavailable"
            description={error}
            showIcon
            type="warning"
          />
        ) : null}
        <Text type="secondary" style={{ fontSize: 12 }}>
          Private to you. Export creates a JSON backup or transfer file only
          when you choose.
        </Text>
        {addingNote ? (
          <NoteEditor
            autoFocus
            onCancel={() => setAddingNote(false)}
            onSave={async (value) => {
              await onSaveNote(entry, value);
              setAddingNote(false);
            }}
          />
        ) : null}
        {notes.length > 0 ? (
          <Flex gap="small" vertical>
            {notes.map((note) => {
              const editing = editingNoteId === note.note_id;
              return (
                <div
                  key={note.note_id}
                  style={{
                    border: `1px solid ${COLORS.GRAY_LL}`,
                    borderRadius: 6,
                    padding: 10,
                  }}
                >
                  {editing ? (
                    <NoteEditor
                      autoFocus
                      initialValue={note.body_md}
                      onCancel={() => setEditingNoteId(undefined)}
                      onSave={async (value) => {
                        await onSaveNote(entry, value, note);
                        setEditingNoteId(undefined);
                      }}
                    />
                  ) : (
                    <Flex gap={8} vertical>
                      <StaticMarkdown value={note.body_md} />
                      <Space>
                        <Button
                          icon={<EditOutlined />}
                          onClick={() => setEditingNoteId(note.note_id)}
                          size="small"
                        >
                          Edit
                        </Button>
                        <Popconfirm
                          okText="Delete"
                          onConfirm={() => void onDeleteNote(note)}
                          title="Delete this private note?"
                        >
                          <Button danger size="small">
                            Delete
                          </Button>
                        </Popconfirm>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          Updated {new Date(note.updated_at).toLocaleString()}
                        </Text>
                      </Space>
                    </Flex>
                  )}
                </div>
              );
            })}
          </Flex>
        ) : null}
      </Flex>
    </Card>
  );
}

export function DocsLearnedControl({
  entry,
  loading,
  onSetLearned,
  summary,
}: {
  entry: DocsEntry;
  loading?: boolean;
  onSetLearned: (entry: DocsEntry, learned: boolean) => void | Promise<void>;
  summary?: DocsPrivateEntrySummary;
}) {
  const learned = Boolean(summary?.learnedAt);
  return (
    <Card
      size="small"
      style={{
        background: learned ? COLORS.BS_GREEN_LL : "#fff",
        border: `1px solid ${learned ? COLORS.BS_GREEN : COLORS.GRAY_LL}`,
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
      }}
    >
      <Flex align="center" gap="middle" justify="space-between" wrap>
        <Checkbox
          checked={learned}
          disabled={loading}
          onChange={(event) => void onSetLearned(entry, event.target.checked)}
        >
          <Space>
            {learned ? (
              <CheckCircleFilled style={{ color: COLORS.BS_GREEN_D }} />
            ) : (
              <CheckCircleOutlined style={{ color: COLORS.GRAY_M }} />
            )}
            <Text strong>Done - I learned this page</Text>
          </Space>
        </Checkbox>
      </Flex>
      {learned && summary?.learnedAt ? (
        <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
          Marked learned {new Date(summary.learnedAt).toLocaleString()}
        </Text>
      ) : null}
    </Card>
  );
}
