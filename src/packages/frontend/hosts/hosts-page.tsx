import { React } from "@cocalc/frontend/app-framework";
import { FreshAuthModal } from "@cocalc/frontend/auth/fresh-auth";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { HostCreateModal } from "./components/host-create-modal";
import { HostDrawer } from "./components/host-drawer";
import { HostEditModal } from "./components/host-edit-modal";
import { HostList } from "./components/host-list";
import { SelfHostRemoveModal } from "./components/self-host-remove-modal";
import { SelfHostSetupModal } from "./components/self-host-setup-modal";
import { WRAP_STYLE } from "./constants";
import {
  buildSimilarDraft,
  type HostCreateDraft,
} from "./create/host-create-draft";
import { useHostsPageViewModel } from "./hooks/use-hosts-page-view-model";

export const HostsPage: React.FC = () => {
  const {
    createVm,
    hostListVm,
    hostDrawerVm,
    editVm,
    setupVm,
    removeVm,
    freshAuthModalProps,
  } = useHostsPageViewModel();
  const [createModalOpen, setCreateModalOpen] = React.useState(false);
  const [initialCreateDraft, setInitialCreateDraft] =
    React.useState<HostCreateDraft | null>(null);
  const closeHostDrawer = hostDrawerVm.onClose;
  const openCreateSimilar = React.useCallback(
    (host: Host) => {
      const enabledProviders = createVm.provider.providerOptions.map(
        (option) => option.value,
      );
      const catalogByProvider = createVm.provider.catalog
        ? { [createVm.provider.selectedProvider]: createVm.provider.catalog }
        : {};
      const nextValues = buildSimilarDraft(host, {
        enabledProviders,
        catalogByProvider,
        billing: {
          fundingModeOptions: createVm.billing.fundingModeOptions,
          defaultFundingMode: createVm.billing.defaultFundingMode,
        },
      });
      closeHostDrawer();
      setInitialCreateDraft(nextValues);
      setCreateModalOpen(true);
    },
    [
      closeHostDrawer,
      createVm.billing.defaultFundingMode,
      createVm.billing.fundingModeOptions,
      createVm.provider.catalog,
      createVm.provider.providerOptions,
      createVm.provider.selectedProvider,
    ],
  );
  const hostDrawerVmWithCreateSimilar = React.useMemo(
    () => ({
      ...hostDrawerVm,
      onCreateSimilar: createVm.permissions.canCreateHosts
        ? openCreateSimilar
        : undefined,
    }),
    [createVm.permissions.canCreateHosts, hostDrawerVm, openCreateSimilar],
  );
  const createVmWithCloseOnCreate = React.useMemo(
    () => ({
      ...createVm,
      form: {
        ...createVm.form,
        onCreated: () => setCreateModalOpen(false),
      },
    }),
    [createVm],
  );
  const clearInitialCreateDraft = React.useCallback(
    () => setInitialCreateDraft(null),
    [],
  );

  const openCreateModal = React.useCallback(() => {
    setCreateModalOpen(true);
  }, []);
  const closeCreateModal = React.useCallback(() => {
    setCreateModalOpen(false);
    clearInitialCreateDraft();
  }, [clearInitialCreateDraft]);

  return (
    <div className="smc-vfill" style={WRAP_STYLE}>
      <div
        style={{
          background: "white",
          height: "100%",
          minHeight: 0,
          overflow: "auto",
          padding: "16px 0 0 15px",
        }}
      >
        <HostList
          vm={{
            ...hostListVm,
            createPanelOpen: createModalOpen,
            onToggleCreatePanel: openCreateModal,
          }}
        />
      </div>
      <HostCreateModal
        open={createModalOpen}
        onClose={closeCreateModal}
        vm={createVmWithCloseOnCreate}
        initialDraft={initialCreateDraft}
        onInitialDraftConsumed={clearInitialCreateDraft}
      />
      <HostDrawer vm={hostDrawerVmWithCreateSimilar} />
      <HostEditModal {...editVm} />
      <SelfHostSetupModal {...setupVm} />
      <SelfHostRemoveModal {...removeVm} />
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
};
