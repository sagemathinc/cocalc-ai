/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo, useRef, useState } from "react";

import { Button, Flex, message, Space, Typography, Upload } from "antd";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import type { DocsAccess, DocsEntry } from "@cocalc/docs";
import { getDocsEntry, listDocsEntries } from "@cocalc/docs";
import {
  DocsBrowser,
  DocsFontSizeFrame,
  DOCS_BROWSER_FLYOUT_STYLE,
  DOCS_BROWSER_MUTED_TITLE_STYLE,
  DOCS_BROWSER_PAGE_STYLE,
  type DocsBrowserAction,
} from "@cocalc/frontend/docs/browser";
import { DocsPrivateNotesPanel } from "@cocalc/frontend/docs/private-state/panel";
import {
  exportDocsPrivateStateBundle,
  importDocsPrivateStateBundle,
} from "@cocalc/frontend/docs/private-state/store";
import type { DocsPrivateFilter } from "@cocalc/frontend/docs/private-state/types";
import { useDocsPrivateState } from "@cocalc/frontend/docs/private-state/use-docs-private-state";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import {
  listDocsAppActions,
  revealDocsAction,
} from "@cocalc/frontend/project/docs-actions";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;
const PROJECT_DOCS_SELECTED_STORAGE_PREFIX =
  "cocalc-project-docs-selected-slug:";

function projectDocsStorageKey(projectId: string): string {
  return `${PROJECT_DOCS_SELECTED_STORAGE_PREFIX}${projectId}`;
}

function loadStoredProjectDocsEntry({
  docsAccess,
  projectId,
}: {
  docsAccess: DocsAccess;
  projectId: string;
}): DocsEntry | undefined {
  if (typeof window === "undefined") return undefined;
  const storedSlug = window.localStorage
    .getItem(projectDocsStorageKey(projectId))
    ?.trim();
  return storedSlug ? getDocsEntry(storedSlug, docsAccess) : undefined;
}

function saveStoredProjectDocsEntry({
  entry,
  projectId,
}: {
  entry?: DocsEntry;
  projectId: string;
}): void {
  if (typeof window === "undefined") return;
  const key = projectDocsStorageKey(projectId);
  if (entry?.slug) {
    window.localStorage.setItem(key, entry.slug);
  } else {
    window.localStorage.removeItem(key);
  }
}

export function ProjectDocsPanel({
  layout,
  project_id,
}: {
  layout: "flyout" | "page";
  project_id: string;
}) {
  const [messageApi, contextHolder] = message.useMessage();
  const [privateFilter, setPrivateFilter] = useState<DocsPrivateFilter>("all");
  const importBusyRef = useRef(false);
  const accountFontSize =
    useTypedRedux("account", "font_size") ?? DEFAULT_FONT_SIZE;
  const accountId = `${useTypedRedux("account", "account_id") ?? ""}`.trim();
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const docsAccess = useMemo<DocsAccess>(
    () => ({ includeAdmin: isAdmin, includeSignedIn: !!accountId }),
    [accountId, isAdmin],
  );
  const docsPrivateState = useDocsPrivateState(accountId);
  const actionAvailability = useMemo(
    () => listDocsAppActions({ includeAdmin: isAdmin, projectId: project_id }),
    [isAdmin, project_id],
  );
  const allDocsEntries = useMemo(
    () => listDocsEntries(docsAccess),
    [docsAccess],
  );
  const initialEntry = useMemo(
    () =>
      loadStoredProjectDocsEntry({
        docsAccess,
        projectId: project_id,
      }),
    [docsAccess, project_id],
  );

  async function runAction(action: DocsBrowserAction): Promise<void> {
    try {
      await revealDocsAction({ actionId: action.id, projectId: project_id });
      await messageApi.success(action.label);
    } catch (err) {
      await messageApi.error(`${err}`);
    }
  }

  const isFlyout = layout === "flyout";
  const privateToolbar =
    accountId && layout === "page" ? (
      <Space wrap>
        <Tooltip title="Export your private docs notes and starred pages as a JSON backup or transfer file">
          <Button
            icon={<DownloadOutlined />}
            onClick={async () => {
              try {
                const bundle = await exportDocsPrivateStateBundle({
                  accountId,
                });
                const blob = new Blob([JSON.stringify(bundle, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `cocalc-docs-state-${new Date()
                  .toISOString()
                  .slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                await messageApi.success(
                  "Exported private notes and starred state.",
                );
              } catch (err) {
                await messageApi.error(`${err}`);
              }
            }}
            size="small"
          >
            Export
          </Button>
        </Tooltip>
        <Upload
          accept="application/json,.json"
          beforeUpload={async (file) => {
            if (importBusyRef.current) return Upload.LIST_IGNORE;
            importBusyRef.current = true;
            try {
              const payload = JSON.parse(await file.text());
              const result = await importDocsPrivateStateBundle({
                accountId,
                localEntries: allDocsEntries,
                payload,
              });
              await messageApi.success(
                `Imported ${result.importedPages} page state record${
                  result.importedPages === 1 ? "" : "s"
                } and ${result.importedNotes} note${
                  result.importedNotes === 1 ? "" : "s"
                }.`,
              );
            } catch (err) {
              await messageApi.error(`${err}`);
            } finally {
              importBusyRef.current = false;
            }
            return Upload.LIST_IGNORE;
          }}
          showUploadList={false}
        >
          <Tooltip title="Import private docs notes and starred pages from a JSON export, merging without duplicate notes">
            <Button icon={<UploadOutlined />} size="small">
              Import
            </Button>
          </Tooltip>
        </Upload>
      </Space>
    ) : null;

  return (
    <div
      style={
        layout === "page" ? DOCS_BROWSER_PAGE_STYLE : DOCS_BROWSER_FLYOUT_STYLE
      }
    >
      {contextHolder}
      <DocsFontSizeFrame defaultFontSize={accountFontSize} layout={layout}>
        <Flex gap={isFlyout ? "small" : "middle"} vertical>
          <div>
            <Text strong style={DOCS_BROWSER_MUTED_TITLE_STYLE}>
              CoCalc docs
            </Text>
            <Title
              level={layout === "page" ? 1 : 4}
              style={{
                lineHeight: 1.15,
                marginBottom: 0,
                marginTop: isFlyout ? 4 : 8,
              }}
            >
              Help for this project
            </Title>
          </div>
          <Paragraph
            style={{
              color: COLORS.GRAY_M,
              fontSize: isFlyout ? "0.93em" : undefined,
              lineHeight: isFlyout ? 1.4 : undefined,
              marginBottom: isFlyout ? 6 : 20,
            }}
          >
            Search current CoCalc-ai docs without leaving the project. Pages
            with implemented actions can open the relevant app panel directly.
          </Paragraph>
        </Flex>
        <DocsBrowser
          actionAvailability={actionAvailability}
          docsAccess={docsAccess}
          initialEntry={initialEntry}
          layout={layout}
          onRunAction={runAction}
          onSelectedEntryChange={(entry) =>
            saveStoredProjectDocsEntry({ entry, projectId: project_id })
          }
          privateDetailState={
            accountId
              ? {
                  renderPanel: (entry) => (
                    <DocsPrivateNotesPanel
                      accountId={accountId}
                      entry={entry}
                      error={docsPrivateState.error}
                      loading={docsPrivateState.loading}
                      markViewed={docsPrivateState.markViewed}
                      notes={docsPrivateState.notesForEntry(entry.id)}
                      onDeleteNote={docsPrivateState.deleteNote}
                      onSaveNote={docsPrivateState.saveNote}
                      onToggleStar={docsPrivateState.toggleStar}
                      summary={docsPrivateState.summaries[entry.id]}
                    />
                  ),
                }
              : undefined
          }
          privateIndexState={
            accountId
              ? {
                  enabled: true,
                  filter: privateFilter,
                  onFilterChange: setPrivateFilter,
                  summaries: docsPrivateState.summaries,
                  toolbar: privateToolbar,
                }
              : undefined
          }
        />
      </DocsFontSizeFrame>
    </div>
  );
}

export function DocsFlyout({
  project_id,
  wrap,
}: {
  project_id: string;
  wrap: (
    content: React.JSX.Element,
    style?: React.CSSProperties,
  ) => React.JSX.Element;
  flyoutWidth: number;
}) {
  return wrap(<ProjectDocsPanel layout="flyout" project_id={project_id} />);
}
