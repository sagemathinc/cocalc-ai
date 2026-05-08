import type { FormInstance } from "antd";
import { Form } from "antd";

export const useHostFormValues = (form: FormInstance) => {
  const selectedRegion = Form.useWatch("region", form);
  const selectedZone = Form.useWatch("zone", form);
  const selectedMachineType = Form.useWatch("machine_type", form);
  const selectedGpuType = Form.useWatch("gpu_type", form);
  const selectedPricingModel = Form.useWatch("pricing_model", form);
  const selectedDiskType = Form.useWatch("disk_type", form);
  const selectedDisk = Form.useWatch("disk", form);
  const selectedDiskGbValue = Form.useWatch("disk_gb", form);
  const selectedSelfHostKind = Form.useWatch("self_host_kind", form);
  const selectedSelfHostMode = Form.useWatch("self_host_mode", form);
  const selectedGpu = Form.useWatch("gpu", form);
  const selectedSize = Form.useWatch("size", form);
  const selectedStorageMode = Form.useWatch("storage_mode", form);
  const selectedRegionPreference = Form.useWatch("region_preference", form);
  const selectedDiskGb =
    typeof selectedDiskGbValue === "number"
      ? selectedDiskGbValue
      : typeof selectedDisk === "number"
        ? selectedDisk
        : undefined;

  return {
    selectedRegion,
    selectedZone,
    selectedMachineType,
    selectedGpuType,
    selectedPricingModel,
    selectedDiskType,
    selectedDiskGb,
    selectedSelfHostKind,
    selectedSelfHostMode,
    selectedGpu,
    selectedSize,
    selectedStorageMode,
    selectedRegionPreference,
  };
};
