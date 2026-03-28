/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import ChatInput from "@cocalc/frontend/chat/input";
import { ThreadImageUpload } from "@cocalc/frontend/chat/thread-image-upload";
import api from "@cocalc/frontend/client/api";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { set_url_with_search } from "@cocalc/frontend/history";
import { COLORS } from "@cocalc/util/theme";
import { capitalize } from "@cocalc/util/misc";
import { slugURL } from "@cocalc/util/news";
import {
  CHANNELS,
  CHANNELS_DESCRIPTIONS,
  type Channel,
  type NewsAdminListItem,
  type NewsItem,
  isNewsChannel,
} from "@cocalc/util/types/news";
import { joinUrlPath } from "@cocalc/util/url-path";

import { getAdminUrlPath, type AdminRoute } from "../routing";

const { Paragraph, Text, Title } = Typography;

interface NewsEditorDraft {
  channel: Channel;
  date: Dayjs;
  hide: boolean;
  tags: string[];
  text: string;
  title: string;
  until: Dayjs | null;
  url: string;
}

function appendMarkdownImage(
  body: string,
  url: string,
  label = "Image",
): string {
  const trimmed = body.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}![${label}](${url})\n`;
}

function getDefaultChannel(): Channel {
  if (typeof window === "undefined") {
    return "feature";
  }
  const channel = new URLSearchParams(window.location.search).get("channel");
  if (channel != null && isNewsChannel(channel)) {
    return channel;
  }
  return "feature";
}

function createEmptyDraft(): NewsEditorDraft {
  return {
    channel: getDefaultChannel(),
    date: dayjs(),
    hide: false,
    tags: [],
    text: "",
    title: "",
    until: null,
    url: "",
  };
}

function createDraftFromNews(news: NewsItem): NewsEditorDraft {
  return {
    channel: news.channel,
    date:
      typeof news.date === "number" ? dayjs.unix(news.date) : dayjs(news.date),
    hide: !!news.hide,
    tags: news.tags ?? [],
    text: news.text ?? "",
    title: news.title ?? "",
    until:
      typeof news.until === "number"
        ? dayjs.unix(news.until)
        : news.until
          ? dayjs(news.until)
          : null,
    url: news.url ?? "",
  };
}

function formatDateTime(value?: number | Date | string | null): string {
  if (value == null || value === "") {
    return "Never";
  }
  const date =
    typeof value === "number"
      ? new Date(value * 1000)
      : value instanceof Date
        ? value
        : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "Invalid date";
  }
  return date.toLocaleString();
}

function channelExplanation(channel: Channel): string {
  switch (channel) {
    case "feature":
      return "Updates, changes, and improvements. This is the default category.";
    case "announcement":
      return "Major announcements and important upcoming changes.";
    case "about":
      return "Meta-level company or team updates.";
    case "event":
      return "Upcoming company or conference events. These appear on the About / Events page instead of the main news feed.";
    case "platform":
      return CHANNELS_DESCRIPTIONS[channel];
  }
}

function previewHref(
  news: Pick<NewsItem, "id" | "title" | "channel">,
): string | undefined {
  if (!news.id || !news.title) {
    return;
  }
  if (news.channel === "event") {
    return joinUrlPath(appBasePath, "about/events");
  }
  return joinUrlPath(appBasePath, slugURL(news));
}

function renderStatus(
  item: Pick<NewsAdminListItem, "future" | "expired" | "hide">,
) {
  const tags: ReactNode[] = [];
  if (item.hide) {
    tags.push(
      <Tag color="red" key="hidden">
        Hidden
      </Tag>,
    );
  }
  if (item.future) {
    tags.push(
      <Tag color="gold" key="future">
        Future
      </Tag>,
    );
  }
  if (item.expired) {
    tags.push(
      <Tag color="default" key="expired">
        Expired
      </Tag>,
    );
  }
  if (tags.length === 0) {
    tags.push(
      <Tag color="green" key="live">
        Live
      </Tag>,
    );
  }
  return (
    <Space size={4} wrap>
      {tags}
    </Space>
  );
}

function useOpenAdminRoute() {
  const pageActions = useActions("page");
  return useCallback(
    (route: AdminRoute, opts?: { search?: string }) => {
      pageActions.set_active_tab("admin", false);
      pageActions.setState({ admin_route: route });
      set_url_with_search(getAdminUrlPath(route), opts?.search ?? "");
      if (typeof window !== "undefined") {
        window.scrollTo({ top: 0 });
      }
    },
    [pageActions],
  );
}

function NewsAdminListPage() {
  const openAdminRoute = useOpenAdminRoute();
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const [items, setItems] = useState<NewsAdminListItem[]>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api("news/admin-list", { limit: 200, offset: 0 });
      setItems(result.items ?? []);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isAdmin) {
    return <Alert message="Not authorized" showIcon type="error" />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space wrap>
        <Button
          type="primary"
          onClick={() => openAdminRoute({ kind: "news-editor", id: "new" })}
        >
          Create news item
        </Button>
        <Button
          onClick={() =>
            openAdminRoute(
              { kind: "news-editor", id: "new" },
              { search: "?channel=event" },
            )
          }
        >
          Create event
        </Button>
        <Button onClick={() => openAdminRoute({ kind: "index" })}>
          Back to admin
        </Button>
        <Button onClick={() => void load()}>Refresh</Button>
      </Space>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Manage news and event posts inside the app. This replaces the old
        Next.js editor at <Text code>/news/edit/*</Text>.
      </Paragraph>
      {error ? <Alert message={error} type="error" showIcon /> : null}
      <Table<NewsAdminListItem>
        columns={[
          {
            dataIndex: "title",
            key: "title",
            render: (_, record) => (
              <Button
                type="link"
                style={{ paddingInline: 0 }}
                onClick={() =>
                  openAdminRoute({
                    kind: "news-editor",
                    id: `${record.id}`,
                  })
                }
              >
                {record.title || `Untitled #${record.id}`}
              </Button>
            ),
            title: "Title",
          },
          {
            dataIndex: "channel",
            key: "channel",
            render: (value: Channel) => (
              <Tag color="blue">{capitalize(value)}</Tag>
            ),
            title: "Channel",
            width: 120,
          },
          {
            dataIndex: "date",
            key: "date",
            render: (value: number) => formatDateTime(value),
            title: "Date",
            width: 200,
          },
          {
            dataIndex: "status",
            key: "status",
            render: (_, record) => renderStatus(record),
            title: "Status",
            width: 220,
          },
          {
            dataIndex: "tags",
            key: "tags",
            render: (tags?: string[]) =>
              tags?.length ? (
                <Space size={4} wrap>
                  {tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </Space>
              ) : (
                <Text type="secondary">None</Text>
              ),
            title: "Tags",
          },
          {
            key: "actions",
            render: (_, record) => {
              const href = previewHref(record);
              return (
                <Space wrap>
                  <Button
                    size="small"
                    onClick={() =>
                      openAdminRoute({
                        kind: "news-editor",
                        id: `${record.id}`,
                      })
                    }
                  >
                    Edit
                  </Button>
                  {href ? (
                    <Button href={href} size="small" target="_blank">
                      View public
                    </Button>
                  ) : null}
                </Space>
              );
            },
            title: "Actions",
            width: 180,
          },
        ]}
        dataSource={items}
        loading={loading}
        locale={{
          emptyText: loading ? (
            "Loading news items..."
          ) : (
            <Empty description="No news items yet" />
          ),
        }}
        pagination={{ defaultPageSize: 25, hideOnSinglePage: true }}
        rowKey={(record) => `${record.id}`}
      />
    </Space>
  );
}

function NewsEditorPage({
  route,
}: {
  route: Extract<AdminRoute, { kind: "news-editor" }>;
}) {
  const openAdminRoute = useOpenAdminRoute();
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const isNew = route.id === "new";
  const [draft, setDraft] = useState<NewsEditorDraft>(createEmptyDraft());
  const [error, setError] = useState<string>("");
  const [lastImageUrl, setLastImageUrl] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(!isNew);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    let canceled = false;
    setError("");
    setLastImageUrl("");
    if (isNew) {
      setLoading(false);
      setDraft(createEmptyDraft());
      return;
    }
    async function load() {
      setLoading(true);
      try {
        const result = await api("news/admin-get", { id: route.id });
        if (!canceled) {
          setDraft(createDraftFromNews(result.news));
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, [isNew, route.id]);

  const previewNews = useMemo<NewsItem>(() => {
    return {
      channel: draft.channel,
      date: draft.date.unix(),
      hide: draft.hide,
      id: isNew ? undefined : route.id,
      tags: draft.tags,
      text: draft.text,
      title: draft.title,
      until: draft.until?.unix(),
      url: draft.url || undefined,
    };
  }, [draft, isNew, route.id]);

  const currentPublicHref = useMemo(() => {
    return previewHref({
      channel: previewNews.channel,
      id: previewNews.id,
      title: previewNews.title,
    });
  }, [previewNews.channel, previewNews.id, previewNews.title]);

  const canSave =
    !!draft.title.trim() &&
    !!draft.text.trim() &&
    !saving &&
    !loading &&
    isAdmin;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError("");
    setSaveMessage("");
    try {
      const result = await api("news/edit", {
        ...(isNew ? undefined : { id: route.id }),
        channel: draft.channel,
        date: draft.date.unix(),
        hide: draft.hide,
        tags: draft.tags.filter((tag) => tag.trim()),
        text: draft.text,
        title: draft.title.trim(),
        until: draft.until?.unix(),
        url: draft.url.trim() || undefined,
      });
      const savedId = `${result.id}`;
      setSaveMessage(
        isNew
          ? `Created news item #${savedId}.`
          : `Saved changes to news item #${savedId}.`,
      );
      if (isNew) {
        openAdminRoute({ kind: "news-editor", id: savedId });
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) {
    return <Alert message="Not authorized" showIcon type="error" />;
  }

  if (loading) {
    return <Card loading />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space wrap>
        <Button onClick={() => openAdminRoute({ kind: "news-list" })}>
          Back to news
        </Button>
        <Button onClick={() => openAdminRoute({ kind: "index" })}>
          Back to admin
        </Button>
        <Button
          onClick={() => openAdminRoute({ kind: "news-editor", id: "new" })}
        >
          New item
        </Button>
        {currentPublicHref ? (
          <Button href={currentPublicHref} target="_blank">
            View public
          </Button>
        ) : null}
      </Space>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Use the rich markdown editor below. You can paste or drop images
        directly into the composer, or upload/crop them in the image box.
      </Paragraph>
      {saveMessage ? (
        <Alert message={saveMessage} showIcon type="success" />
      ) : null}
      {error ? <Alert message={error} showIcon type="error" /> : null}
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={15}>
          <Card
            title={isNew ? "Create news item" : `Edit news #${route.id}`}
            extra={
              <Space>
                <Button onClick={() => openAdminRoute({ kind: "news-list" })}>
                  Cancel
                </Button>
                <Button
                  disabled={!canSave}
                  loading={saving}
                  type="primary"
                  onClick={() => void save()}
                >
                  {isNew ? "Create" : "Save"}
                </Button>
              </Space>
            }
          >
            <Space direction="vertical" size="large" style={{ width: "100%" }}>
              <div>
                <Text strong>Title</Text>
                <Input
                  placeholder="Short headline..."
                  style={{ marginTop: 8 }}
                  value={draft.title}
                  onChange={(e) =>
                    setDraft((current) => ({
                      ...current,
                      title: e.target.value,
                    }))
                  }
                />
              </div>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Text strong>Date</Text>
                  <DatePicker
                    allowClear={false}
                    showTime
                    style={{ marginTop: 8, width: "100%" }}
                    value={draft.date}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        date: value ?? dayjs(),
                      }))
                    }
                  />
                  <Paragraph
                    type="secondary"
                    style={{ marginBottom: 0, marginTop: 8 }}
                  >
                    {draft.date.isAfter(dayjs())
                      ? "This item will stay hidden until the scheduled time."
                      : "This item is already eligible to appear publicly."}
                  </Paragraph>
                </Col>
                <Col xs={24} md={12}>
                  <Text strong>Until</Text>
                  <DatePicker
                    allowClear
                    showTime
                    style={{ marginTop: 8, width: "100%" }}
                    value={draft.until}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        until: value,
                      }))
                    }
                  />
                  <Paragraph
                    type="secondary"
                    style={{ marginBottom: 0, marginTop: 8 }}
                  >
                    Optional expiration date. Leave empty to keep the item
                    visible indefinitely.
                  </Paragraph>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Text strong>Channel</Text>
                  <Select
                    style={{ marginTop: 8, width: "100%" }}
                    value={draft.channel}
                    onChange={(value: Channel) =>
                      setDraft((current) => ({
                        ...current,
                        channel: value,
                      }))
                    }
                  >
                    {CHANNELS.map((channel) => (
                      <Select.Option key={channel} value={channel}>
                        {capitalize(channel)}
                      </Select.Option>
                    ))}
                  </Select>
                  <Paragraph
                    type="secondary"
                    style={{ marginBottom: 0, marginTop: 8 }}
                  >
                    {channelExplanation(draft.channel)}
                  </Paragraph>
                </Col>
                <Col xs={24} md={12}>
                  <Text strong>Tags</Text>
                  <Select
                    mode="tags"
                    style={{ marginTop: 8, width: "100%" }}
                    value={draft.tags}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        tags: value,
                      }))
                    }
                  />
                  <Paragraph
                    type="secondary"
                    style={{ marginBottom: 0, marginTop: 8 }}
                  >
                    Common examples are <Text code>jupyter</Text>,{" "}
                    <Text code>latex</Text>, or <Text code>sagemath</Text>. One
                    or two tags is usually enough.
                  </Paragraph>
                </Col>
              </Row>
              <div>
                <Text strong>Body</Text>
                <div
                  style={{
                    background: "white",
                    border: `1px solid ${COLORS.GRAY_LL}`,
                    borderRadius: 12,
                    marginTop: 8,
                    padding: 8,
                  }}
                >
                  <ChatInput
                    autoGrowMaxHeight={360}
                    enableMentions={false}
                    enableUpload
                    fixedMode="editor"
                    height="280px"
                    input={draft.text}
                    isFocused
                    on_send={() => undefined}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        text: value,
                      }))
                    }
                    placeholder="Write the news item in markdown..."
                    syncdb={undefined}
                    date={-1}
                  />
                </div>
              </div>
              <div>
                <Text strong>Images</Text>
                <Paragraph
                  type="secondary"
                  style={{ marginBottom: 0, marginTop: 8 }}
                >
                  Paste or drop images directly into the editor above, or use
                  this uploader when you want to crop an image before inserting
                  it.
                </Paragraph>
                <div style={{ marginTop: 12 }}>
                  <ThreadImageUpload
                    modalTitle="Crop news image"
                    uploadText="Click, drag, or paste an image to insert it"
                    value={lastImageUrl}
                    onChange={(value) => {
                      setLastImageUrl(value);
                      setDraft((current) => ({
                        ...current,
                        text: appendMarkdownImage(current.text, value),
                      }));
                    }}
                  />
                </div>
              </div>
              <div>
                <Text strong>External URL</Text>
                <Input
                  allowClear
                  placeholder='Optional external link shown as "Read more"...'
                  style={{ marginTop: 8 }}
                  value={draft.url}
                  onChange={(e) =>
                    setDraft((current) => ({ ...current, url: e.target.value }))
                  }
                />
              </div>
              <Checkbox
                checked={draft.hide}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    hide: e.target.checked,
                  }))
                }
              >
                Hide this item from public pages
              </Checkbox>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="Preview">
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Space wrap>
                <Tag color="blue">{capitalize(previewNews.channel)}</Tag>
                {renderStatus({
                  expired:
                    draft.until != null ? draft.until.isBefore(dayjs()) : false,
                  future: draft.date.isAfter(dayjs()),
                  hide: draft.hide,
                })}
              </Space>
              <Text type="secondary">{formatDateTime(previewNews.date)}</Text>
              <Title level={3} style={{ marginTop: 0 }}>
                {previewNews.title || "Untitled news item"}
              </Title>
              {previewNews.tags?.length ? (
                <Space size={4} wrap>
                  {previewNews.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </Space>
              ) : null}
              {previewNews.text.trim() ? (
                <StaticMarkdown value={previewNews.text} />
              ) : (
                <Empty
                  description="Add some markdown to preview the body"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              )}
              {previewNews.url ? (
                <Alert
                  message={`External URL: ${previewNews.url}`}
                  showIcon
                  type="info"
                />
              ) : null}
              {draft.until ? (
                <Text type="secondary">
                  Expires {formatDateTime(draft.until.toDate())}
                </Text>
              ) : null}
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

export function NewsAdminPage({ route }: { route: AdminRoute }) {
  return (
    <div style={{ padding: "20px", overflowY: "auto" }}>
      <Title level={3} style={{ marginBottom: 4 }}>
        News Administration
      </Title>
      {route.kind === "news-editor" ? (
        <NewsEditorPage route={route} />
      ) : (
        <NewsAdminListPage />
      )}
    </div>
  );
}
