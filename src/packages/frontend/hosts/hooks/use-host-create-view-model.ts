import { useMemo } from "@cocalc/frontend/app-framework";
import type { FormInstance } from "antd/es/form";
import type { HostProvider } from "../types";
import type {
  FieldOptionsMap,
  HostFieldLabels,
  HostFieldTooltips,
  ProviderFieldSchema,
} from "../providers/registry";

export type HostCreateViewModel = {
  permissions: {
    isAdmin: boolean;
    canCreateHosts: boolean;
  };
  form: {
    form: FormInstance;
    creating: boolean;
    onCreate: (vals: any) => Promise<boolean>;
    onCreated?: () => void;
  };
  provider: {
    providerOptions: Array<{ value: HostProvider; label: string }>;
    selectedProvider: HostProvider;
    fields: {
      schema: ProviderFieldSchema;
      options: FieldOptionsMap;
      labels: HostFieldLabels;
      tooltips: HostFieldTooltips;
    };
    storage: {
      storageModeOptions: Array<{ value: string; label: string }>;
      supportsPersistentStorage: boolean;
      persistentGrowable: boolean;
      showDiskFields: boolean;
    };
    catalogLoading?: boolean;
    catalogError?: string;
  };
  catalogRefresh: {
    refreshProviders: Array<{ value: HostProvider; label: string }>;
    refreshProvider: HostProvider;
    setRefreshProvider: (value: HostProvider) => void;
    refreshCatalog: (provider?: HostProvider) => Promise<boolean>;
    catalogRefreshing: boolean;
  };
};

type UseHostCreateViewModelArgs = HostCreateViewModel;

export const useHostCreateViewModel = (args: UseHostCreateViewModelArgs) =>
  useMemo(() => args, [args]);
