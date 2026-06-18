/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * ProjectsTableControls - Control bar above the projects table
 *
 * Contains: search input, hashtag filter dropdown, status filter switches,
 * and create project button.
 */

import type { SelectProps } from "antd";
import type { ChangeEvent, ReactNode } from "react";

import { Button, Input, Select, Space, Switch, Typography } from "antd";
import { Set } from "immutable";
import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import { CSS, useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { COLORS } from "@cocalc/util/theme";

import { get_visible_hashtags } from "./util";

const CONTROLS_STYLE: CSS = {
  width: "100%",
  marginTop: "10px",
  marginBottom: 0,
  borderRadius: "4px",
  display: "flex",
  flexDirection: "row",
  justifyContent: "space-between",
} as const;

const SEARCH_DEBOUNCE_MS = 250;

interface Props {
  visible_projects: string[];
  tour: ReactNode;
  searchRef: React.RefObject<any>;
  filtersRef: React.RefObject<any>;
  projectListChanged?: boolean;
  projectListChangedCount?: number;
  onRefreshProjectList?: () => void;
}

export function ProjectsTableControls({
  visible_projects,
  tour,
  searchRef,
  filtersRef,
  projectListChanged = false,
  projectListChangedCount = 0,
  onRefreshProjectList,
}: Props) {
  const intl = useIntl();
  const actions = useActions("projects");

  // Redux state
  const search = useTypedRedux("projects", "search");
  const hidden = useTypedRedux("projects", "hidden");
  const selected_hashtags = useTypedRedux("projects", "selected_hashtags");
  const project_map = useTypedRedux("projects", "project_map");
  const [searchDraft, setSearchDraft] = useState(search ?? "");
  const searchUpdating = searchDraft !== (search ?? "");

  useEffect(() => {
    setSearchDraft(search ?? "");
  }, [search]);

  useEffect(() => {
    if (!searchUpdating) return;
    const timeout = setTimeout(() => {
      actions.setState({ search: searchDraft });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [actions, searchDraft, searchUpdating]);

  // Get filter key for current state
  const filter = useMemo(() => {
    return `${!!hidden}`;
  }, [hidden]);

  // Get all available hashtags
  const visible_hashtags = useMemo(() => {
    return get_visible_hashtags(project_map, visible_projects);
  }, [project_map, visible_projects]);

  // Transform hashtags for Select options
  const hashtagOptions: SelectProps["options"] = useMemo(() => {
    return visible_hashtags.map((tag) => ({
      label: tag,
      value: tag,
    }));
  }, [visible_hashtags]);

  // Get currently selected hashtags as array
  const selectedHashtagsArray = useMemo(() => {
    return selected_hashtags?.get(filter)?.toArray() ?? [];
  }, [selected_hashtags, filter]);

  function handleHashtagChange(values: string[]) {
    // Update selected hashtags in Redux
    actions.setState({
      selected_hashtags: selected_hashtags?.set(filter, Set(values)),
    });
  }

  function commitSearch() {
    if (searchUpdating) {
      actions.setState({ search: searchDraft });
    }
  }

  function handleSearchChange(e: ChangeEvent<HTMLInputElement>) {
    setSearchDraft(e.target.value);
  }

  function handlePressEnter() {
    commitSearch();
    if (searchUpdating) return;
    if (visible_projects.length > 0) {
      actions.open_project({
        project_id: visible_projects[0],
        target: "files/",
      });
    }
  }

  return (
    <Space style={CONTROLS_STYLE} orientation="horizontal">
      {/* Left section: Search and Hashtags */}
      <Space wrap ref={searchRef}>
        <Input.Search
          placeholder={intl.formatMessage({
            id: "projects.table-controls.search.placeholder",
            defaultMessage: "Filter projects...",
          })}
          autoFocus
          value={searchDraft}
          onChange={handleSearchChange}
          onPressEnter={handlePressEnter}
          style={{ width: IS_MOBILE ? 125 : 250 }}
          allowClear
        />
        {searchUpdating && (
          <Typography.Text type="secondary" style={{ whiteSpace: "nowrap" }}>
            Updating...
          </Typography.Text>
        )}

        <Select
          mode="multiple"
          allowClear
          showSearch
          disabled={hashtagOptions.length === 0}
          style={{ width: IS_MOBILE ? 100 : 200 }}
          placeholder={intl.formatMessage({
            id: "projects.table-controls.hashtags.placeholder",
            defaultMessage: "Filter by hashtags...",
          })}
          value={selectedHashtagsArray}
          onChange={handleHashtagChange}
          options={hashtagOptions}
          maxTagCount="responsive"
        />
        {/* Filter switches */}
        <Space ref={filtersRef}>
          <Switch
            checked={hidden}
            onChange={(checked) => actions.display_hidden_projects(checked)}
            checkedChildren={intl.formatMessage({
              id: "projects.table-controls.hidden.label",
              defaultMessage: "Hidden",
            })}
            unCheckedChildren={intl.formatMessage({
              id: "projects.table-controls.hidden.label",
              defaultMessage: "Hidden",
            })}
          />
          {projectListChanged && (
            <Button
              size="small"
              type="text"
              icon={<Icon name="sync-alt" />}
              onClick={onRefreshProjectList}
              title="Refresh project list"
              style={{
                background: COLORS.YELL_LLL,
                color: "black",
                borderRadius: 4,
                whiteSpace: "nowrap",
              }}
            >
              Refresh project list
              {projectListChangedCount > 1
                ? ` (${projectListChangedCount})`
                : ""}
            </Button>
          )}
        </Space>
      </Space>

      {/* Right section: Tour only */}
      <Space>{tour}</Space>
    </Space>
  );
}
