/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { User } from "@cocalc/frontend/users";
import { Icon, TimeAgo, r_join } from "../components";
import { FileUseIcon } from "./icon";
import type { Map as iMap } from "immutable";
import { Col, Grid, Row } from "@cocalc/frontend/antd-bootstrap";
import * as misc from "@cocalc/util/misc";
import { open_file_use_entry } from "./util";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import { CSS } from "../app-framework";
import type { RecentDocumentActivityEntry } from "./types";

const MAX_USERS = 5;
const TRUNCATE_LENGTH = 50;

const rowStyle: CSS = {
  cursor: "pointer",
  width: "100%",
  color: "#666",
  background: "#fefefe",
};

interface Props {
  info: RecentDocumentActivityEntry;
  account_id: string;
  user_map: iMap<string, any>;
  cursor?: boolean;
}

export function FileUseInfo({ info, account_id, user_map, cursor }: Props) {
  function open(e): void {
    e?.preventDefault?.();
    void open_file_use_entry(info.project_id, info.path, false);
  }

  function renderPath() {
    let { name, ext } = misc.separate_file_extension(info.path);
    name = misc.trunc_middle(name, TRUNCATE_LENGTH);
    ext = misc.trunc_middle(ext, TRUNCATE_LENGTH);
    return (
      <span>
        <span style={{ fontWeight: 600 }}>{name}</span>
        <span style={{ color: "#999" }}>{ext === "" ? "" : `.${ext}`}</span>
      </span>
    );
  }

  function renderUsers() {
    const ids = Array.isArray(info.recent_account_ids)
      ? info.recent_account_ids.filter(Boolean).slice(0, MAX_USERS)
      : [];
    if (ids.length === 0) return <>someone</>;
    return r_join(
      ids.map((id) => (
        <User
          key={id}
          account_id={id}
          name={id === account_id ? "You" : undefined}
          user_map={user_map}
        />
      )),
    );
  }

  const style = misc.copy(rowStyle);
  if (cursor) {
    misc.merge(style, { background: "#08c", color: "white" });
  }

  return (
    <Grid style={style} onClick={open}>
      <Row style={{ padding: "5px" }}>
        <Col sm={1} style={{ fontSize: "14pt" }}>
          <Icon name="history" />
        </Col>
        <Col sm={10}>
          {renderPath()} in{" "}
          <ProjectTitle
            style={{
              background: "white",
              padding: "0px 5px",
              borderRadius: "3px",
            }}
            project_id={info.project_id}
          />{" "}
          was accessed <TimeAgo date={info.last_accessed} /> by {renderUsers()}
        </Col>
        <Col sm={1} style={{ fontSize: "14pt" }}>
          <FileUseIcon filename={info.path} />
        </Col>
      </Row>
    </Grid>
  );
}
