import type { FormInstance } from "antd";
import { Form } from "antd";

export const useHostFormValues = (form: FormInstance) => {
  const selectedRegion = Form.useWatch("region", form);
  const selectedZone = Form.useWatch("zone", form);
  const selectedMachineType = Form.useWatch("machine_type", form);
  const selectedGpuType = Form.useWatch("gpu_type", form);
  const selectedSelfHostKind = Form.useWatch("self_host_kind", form);
  const selectedSelfHostMode = Form.useWatch("self_host_mode", form);
  const selectedGpu = Form.useWatch("gpu", form);
  const selectedSize = Form.useWatch("size", form);
  const selectedStorageMode = Form.useWatch("storage_mode", form);

  return {
    selectedRegion,
    selectedZone,
    selectedMachineType,
    selectedGpuType,
    selectedSelfHostKind,
    selectedSelfHostMode,
    selectedGpu,
    selectedSize,
    selectedStorageMode,
  };
};
