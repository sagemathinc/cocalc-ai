/*
The Snapshots button pops up a model that let you:

 - create a new snapshot
 - edit the automatic snapshot schedule
*/

import { Space } from "antd";
import CreateSnapshot from "./create";
import EditSchedule from "./edit-schedule";
import RestoreSnapshot from "./restore";

export default function Snapshots() {
  return (
    <Space.Compact>
      <CreateSnapshot />
      <RestoreSnapshot />
      <EditSchedule />
    </Space.Compact>
  );
}
