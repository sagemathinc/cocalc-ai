/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import { Button, Flex, message, Space, Typography, Upload } from "antd";
import type { DocsAccess, DocsEntry } from "@cocalc/docs";
import { getDocsEntry, listDocsEntries } from "@cocalc/docs";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  DocsBrowser,
  DocsFontSizeFrame,
  DocsPrintContent,
  DOCS_BROWSER_MUTED_TITLE_STYLE,
  DOCS_BROWSER_PAGE_STYLE,
  type DocsBrowserAction,
  type DocsBrowserActionParameters,
} from "@cocalc/frontend/docs/browser";
import {
  DocsLearnedControl,
  DocsPrivateNotesPanel,
  DocsPrivateToolbarActions,
} from "@cocalc/frontend/docs/private-state/panel";
import {
  exportDocsPrivateStateBundle,
  importDocsPrivateStateBundle,
} from "@cocalc/frontend/docs/private-state/store";
import type { DocsPrivateFilter } from "@cocalc/frontend/docs/private-state/types";
import { useDocsPrivateState } from "@cocalc/frontend/docs/private-state/use-docs-private-state";
import {
  listDocsAppActions,
  revealDocsAction,
} from "@cocalc/frontend/project/docs-actions";
import { set_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";
import { Tooltip } from "@cocalc/frontend/components";
import {
  APP_DOCS_SELECTED_STORAGE_KEY,
  saveStoredAppDocsSlug,
} from "@cocalc/frontend/docs/navigation";
import {
  downloadStandaloneDocsHtml,
  wrapDocsPrintHtml,
} from "@cocalc/frontend/docs/download-html";
import { open_popup_window } from "@cocalc/frontend/misc/open-browser-tab";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text, Title } = Typography;
const DOCS_PRINT_BUTTON_ID = "cocalc-docs-print-button";
const DOCS_DOWNLOAD_HTML_BUTTON_ID = "cocalc-docs-download-html-button";

function loadStoredAppDocsEntry(docsAccess: DocsAccess): DocsEntry | undefined {
  if (typeof window === "undefined") return undefined;
  const storedSlug = window.localStorage
    .getItem(APP_DOCS_SELECTED_STORAGE_KEY)
    ?.trim();
  return storedSlug ? getDocsEntry(storedSlug, docsAccess) : undefined;
}

function saveStoredAppDocsEntry(entry?: DocsEntry): void {
  saveStoredAppDocsSlug(entry?.slug);
}

export function DocsPage({ print, slug }: { print?: boolean; slug?: string }) {
  const [messageApi, contextHolder] = message.useMessage();
  const [privateFilter, setPrivateFilter] = useState<DocsPrivateFilter>("all");
  const importBusyRef = useRef(false);
  const pageActions = useActions("page");
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
    () => listDocsAppActions({ includeAdmin: isAdmin, projectId: "" }),
    [isAdmin],
  );
  const allDocsEntries = useMemo(
    () => listDocsEntries(docsAccess),
    [docsAccess],
  );
  const initialEntry = useMemo(
    () =>
      print
        ? undefined
        : slug
          ? getDocsEntry(slug, docsAccess)
          : loadStoredAppDocsEntry(docsAccess),
    [docsAccess, print, slug],
  );
  const initialEntrySlug = initialEntry?.slug;

  useEffect(() => {
    if (print) return;
    if (initialEntry == null) return;
    saveStoredAppDocsEntry(initialEntry);
    if (!slug) {
      pageActions.setState({ docs_print: false, docs_slug: initialEntry.slug });
      set_url(getPageUrlPath({ page: "docs", slug: initialEntry.slug }));
    }
  }, [initialEntry, initialEntrySlug, pageActions, print, slug]);

  async function runAction(
    action: DocsBrowserAction,
    parameters?: DocsBrowserActionParameters,
  ): Promise<void> {
    try {
      const result = await revealDocsAction({
        actionId: action.id,
        includeAdmin: isAdmin,
        parameters,
        projectId: "",
      });
      if (result.warning) {
        await messageApi.warning(result.warning, 6);
      } else {
        await messageApi.success(action.label);
      }
    } catch (err) {
      await messageApi.error(`${err}`);
    }
  }

  function openPrintPopup(): void {
    const html = renderToStaticMarkup(
      <DocsPrintContent
        downloadHtmlButtonId={DOCS_DOWNLOAD_HTML_BUTTON_ID}
        docsAccess={docsAccess}
        onBackHref={getPageUrlPath({ page: "docs" })}
        printButtonId={DOCS_PRINT_BUTTON_ID}
      />,
    );
    const documentHtml = wrapDocsPrintHtml(
      `${html}
    <script>
      async function cocalcBlobToDataUrl(blob) {
        return await new Promise(function(resolve, reject) {
          const reader = new FileReader();
          reader.onerror = function() { reject(reader.error); };
          reader.onload = function() { resolve(String(reader.result)); };
          reader.readAsDataURL(blob);
        });
      }
      async function cocalcDownloadDocsHtml() {
        const button = document.getElementById("${DOCS_DOWNLOAD_HTML_BUTTON_ID}");
        if (button != null) button.textContent = "Preparing...";
        try {
          const clone = document.documentElement.cloneNode(true);
          clone.querySelectorAll(".cocalc-docs-print-controls").forEach(function(node) {
            node.remove();
          });
          const images = clone.querySelectorAll("img[src]");
          for (const image of images) {
            const src = image.getAttribute("src");
            if (!src || src.startsWith("data:")) continue;
            const url = new URL(src, document.baseURI).href;
            const response = await fetch(url);
            if (!response.ok) throw Error("unable to fetch " + url);
            image.setAttribute("src", await cocalcBlobToDataUrl(await response.blob()));
          }
          const blobUrl = URL.createObjectURL(new Blob(["<!doctype html>\\n" + clone.outerHTML], {
            type: "text/html"
          }));
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = "cocalc-docs.html";
          a.click();
          setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 1000);
        } catch (err) {
          alert(String(err));
        } finally {
          if (button != null) button.textContent = "Download HTML";
        }
      }
      window.onload = function() {
        const printButton = document.getElementById("${DOCS_PRINT_BUTTON_ID}");
        if (printButton != null) printButton.onclick = function() { window.print(); };
        const downloadButton = document.getElementById("${DOCS_DOWNLOAD_HTML_BUTTON_ID}");
        if (downloadButton != null) downloadButton.onclick = cocalcDownloadDocsHtml;
        setTimeout(function() { window.print(); }, 50);
      };
    </script>
  `,
      { autoPrint: false },
    );
    const url = URL.createObjectURL(
      new Blob([documentHtml], { type: "text/html" }),
    );
    const popup = open_popup_window(url, {
      height: 900,
      noopener: false,
      width: 1100,
    });
    if (popup == null) {
      URL.revokeObjectURL(url);
      return;
    }
    try {
      popup.addEventListener(
        "beforeunload",
        () => {
          URL.revokeObjectURL(url);
        },
        { once: true },
      );
      popup.focus();
    } catch {
      // The blob URL remains usable even if the browser does not expose the popup window.
    }
  }

  async function downloadHtml(): Promise<void> {
    try {
      await downloadStandaloneDocsHtml({
        docsAccess,
        onBackHref: getPageUrlPath({ page: "docs" }),
      });
      await messageApi.success("Downloaded self-contained HTML docs.");
    } catch (err) {
      await messageApi.error(`${err}`);
    }
  }

  const privateToolbar = accountId ? (
    <Space wrap>
      <Tooltip title="Export your private docs notes, learned pages, and starred pages as a JSON backup or transfer file">
        <Button
          icon={<DownloadOutlined />}
          onClick={async () => {
            try {
              const bundle = await exportDocsPrivateStateBundle({ accountId });
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
                "Exported private notes, learned pages, and starred state.",
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
        <Tooltip title="Import private docs notes, learned pages, and starred pages from a JSON export, merging without duplicate notes">
          <Button icon={<UploadOutlined />} size="small">
            Import
          </Button>
        </Tooltip>
      </Upload>
    </Space>
  ) : null;

  return (
    <div style={{ minHeight: 0, overflow: "auto" }}>
      <div style={DOCS_BROWSER_PAGE_STYLE}>
        {contextHolder}
        <DocsFontSizeFrame
          defaultFontSize={accountFontSize}
          showControls={false}
        >
          <Flex gap="middle" vertical>
            {!print ? (
              <>
                <div>
                  <Text strong style={DOCS_BROWSER_MUTED_TITLE_STYLE}>
                    CoCalc docs
                  </Text>
                  <Title
                    level={1}
                    style={{ lineHeight: 1.15, marginBottom: 0 }}
                  >
                    Help for this CoCalc site
                  </Title>
                </div>
                <Paragraph
                  style={{
                    color: COLORS.GRAY_M,
                    marginBottom: 20,
                    maxWidth: 760,
                  }}
                >
                  Search current CoCalc-ai docs from anywhere in the app.
                  Signed-in docs, account-wide private notes, and admin-only
                  pages appear here when your account has access.
                </Paragraph>
              </>
            ) : null}
          </Flex>
          <DocsBrowser
            actionAvailability={actionAvailability}
            browserHref={getPageUrlPath({ page: "docs" })}
            docsAccess={docsAccess}
            initialEntry={initialEntry}
            onDownloadHtml={downloadHtml}
            onPrint={openPrintPopup}
            onRunAction={runAction}
            onSelectedEntryChange={(entry) => {
              pageActions.setState({
                docs_print: false,
                docs_slug: entry?.slug,
              });
              set_url(getPageUrlPath({ page: "docs", slug: entry?.slug }));
              saveStoredAppDocsEntry(entry);
            }}
            printMode={print}
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
                    renderLearnedControl: (entry) => (
                      <DocsLearnedControl
                        entry={entry}
                        loading={docsPrivateState.loading}
                        onSetLearned={docsPrivateState.setLearned}
                        summary={docsPrivateState.summaries[entry.id]}
                      />
                    ),
                    renderToolbarActions: (entry) => (
                      <DocsPrivateToolbarActions
                        accountId={accountId}
                        entry={entry}
                        loading={docsPrivateState.loading}
                        notes={docsPrivateState.notesForEntry(entry.id)}
                        onSaveNote={docsPrivateState.saveNote}
                        onToggleStar={docsPrivateState.toggleStar}
                        showLabel
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
    </div>
  );
}
