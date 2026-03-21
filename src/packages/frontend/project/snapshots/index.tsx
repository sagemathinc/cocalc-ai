/*
The Snapshots button pops up a model that let you:

 - create a new snapshot
 - edit the automatic snapshot schedule
*/

import { Space } from "antd";
import CreateSnapshot from "./create";
import EditSchedule from "./edit-schedule";
import RestoreSnapshot from "./restore";

export default function Snapshots({ onCreated }: { onCreated?: () => void }) {
  return (
    <Space.Compact>
      <CreateSnapshot onCreated={onCreated} />
      <RestoreSnapshot />
      <EditSchedule />
    </Space.Compact>
  );
}
