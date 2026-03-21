import { Space } from "antd";
import CreateBackup from "./create";
import EditBackupSchedule from "./edit-schedule";

export default function Backups({ onCreated }: { onCreated?: () => void }) {
  return (
    <Space.Compact>
      <CreateBackup onCreated={onCreated} />
      <EditBackupSchedule />
    </Space.Compact>
  );
}
