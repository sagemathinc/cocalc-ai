import { React } from "@cocalc/frontend/app-framework";

export const UpgradeConfirmContent: React.FC = () => (
  <div>
    <ul style={{ margin: "8px 0 0 18px" }}>
      <li>Usually completes in a few seconds.</li>
      <li>
        Project-host upgrades may briefly reconnect browser and proxy traffic.
      </li>
      <li>Running project containers are not restarted in place.</li>
      <li>Newly started projects use the upgraded project bundle and tools.</li>
      <li>
        On failure the host rolls back to the previous project-host version.
      </li>
      <li>
        Active long-running work inside existing projects should continue,
        though UI updates may pause briefly while connections reconnect.
      </li>
    </ul>
  </div>
);

export const UpgradeAllConfirmContent: React.FC = () => (
  <div>
    <ul style={{ margin: "8px 0 0 18px" }}>
      <li>Usually completes in a few seconds.</li>
      <li>
        This explicitly aligns the managed runtime stack: project-host,
        conat-router, conat-persist, and acp-worker.
      </li>
      <li>
        Browser, terminal, proxy, and Codex traffic may reconnect while those
        daemons roll forward.
      </li>
      <li>Running project containers are not restarted in place.</li>
      <li>
        Active Codex turns may be interrupted if the ACP worker is replaced.
      </li>
    </ul>
  </div>
);
