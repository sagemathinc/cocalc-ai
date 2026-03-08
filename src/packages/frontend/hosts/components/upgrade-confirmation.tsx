import { React } from "@cocalc/frontend/app-framework";

export const UpgradeConfirmContent: React.FC = () => (
  <div>
    <ul style={{ margin: "8px 0 0 18px" }}>
      <li>Usually completes in a few seconds.</li>
      <li>Project-host upgrades may briefly reconnect browser and proxy traffic.</li>
      <li>Running workspace containers are not restarted in place.</li>
      <li>Newly started workspaces use the upgraded project bundle and tools.</li>
      <li>On failure the host rolls back to the previous project-host version.</li>
      <li>Active long-running work inside existing workspaces should continue, though UI updates may pause briefly while connections reconnect.</li>
    </ul>
  </div>
);
