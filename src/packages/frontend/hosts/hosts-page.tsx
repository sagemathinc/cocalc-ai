import { React } from "@cocalc/frontend/app-framework";
import { FreshAuthModal } from "@cocalc/frontend/auth/fresh-auth";
import { cocalc_setup_profile } from "@cocalc/frontend/components/constants";
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

const IS_STAR_SETUP_PROFILE = cocalc_setup_profile === "star";

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
  const [similarSourceHost, setSimilarSourceHost] = React.useState<Pick<
    Host,
    "id" | "name"
  > | null>(null);
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
      createVm.form.form.setFieldsValue({ provider: nextValues.provider });
      if (
        createVm.catalogRefresh.refreshProviders.some(
          (option) => option.value === nextValues.provider,
        )
      ) {
        createVm.catalogRefresh.setRefreshProvider(nextValues.provider);
      }
      closeHostDrawer();
      setInitialCreateDraft(nextValues);
      setSimilarSourceHost({ id: host.id, name: host.name });
      setCreateModalOpen(true);
    },
    [
      closeHostDrawer,
      createVm.billing.defaultFundingMode,
      createVm.billing.fundingModeOptions,
      createVm.catalogRefresh,
      createVm.form.form,
      createVm.provider.catalog,
      createVm.provider.providerOptions,
      createVm.provider.selectedProvider,
    ],
  );
  const hostDrawerVmWithCreateSimilar = React.useMemo(
    () => ({
      ...hostDrawerVm,
      onCreateSimilar:
        !IS_STAR_SETUP_PROFILE && createVm.permissions.canCreateHosts
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
    clearInitialCreateDraft();
    setSimilarSourceHost(null);
    setCreateModalOpen(true);
  }, [clearInitialCreateDraft]);
  const closeCreateModal = React.useCallback(() => {
    setCreateModalOpen(false);
    clearInitialCreateDraft();
    setSimilarSourceHost(null);
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
            onToggleCreatePanel: IS_STAR_SETUP_PROFILE
              ? undefined
              : openCreateModal,
          }}
        />
      </div>
      <HostCreateModal
        open={createModalOpen}
        onClose={closeCreateModal}
        vm={createVmWithCloseOnCreate}
        initialDraft={initialCreateDraft}
        sourceHost={similarSourceHost}
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
