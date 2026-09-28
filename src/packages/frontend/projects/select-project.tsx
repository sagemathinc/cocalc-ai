/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Component for selecting a project.

import { Checkbox, Select } from "antd";
import { useMemo, useState, useTypedRedux } from "../app-framework";
import type { CSS } from "../app-framework";
import { webapp_client } from "../webapp-client";
import { Loading } from "../components";

export type ProjectSelectionList = {
  id: string;
  title: string;
  group?: string;
}[];

interface CommonProps {
  ariaLabel?: string;
  exclude?: string[]; // project_id's to exclude
  at_top?: string[]; // include these projects at the top of the selector first (assuming they are in the project_map)
  disabled?: boolean;
  fullCollaboratorOnly?: boolean;
  // A bounded server-filtered page, e.g. the People shared-project directory.
  projects?: ProjectSelectionList;
  onSearch?: (search: string) => void;
  maxResults?: number;
  maxSelections?: number;
  autoFocus?: boolean;
  style?: CSS;
}

type Props = CommonProps &
  (
    | {
        multiple: true;
        onChange: (project_ids: string[]) => void;
        value?: string[];
        defaultValue?: string[];
      }
    | {
        multiple?: false;
        onChange: (project_id: string) => void;
        value?: string;
        defaultValue?: string;
      }
  );

function fullCollaboratorGroup(group: unknown): boolean {
  return group === "owner" || group === "collaborator";
}

function hasFullCollaboratorAccess(project: any, account_id?: string): boolean {
  if (!account_id) return false;
  return fullCollaboratorGroup(project?.users?.[account_id]?.group);
}

export function SelectProject(props: Props) {
  const {
    ariaLabel,
    exclude,
    at_top,
    disabled = false,
    fullCollaboratorOnly = false,
    value,
    defaultValue,
    multiple = false,
    projects,
    onSearch,
    maxResults = 100,
    maxSelections,
    autoFocus,
    style,
  } = props;
  const project_map = useTypedRedux("projects", "project_map");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState(defaultValue);
  const selected = "value" in props ? value : selection;

  // include hidden projects in the selector
  const [include_hidden, set_include_hidden] = useState<boolean>(false);

  const data: undefined | ProjectSelectionList = useMemo(() => {
    if (projects != null) {
      return projects.filter(
        (project) =>
          !exclude?.includes(project.id) &&
          (!fullCollaboratorOnly || fullCollaboratorGroup(project.group)),
      );
    }
    if (project_map == null) {
      return;
    }
    let map = project_map;
    const { account_id } = webapp_client;
    const data: ProjectSelectionList = [];

    if (exclude != null) {
      for (const project_id of exclude) {
        if (project_id != null && map.has(project_id)) {
          map = map.delete(project_id);
        }
      }
    }

    if (at_top != null) {
      for (const project_id of at_top) {
        if (project_id != null && map.has(project_id)) {
          if (
            fullCollaboratorOnly &&
            !fullCollaboratorGroup(
              map.getIn([project_id, "users", account_id ?? "", "group"]),
            )
          ) {
            continue;
          }
          data.push({
            id: project_id,
            title: map.getIn([project_id, "title"]) as string,
          });
          map = map.delete(project_id);
        }
      }
    }

    // sort by last edited (newest first)
    const v = map.valueSeq().toJS();
    v.sort(function (a, b) {
      if (a.last_edited < b.last_edited) {
        return 1;
      } else if (a.last_edited > b.last_edited) {
        return -1;
      }
      return 0;
    });

    const others: ProjectSelectionList = [];
    for (let i of v) {
      if (fullCollaboratorOnly && !hasFullCollaboratorAccess(i, account_id)) {
        continue;
      }
      const is_hidden = !!i.users?.[account_id ?? ""]?.hide;
      if (
        (Array.isArray(selected)
          ? selected.includes(i.project_id)
          : i.project_id === selected) ||
        is_hidden == include_hidden
      ) {
        others.push({ id: i.project_id, title: i.title });
      }
    }
    return data.concat(others);
  }, [
    project_map,
    exclude,
    at_top,
    fullCollaboratorOnly,
    include_hidden,
    selected,
    projects,
  ]);

  if (data == null) {
    return <Loading />;
  }

  const matches = onSearch
    ? data
    : data.filter((project) =>
        project.title.toLowerCase().includes(search.toLowerCase()),
      );
  const visible = matches.slice(0, maxResults);
  // Keep selected labels available even when searching another bounded page.
  for (const project of data) {
    if (
      (Array.isArray(selected)
        ? selected.includes(project.id)
        : selected === project.id) &&
      !visible.some(({ id }) => id === project.id)
    )
      visible.push(project);
  }

  return (
    <div style={style}>
      <div style={{ display: "flex", flexDirection: "row" }}>
        <Select
          aria-label={ariaLabel ?? (multiple ? "Projects" : "Project")}
          autoFocus={autoFocus}
          mode={multiple ? "multiple" : undefined}
          maxCount={multiple ? maxSelections : undefined}
          allowClear
          disabled={disabled}
          style={{ marginRight: "15px", flex: 1, minWidth: 0 }}
          showSearch={true}
          placeholder={"Select a project..."}
          optionFilterProp={"children"}
          value={selected}
          onChange={(next) => {
            setSelection(next);
            if (props.multiple) props.onChange(Array.isArray(next) ? next : []);
            else props.onChange(next as string);
          }}
          onSearch={(next) => {
            setSearch(next);
            onSearch?.(next);
          }}
          filterOption={false}
        >
          {visible.map((v) => (
            <Select.Option key={v.id} value={v.id}>
              {v.title}
            </Select.Option>
          ))}
        </Select>
        {projects == null && (
          <div style={{ margin: "auto" }}>
            <Checkbox
              disabled={disabled}
              checked={include_hidden}
              onChange={(e) => set_include_hidden(e.target.checked)}
            >
              Hidden
            </Checkbox>
          </div>
        )}
      </div>
      {matches.length > maxResults && (
        <div role="status">
          Showing {maxResults} matches. Search to narrow projects.
        </div>
      )}
    </div>
  );
}
