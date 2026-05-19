import type { FormInstance } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { HostProvider } from "../types";
import {
  applyPreset,
  buildDefaultDraft,
  normalizeDraft,
  type HostCreateDraft,
  type HostCreateDraftContext,
  type HostCreatePresetId,
  type NormalizedHostCreateDraft,
} from "./host-create-draft";

type UseHostCreateDraftArgs = {
  form: FormInstance;
  context: HostCreateDraftContext;
  initialDraft?: HostCreateDraft | null;
  onInitialDraftConsumed?: () => void;
};

const FORM_SYNC_FIELDS: Array<keyof HostCreateDraft> = [
  "name",
  "provider",
  "funding_mode",
  "start_after_create",
  "region_preference",
  "price_display",
  "pricing_model",
  "interruption_restore_policy",
  "spot_recovery_policy",
  "storage_mode",
  "disk_gb",
  "disk",
  "disk_type",
  "region",
  "zone",
  "machine_type",
  "gpu_type",
  "size",
  "gpu",
  "self_host_kind",
  "self_host_mode",
  "self_host_ssh_target",
  "cpu",
  "ram_gb",
  "auto_grow_enabled",
  "auto_grow_max_disk_gb",
  "auto_grow_growth_step_gb",
  "auto_grow_min_grow_interval_minutes",
];

function formPatchForDraft(form: FormInstance, draft: HostCreateDraft) {
  const patch: Record<string, unknown> = {};
  for (const field of FORM_SYNC_FIELDS) {
    if (form.getFieldValue(field) !== draft[field]) {
      patch[field] = draft[field];
    }
  }
  return patch;
}

function sameDraft(a: HostCreateDraft, b: HostCreateDraft) {
  for (const field of FORM_SYNC_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  return true;
}

export function useHostCreateDraft({
  form,
  context,
  initialDraft,
  onInitialDraftConsumed,
}: UseHostCreateDraftArgs): NormalizedHostCreateDraft & {
  onValuesChange: (_changedValues: any, allValues: any) => void;
  setProvider: (provider: HostProvider) => void;
  applyPreset: (presetId: HostCreatePresetId) => void;
  resetDefault: () => void;
} {
  const [draft, setDraft] = React.useState<HostCreateDraft>(() =>
    buildDefaultDraft(context),
  );
  const normalized = React.useMemo(
    () => normalizeDraft(draft, context),
    [context, draft],
  );

  React.useEffect(() => {
    if (!initialDraft) return;
    setDraft(normalizeDraft(initialDraft, context).draft);
    onInitialDraftConsumed?.();
  }, [context, initialDraft, onInitialDraftConsumed]);

  React.useEffect(() => {
    const next = normalizeDraft(draft, context).draft;
    if (!sameDraft(next, draft)) {
      setDraft(next);
    }
  }, [context, draft]);

  React.useEffect(() => {
    const patch = formPatchForDraft(form, normalized.draft);
    if (Object.keys(patch).length > 0) {
      form.setFieldsValue(patch);
    }
  }, [form, normalized.draft]);

  const onValuesChange = React.useCallback(
    (_changedValues: any, allValues: any) => {
      setDraft(
        normalizeDraft({ ...normalized.draft, ...allValues }, context).draft,
      );
    },
    [context, normalized.draft],
  );

  const setProvider = React.useCallback(
    (provider: HostProvider) => {
      setDraft(
        normalizeDraft({ ...normalized.draft, provider }, context).draft,
      );
    },
    [context, normalized.draft],
  );

  const applyCreatePreset = React.useCallback(
    (presetId: HostCreatePresetId) => {
      setDraft(applyPreset(presetId, normalized.draft, context));
    },
    [context, normalized.draft],
  );

  const resetDefault = React.useCallback(() => {
    setDraft(buildDefaultDraft(context));
    form.resetFields();
  }, [context, form]);

  return {
    ...normalized,
    onValuesChange,
    setProvider,
    applyPreset: applyCreatePreset,
    resetDefault,
  };
}
