/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useId, useMemo, useState } from "react";

import {
  Alert,
  Button,
  Card,
  Col,
  Flex,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from "antd";

import { Icon, isIconName, type IconName } from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { pathForAuthView } from "@cocalc/frontend/public/auth/routes";
import { applyPublicRouteMetadata } from "@cocalc/frontend/public/metadata";
import {
  getPublicMarketingSiteName,
  getPublicRouteMetadata,
  pageTitle,
  stripMarkdownSummary,
} from "@cocalc/frontend/public/metadata-data";
import {
  PUBLIC_INTERACTIVE_CARD_CLASS,
  PublicGrid,
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import {
  groupRootfsVersionEntries,
  latestRootfsVersionForEntry,
  rootfsThemeImageUrl,
} from "@cocalc/frontend/rootfs/catalog-ui";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  type RootfsContentAction,
  type RootfsImageEntry,
  rootfsEntryDisplayDescription as displayDescription,
  rootfsEntryDisplayTitle as displayTitle,
} from "@cocalc/util/rootfs-images";
import { appPath, type PublicConfig } from "../common";
import type { PublicRootfsRoute } from "./routes";
import { rootfsEntryMatchesImageTarget, rootfsPath } from "./routes";
import { publicRootfsTags, RootfsTagFilter, RootfsTagPill } from "./tag-filter";

const { Paragraph, Text, Title } = Typography;

interface PublicRootfsAppProps {
  config?: PublicConfig;
  initialRoute: PublicRootfsRoute;
}

function trim(value?: string): string {
  return `${value ?? ""}`.trim();
}

function rootfsIconName(entry: RootfsImageEntry): IconName {
  return isIconName(entry.theme?.icon) ? entry.theme.icon : "docker";
}

function currentPathWithSearch(): string {
  if (typeof window === "undefined") return rootfsPath();
  return `${window.location.pathname}${window.location.search}`;
}

function authPath(view: "sign-in" | "sign-up"): string {
  return `${pathForAuthView(view)}?target=${encodeURIComponent(
    currentPathWithSearch(),
  )}`;
}

function metadataItems(entry: RootfsImageEntry): string[] {
  return [
    trim(entry.version) ? `Version ${trim(entry.version)}` : undefined,
    trim(entry.family),
    trim(entry.channel),
    entry.gpu ? "GPU" : undefined,
    Array.isArray(entry.arch) ? entry.arch.join(", ") : trim(entry.arch),
    trim(entry.owner_name) ? `by ${trim(entry.owner_name)}` : undefined,
  ].filter((item): item is string => !!item);
}

function actionKindLabel(kind: RootfsContentAction["kind"]): string {
  switch (kind) {
    case "browse":
      return "Browse";
    case "copy-to-home":
      return "Copy to HOME";
    case "external-link":
      return "External link";
    case "open":
    default:
      return "Open";
  }
}

function actionPathLabel(action: RootfsContentAction): string | undefined {
  if (action.kind === "copy-to-home") {
    const source = trim(action.source_path) || trim(action.path);
    const target = trim(action.target_path);
    if (source && target) return `${source} -> ${target}`;
    return source || target || undefined;
  }
  return trim(action.path) || trim(action.source_path) || trim(action.url);
}

function RootfsActionPreview({ action }: { action: RootfsContentAction }) {
  const { token } = theme.useToken();
  const label = trim(action.label) || actionKindLabel(action.kind);
  const description = trim(action.description);
  const pathLabel = actionPathLabel(action);
  const externalUrl = action.kind === "external-link" ? trim(action.url) : "";

  return (
    <Card
      size="small"
      style={{
        borderColor: token.colorBorderSecondary,
        height: "100%",
      }}
    >
      <Flex justify="space-between" gap="middle" wrap="wrap">
        <Flex vertical gap={4} style={{ minWidth: 0 }}>
          <Space wrap size={[6, 4]}>
            <Text strong>{label}</Text>
            <Tag style={{ marginInlineEnd: 0 }}>
              {actionKindLabel(action.kind)}
            </Tag>
          </Space>
          {description ? <Text type="secondary">{description}</Text> : null}
          {pathLabel ? (
            <code style={{ overflowWrap: "anywhere" }}>{pathLabel}</code>
          ) : null}
        </Flex>
        {externalUrl ? (
          <Button
            href={externalUrl}
            icon={<Icon name="external-link" />}
            rel="noreferrer"
            target="_blank"
          >
            Open
          </Button>
        ) : null}
      </Flex>
    </Card>
  );
}

function RootfsHighlights({ entry }: { entry: RootfsImageEntry }) {
  const highlights = entry.content?.highlights ?? [];
  if (highlights.length === 0 && (entry.tags ?? []).length === 0) return null;
  return (
    <Space wrap size={[8, 8]}>
      {highlights.map((highlight) => (
        <Tag key={`highlight:${highlight}`} color="blue">
          {highlight}
        </Tag>
      ))}
      {(entry.tags ?? []).map((tag) => (
        <Tag key={`tag:${tag}`}>{tag}</Tag>
      ))}
    </Space>
  );
}

function olderVersionLabel(entry: RootfsImageEntry): string {
  const version = trim(entry.version);
  return version ? `Version ${version}` : displayTitle(entry);
}

function olderVersionDate(entry: RootfsImageEntry): string | undefined {
  const date = new Date(entry.created ?? "");
  if (Number.isNaN(date.valueOf())) return;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function RootfsCatalogCard({
  entry,
  olderEntries,
  onTagToggle,
  selectedTags,
}: {
  entry: RootfsImageEntry;
  olderEntries: RootfsImageEntry[];
  onTagToggle: (tag: string) => void;
  selectedTags: Set<string>;
}) {
  const { token } = theme.useToken();
  const [showOlder, setShowOlder] = useState(false);
  const olderListId = useId();
  const imageUrl = rootfsThemeImageUrl(entry.theme);
  const title = displayTitle(entry);
  const description = displayDescription(entry);
  const hasOlder = olderEntries.length > 0;
  const tags = Array.from(
    new Set(
      [entry, ...olderEntries].flatMap((version) => publicRootfsTags(version)),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <div
      style={{
        paddingBottom: 8,
        position: "relative",
      }}
    >
      {hasOlder ? (
        <>
          <div
            aria-hidden="true"
            style={{
              background: token.colorFillAlter,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusLG,
              bottom: 0,
              height: 20,
              left: 12,
              position: "absolute",
              right: 12,
            }}
          />
          {olderEntries.length > 1 ? (
            <div
              aria-hidden="true"
              style={{
                background: token.colorFillAlter,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadiusLG,
                bottom: 4,
                height: 20,
                left: 6,
                position: "absolute",
                right: 6,
              }}
            />
          ) : null}
        </>
      ) : null}
      <Card
        className={PUBLIC_INTERACTIVE_CARD_CLASS}
        hoverable
        style={{ position: "relative" }}
      >
        <a
          href={rootfsPath(entry)}
          style={{ color: "inherit", display: "block", textDecoration: "none" }}
        >
          <Flex gap="middle">
            {imageUrl ? (
              <img
                alt=""
                src={imageUrl}
                style={{
                  borderRadius: token.borderRadiusLG,
                  height: 72,
                  objectFit: "cover",
                  width: 72,
                }}
              />
            ) : (
              <Flex
                align="center"
                justify="center"
                style={{
                  background: token.colorFillAlter,
                  borderRadius: token.borderRadiusLG,
                  color: token.colorTextSecondary,
                  flex: "0 0 auto",
                  height: 72,
                  width: 72,
                }}
              >
                <Icon name={rootfsIconName(entry)} />
              </Flex>
            )}
            <Flex vertical gap={4} style={{ minWidth: 0 }}>
              <Flex align="center" gap={6} style={{ minWidth: 0 }}>
                <Text ellipsis strong style={{ minWidth: 0 }} title={title}>
                  {title}
                </Text>
                {hasOlder ? (
                  <Tag
                    color="green"
                    style={{ flex: "0 0 auto", marginInlineEnd: 0 }}
                  >
                    Latest
                  </Tag>
                ) : null}
              </Flex>
              {description ? (
                <Text ellipsis type="secondary">
                  {description}
                </Text>
              ) : null}
              <Space wrap size={[4, 4]}>
                {metadataItems(entry)
                  .slice(0, 3)
                  .map((item) => (
                    <Tag key={item} style={{ marginInlineEnd: 0 }}>
                      {item}
                    </Tag>
                  ))}
              </Space>
            </Flex>
          </Flex>
        </a>
        {tags.length ? (
          <Flex
            aria-label={`Tags for ${title}`}
            gap={6}
            role="group"
            style={{ marginTop: token.marginSM }}
            wrap="wrap"
          >
            {tags.map((tag) => (
              <RootfsTagPill
                key={tag}
                onToggle={onTagToggle}
                selected={selectedTags.has(tag)}
                tag={tag}
              />
            ))}
          </Flex>
        ) : null}
        {hasOlder ? (
          <div
            style={{
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              marginTop: token.margin,
              paddingTop: token.paddingXS,
            }}
          >
            <Button
              aria-controls={olderListId}
              aria-expanded={showOlder}
              block
              icon={<Icon name={showOlder ? "chevron-up" : "chevron-down"} />}
              onClick={() => setShowOlder((value) => !value)}
              size="small"
              type="text"
            >
              {showOlder ? "Hide" : "View"} {olderEntries.length} previous{" "}
              {olderEntries.length === 1 ? "version" : "versions"}
            </Button>
            {showOlder ? (
              <ul
                aria-label={`Previous versions of ${title}`}
                id={olderListId}
                style={{
                  listStyle: "none",
                  margin: `${token.marginXS}px 0 0`,
                  padding: 0,
                }}
              >
                {olderEntries.map((older) => {
                  const date = olderVersionDate(older);
                  return (
                    <li key={older.id}>
                      <a
                        href={rootfsPath(older)}
                        style={{
                          borderRadius: token.borderRadius,
                          color: "inherit",
                          display: "block",
                          padding: `${token.paddingXS}px ${token.paddingSM}px`,
                          textDecoration: "none",
                        }}
                      >
                        <Flex
                          align="center"
                          justify="space-between"
                          gap="small"
                        >
                          <Text>{olderVersionLabel(older)}</Text>
                          <Space size="small">
                            {date ? <Text type="secondary">{date}</Text> : null}
                            <Icon
                              name="chevron-right"
                              style={{ color: token.colorTextSecondary }}
                            />
                          </Space>
                        </Flex>
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function useSelectedRootfsImage(route: PublicRootfsRoute) {
  const catalog = useRootfsImages(
    route.view === "index" ? [managedRootfsCatalogUrl()] : [],
    { allPages: route.view === "index" },
  );
  const exact = useRootfsImages(
    route.view === "index" ? [] : [managedRootfsCatalogUrl()],
    {
      limit: route.view === "index" ? 200 : 20,
      slug: route.view === "slug" ? route.slug : undefined,
      imageTarget: route.view === "image-id" ? route.imageId : undefined,
    },
  );
  const exactSelected = useMemo(() => {
    if (route.view === "slug") {
      return exact.images.find((entry) => entry.slug === route.slug);
    }
    if (route.view === "image-id") {
      return exact.images.find((entry) =>
        rootfsEntryMatchesImageTarget(entry, route.imageId),
      );
    }
  }, [exact.images, route]);
  const lineage = useRootfsImages(
    route.view !== "index" && exactSelected ? [managedRootfsCatalogUrl()] : [],
    {
      limit: 200,
      lineageImageId: exactSelected?.id,
    },
  );
  const images = useMemo(() => {
    if (route.view === "index") return catalog.images;
    const merged = new Map(
      [...exact.images, ...lineage.images].map((entry) => [entry.id, entry]),
    );
    return Array.from(merged.values());
  }, [catalog.images, exact.images, lineage.images, route.view]);
  const selected = useMemo(() => {
    if (route.view === "slug") {
      return images.find((entry) => entry.slug === route.slug);
    }
    if (route.view === "image-id") {
      return images.find((entry) =>
        rootfsEntryMatchesImageTarget(entry, route.imageId),
      );
    }
  }, [images, route]);
  if (route.view === "index") return { ...catalog, selected };
  return {
    error: exact.error ?? lineage.error,
    images,
    loading: exact.loading && !selected,
    selected,
  };
}

function RootfsCreateProject({
  config,
  entry,
}: {
  config?: PublicConfig;
  entry: RootfsImageEntry;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const title = displayTitle(entry);

  async function createProject() {
    setCreating(true);
    setError(undefined);
    try {
      const projectId = await webapp_client.project_client.create({
        description: displayDescription(entry) ?? "",
        rootfs_image: entry.image,
        rootfs_image_id: entry.id,
        start: true,
        timeout: 60_000,
        title,
      });
      window.location.href = appPath(`projects/${projectId}/rootfs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
      setCreating(false);
    }
  }

  if (!config?.is_authenticated) {
    return (
      <Space wrap>
        <Button href={authPath("sign-up")} size="large" type="primary">
          Sign up to create this project
        </Button>
        <Button href={authPath("sign-in")} size="large">
          Sign in
        </Button>
      </Space>
    );
  }

  return (
    <Flex vertical gap="middle">
      <Button
        icon={<Icon name="plus-circle" />}
        loading={creating}
        onClick={createProject}
        size="large"
        type="primary"
      >
        Create project with this image
      </Button>
      {error ? (
        <Alert
          title="Project creation failed"
          description={error}
          showIcon
          type="error"
        />
      ) : null}
    </Flex>
  );
}

function RootfsLandingPage({
  config,
  entry,
  images,
}: {
  config?: PublicConfig;
  entry: RootfsImageEntry;
  images: RootfsImageEntry[];
}) {
  const { token } = theme.useToken();
  const title = displayTitle(entry);
  const description = displayDescription(entry);
  const imageUrl = rootfsThemeImageUrl(entry.theme);
  const metadata = metadataItems(entry);
  const publisher = entry.content?.publisher;
  const license = entry.content?.license;
  const latest = latestRootfsVersionForEntry({ current: entry, images });
  const newerEntry = latest.id === entry.id ? undefined : latest;

  return (
    <PublicPage config={config}>
      <section>
        {newerEntry ? (
          <Alert
            action={
              <Button href={rootfsPath(newerEntry)} type="primary">
                View latest version
              </Button>
            }
            description={`${displayTitle(newerEntry)} ${
              trim(newerEntry.version)
                ? `version ${trim(newerEntry.version)}`
                : ""
            } is the current release.`}
            showIcon
            style={{ marginBottom: token.marginXL }}
            title="A newer version of this image is available"
            type="warning"
          />
        ) : null}
        <Row gutter={[token.marginXL, token.marginXL]} align="middle">
          <Col lg={14} xs={24}>
            <Flex vertical gap="middle">
              <Space wrap size={[8, 8]}>
                <Tag color={entry.official ? "blue" : undefined}>
                  {entry.official ? "Official image" : "Runtime image"}
                </Tag>
                {entry.visibility === "public" ? (
                  <Tag color="green">Public</Tag>
                ) : null}
              </Space>
              <Title level={1} style={{ margin: 0 }}>
                {title}
              </Title>
              {entry.content?.subtitle ? (
                <Title
                  level={3}
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    fontWeight: 500,
                    margin: 0,
                  }}
                >
                  {entry.content.subtitle}
                </Title>
              ) : null}
              {description ? (
                <Paragraph style={{ fontSize: token.fontSizeLG, margin: 0 }}>
                  {description}
                </Paragraph>
              ) : null}
              {metadata.length ? (
                <Space wrap size={[6, 6]}>
                  {metadata.map((item) => (
                    <Tag key={item}>{item}</Tag>
                  ))}
                </Space>
              ) : null}
              <RootfsHighlights entry={entry} />
              <RootfsCreateProject config={config} entry={entry} />
            </Flex>
          </Col>
          <Col lg={10} xs={24}>
            <Card
              style={{
                background: entry.theme?.accent_color || token.colorBgContainer,
                borderColor: entry.theme?.color || token.colorBorderSecondary,
              }}
            >
              {imageUrl ? (
                <img
                  alt=""
                  src={imageUrl}
                  style={{
                    borderRadius: token.borderRadiusLG,
                    display: "block",
                    maxHeight: 320,
                    objectFit: "cover",
                    width: "100%",
                  }}
                />
              ) : (
                <Flex
                  align="center"
                  justify="center"
                  style={{
                    aspectRatio: "16 / 10",
                    color: entry.theme?.color || token.colorTextSecondary,
                  }}
                >
                  <Icon name={rootfsIconName(entry)} style={{ fontSize: 72 }} />
                </Flex>
              )}
            </Card>
          </Col>
        </Row>
      </section>
      {entry.content?.actions?.length ? (
        <PublicSection
          title="Included content"
          intro="This runtime image advertises these files, directories, or links. After creating a project, open the Rootfs panel to use project-aware actions such as copy to HOME."
        >
          <PublicGrid columns={2}>
            {entry.content.actions.map((action, index) => (
              <RootfsActionPreview
                key={`${action.kind}:${action.label}:${index}`}
                action={action}
              />
            ))}
          </PublicGrid>
        </PublicSection>
      ) : null}
      {publisher?.name || license?.name ? (
        <PublicSection title="Details">
          <Space vertical size="small">
            {publisher?.name ? (
              <Text>
                Publisher:{" "}
                {publisher.url ? (
                  <a href={publisher.url} rel="noreferrer" target="_blank">
                    {publisher.name}
                  </a>
                ) : (
                  publisher.name
                )}
              </Text>
            ) : null}
            {license?.name ? (
              <Text>
                License:{" "}
                {license.url ? (
                  <a href={license.url} rel="noreferrer" target="_blank">
                    {license.name}
                  </a>
                ) : (
                  license.name
                )}
              </Text>
            ) : null}
          </Space>
        </PublicSection>
      ) : null}
    </PublicPage>
  );
}

function RootfsIndexPage({
  config,
  images,
  loading,
}: {
  config?: PublicConfig;
  images: RootfsImageEntry[];
  loading: boolean;
}) {
  // Filters intentionally remain local UI state. Public filtered views do not
  // create additional crawlable URLs; /rootfs remains their canonical page.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags]);
  const imageGroups = useMemo(
    () => groupRootfsVersionEntries(images),
    [images],
  );
  const taggedGroups = useMemo(
    () =>
      imageGroups.map((group) => ({
        ...group,
        tags: new Set(
          [group.latest, ...group.older].flatMap((entry) =>
            publicRootfsTags(entry),
          ),
        ),
      })),
    [imageGroups],
  );
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { tags } of taggedGroups) {
      for (const tag of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
      (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
    );
  }, [taggedGroups]);
  const visibleGroups = useMemo(
    () =>
      selectedTags.length
        ? taggedGroups.filter(({ tags }) =>
            selectedTags.every((tag) => tags.has(tag)),
          )
        : taggedGroups,
    [selectedTags, taggedGroups],
  );
  const disabledTags = useMemo(() => {
    const disabled = new Set<string>();
    for (const { tag } of tagOptions) {
      if (selectedTagSet.has(tag)) continue;
      const hasMatch = taggedGroups.some(({ tags }) =>
        [...selectedTags, tag].every((candidate) => tags.has(candidate)),
      );
      if (!hasMatch) disabled.add(tag);
    }
    return disabled;
  }, [selectedTags, selectedTagSet, taggedGroups, tagOptions]);
  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((candidate) => candidate !== tag)
        : [...current, tag],
    );
  };
  const selectedTagLabel = selectedTags.map((tag) => `#${tag}`).join(" + ");

  useEffect(() => {
    document.title = "Runtime images";
  }, []);

  return (
    <PublicPage config={config} title="Runtime images">
      <PublicSection>
        <Paragraph style={{ margin: 0, width: "100%" }}>
          Discover project runtime images that include ready-to-use software,
          examples, and files. Choose an image to create a matching project.
        </Paragraph>
        {loading ? (
          <Flex align="center" gap="middle">
            <Spin size="small" />
            <Text>Loading runtime images...</Text>
          </Flex>
        ) : images.length ? (
          <Flex vertical gap="large">
            <RootfsTagFilter
              disabledTags={disabledTags}
              onToggle={toggleTag}
              options={tagOptions}
              selectedTags={selectedTagSet}
            />
            {selectedTags.length ? (
              <Alert
                action={
                  <Button onClick={() => setSelectedTags([])}>
                    Clear filters
                  </Button>
                }
                description={
                  selectedTags.length === 1
                    ? `Showing ${visibleGroups.length} ${
                        visibleGroups.length === 1 ? "family" : "families"
                      } tagged ${selectedTagLabel}.`
                    : `Showing ${visibleGroups.length} ${
                        visibleGroups.length === 1 ? "family" : "families"
                      } matching all ${selectedTags.length} selected tags.`
                }
                showIcon
                title={`Filtered by ${selectedTagLabel}`}
                type="info"
              />
            ) : null}
            {visibleGroups.length ? (
              <PublicGrid columns={3}>
                {visibleGroups.map(({ latest, older }) => (
                  <RootfsCatalogCard
                    key={latest.id}
                    entry={latest}
                    olderEntries={older}
                    onTagToggle={toggleTag}
                    selectedTags={selectedTagSet}
                  />
                ))}
              </PublicGrid>
            ) : (
              <Alert
                action={
                  <Button onClick={() => setSelectedTags([])}>
                    Clear filters
                  </Button>
                }
                showIcon
                title="No runtime images have this tag."
                type="info"
              />
            )}
          </Flex>
        ) : (
          <Alert
            title="No runtime images are available."
            showIcon
            type="info"
          />
        )}
      </PublicSection>
    </PublicPage>
  );
}

function RootfsNotFoundPage({
  config,
  loading,
}: {
  config?: PublicConfig;
  loading: boolean;
}) {
  useEffect(() => {
    document.title = loading
      ? "Loading runtime image..."
      : "Runtime image not found";
  }, [loading]);

  return (
    <PublicPage
      config={config}
      title={loading ? "Loading runtime image..." : "Runtime image not found"}
    >
      <PublicSection>
        {loading ? (
          <Flex align="center" gap="middle">
            <Spin size="small" />
            <Text>Loading runtime image...</Text>
          </Flex>
        ) : (
          <Alert
            title="This runtime image is not available."
            description="It may be private, hidden, deleted, or not visible to this account."
            showIcon
            type="warning"
          />
        )}
      </PublicSection>
    </PublicPage>
  );
}

export default function PublicRootfsApp({
  config,
  initialRoute,
}: PublicRootfsAppProps) {
  const { error, images, loading, selected } =
    useSelectedRootfsImage(initialRoute);

  // SPA navigation renders detail pages without a server round-trip, and
  // PublicRouteHeadMetadata leaves rootfs detail routes alone (the shared
  // registry only knows generic route-echo values). Apply the resolved
  // entry's metadata here instead, mirroring the hub's server-side
  // resolution so direct loads and SPA navigations end up with the same
  // head.
  useEffect(() => {
    if (initialRoute.view === "index" || loading) return;
    const dns =
      config?.dns ??
      (typeof window === "undefined" ? undefined : window.location.host);
    const metadataConfig = { ...config, dns };
    const metadata = getPublicRouteMetadata(
      { route: initialRoute, section: "rootfs" },
      metadataConfig,
      { basePath: appBasePath },
    );
    if (selected == null) {
      // Not found: the generic registry metadata is correct; the not-found
      // view manages document.title itself.
      applyPublicRouteMetadata(metadata);
      return;
    }
    const description = stripMarkdownSummary(displayDescription(selected));
    const latest = latestRootfsVersionForEntry({ current: selected, images });
    const title = pageTitle(
      displayTitle(selected),
      getPublicMarketingSiteName(metadataConfig),
    );
    document.title = title;
    applyPublicRouteMetadata({
      ...metadata,
      canonicalPath: rootfsPath(latest),
      ...(description ? { description } : {}),
      title,
    });
  }, [config, images, initialRoute, loading, selected]);

  if (initialRoute.view === "index") {
    return (
      <RootfsIndexPage config={config} images={images} loading={loading} />
    );
  }

  if (selected) {
    return (
      <RootfsLandingPage config={config} entry={selected} images={images} />
    );
  }

  return <RootfsNotFoundPage config={config} loading={loading && !error} />;
}
