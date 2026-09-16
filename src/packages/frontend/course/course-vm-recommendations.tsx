import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type { ComputeCatalog } from "@cocalc/conat/hub/api/compute";
import type {
  ComputeFundingApi,
  CourseFundingCourseRequest,
} from "@cocalc/conat/hub/api/compute-funding";
import type {
  CourseVmRecommendations,
  CourseVmTemplate,
  CourseVmTemplateConfig,
} from "@cocalc/util/course-vm-template";
import {
  MAX_COURSE_VM_TEMPLATES,
  normalizeCourseVmTemplates,
} from "@cocalc/util/course-vm-template";
import { uuid } from "@cocalc/util/misc";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { getProviderOptions } from "@cocalc/frontend/hosts/providers/registry";
import {
  templateHardwarePatch,
  templateMachineChoices,
  templateOptionAvailable,
  templateSelection,
} from "./course-vm-template-model";

type Course = CourseFundingCourseRequest;
export type CourseVmRecommendationsApi = Pick<
  ComputeFundingApi,
  "getCourseVmRecommendations" | "setCourseVmRecommendations"
>;
const loadCatalog = () => webapp_client.conat_client.hub.compute.getCatalog({});

export function CourseVmRecommendationsEditor({
  course_project_id,
  course_instance_id,
  api,
  getCatalog = loadCatalog,
}: Course & {
  api: CourseVmRecommendationsApi;
  getCatalog?: () => Promise<ComputeCatalog>;
}) {
  const [saved, setSaved] = useState<CourseVmRecommendations>();
  const [templates, setTemplates] = useState<CourseVmTemplate[]>([]);
  const [editing, setEditing] = useState<
    Omit<Partial<CourseVmTemplate>, "config"> & {
      config: Partial<CourseVmTemplateConfig>;
    }
  >();
  const [catalog, setCatalog] = useState<ComputeCatalog>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<ComponentRef<typeof Button>>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    const version = ++generation.current;
    setSaved(undefined);
    setTemplates([]);
    setEditing(undefined);
    setBusy(true);
    setError("");
    setNotice("");
    api
      .getCourseVmRecommendations({ course_project_id, course_instance_id })
      .then((next) => {
        if (generation.current === version) {
          setSaved(next);
          setTemplates(normalizeCourseVmTemplates(next.templates));
        }
      })
      .catch((err) => {
        if (generation.current === version)
          setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (generation.current === version) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [api, course_project_id, course_instance_id, refresh]);
  useEffect(() => {
    if (editing) {
      wasEditing.current = true;
      heading.current?.focus();
    } else if (wasEditing.current) {
      wasEditing.current = false;
      addButton.current?.focus();
    }
  }, [editing?.id]);

  async function edit(template?: CourseVmTemplate) {
    const version = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await getCatalog();
      if (generation.current !== version) return;
      setCatalog(next);
      setEditing(
        template ?? {
          id: uuid(),
          label: "",
          config: templateHardwarePatch({
            ...next.defaults,
            pricing_model: "on_demand",
            gpu_count: 0,
          }),
        },
      );
    } catch (err) {
      if (generation.current === version)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  function applyEdit() {
    try {
      if (!editing) return;
      const [next] = normalizeCourseVmTemplates([editing]);
      setTemplates((rows) =>
        rows.some((item) => item.id === next.id)
          ? rows.map((item) => (item.id === next.id ? next : item))
          : [...rows, next],
      );
      setEditing(undefined);
      setError("");
      setNotice("Unsaved recommendations");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function save() {
    if (!saved || busy) return;
    const version = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.setCourseVmRecommendations({
        course_project_id,
        course_instance_id,
        templates: normalizeCourseVmTemplates(templates),
        expected_version: saved.version,
      });
      if (generation.current === version) {
        setSaved(next);
        setTemplates(next.templates);
        setNotice("Recommendations saved");
      }
    } catch (err) {
      if (generation.current === version)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  const config: Partial<CourseVmTemplateConfig> = editing?.config ?? {};
  const provider = config.provider ?? "gcp";
  const options = getProviderOptions(
    provider,
    catalog?.provider_catalogs[provider],
    templateSelection({ ...config, machine_type: undefined }),
  );
  const machines = catalog ? templateMachineChoices(catalog, config) : [];
  const machine = machines.find(
    (item) =>
      item.config.machine_type === config.machine_type &&
      item.config.provider_platform === config.provider_platform,
  );
  const patch = (values: Partial<CourseVmTemplateConfig>) =>
    setEditing(
      (row) => row && { ...row, config: { ...row.config, ...values } },
    );
  const dirty =
    !!saved && JSON.stringify(saved.templates) !== JSON.stringify(templates);
  return (
    <section aria-label="Recommended VM templates" style={{ marginBlock: 20 }}>
      <Typography.Title level={5}>Recommended VM templates</Typography.Title>
      <ul style={{ paddingInlineStart: 20 }}>
        {templates.map((template) => (
          <li key={template.id} style={{ marginBlock: 8 }}>
            <Space wrap>
              <span>
                {template.label}: {template.config.machine_type} (
                {template.config.region})
              </span>
              <Button
                aria-label={`Edit ${template.label}`}
                title={`Edit ${template.label}`}
                icon={<EditOutlined aria-hidden />}
                disabled={busy || !!editing}
                onClick={() => void edit(template)}
              />
              <Button
                aria-label={`Remove ${template.label}`}
                title={`Remove ${template.label}`}
                icon={<DeleteOutlined aria-hidden />}
                disabled={busy || !!editing}
                onClick={() => {
                  setTemplates((rows) =>
                    rows.filter((row) => row.id !== template.id),
                  );
                  setNotice("Unsaved recommendations");
                }}
              />
            </Space>
          </li>
        ))}
      </ul>
      {editing && (
        <div>
          <h5 tabIndex={-1} ref={heading}>
            Edit recommendation
          </h5>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit,minmax(min(100%,220px),1fr))",
              gap: 12,
            }}
          >
            <label>
              Recommendation label
              <Input
                aria-label="Recommendation label"
                value={editing.label ?? ""}
                maxLength={80}
                onChange={(event) =>
                  setEditing({ ...editing, label: event.target.value })
                }
              />
            </label>
            <label>
              Description
              <Input
                aria-label="Recommendation description"
                value={editing.description ?? ""}
                maxLength={500}
                onChange={(event) =>
                  setEditing({ ...editing, description: event.target.value })
                }
              />
            </label>
            <label>
              Provider
              <Select
                aria-label="Recommendation provider"
                style={{ width: "100%" }}
                value={provider}
                options={(catalog?.providers ?? []).map((value) => ({
                  value,
                  label: value === "gcp" ? "Google Cloud" : "Nebius",
                }))}
                onChange={(provider) =>
                  patch({
                    provider,
                    operating_system: "linux",
                    architecture: "x86_64",
                    region: undefined,
                    zone: undefined,
                    machine_type: undefined,
                    provider_platform: undefined,
                    gpu_type: undefined,
                    gpu_count: 0,
                  })
                }
              />
            </label>
            <label>
              Operating system
              <Select
                aria-label="Recommendation operating system"
                style={{ width: "100%" }}
                value={config.operating_system}
                options={[
                  { value: "linux", label: "Linux" },
                  ...(provider === "gcp"
                    ? [{ value: "windows", label: "Windows" }]
                    : []),
                ]}
                onChange={(operating_system) =>
                  patch({
                    operating_system,
                    machine_type: undefined,
                    gpu_type: undefined,
                    gpu_count: 0,
                  })
                }
              />
            </label>
            <label>
              Architecture
              <Select
                aria-label="Recommendation architecture"
                style={{ width: "100%" }}
                value={config.architecture}
                disabled={
                  provider === "nebius" || config.operating_system === "windows"
                }
                options={[
                  { value: "x86_64", label: "x86-64" },
                  { value: "arm64", label: "ARM64" },
                ]}
                onChange={(architecture) =>
                  patch({ architecture, machine_type: undefined })
                }
              />
            </label>
            <label>
              Pricing
              <Select
                aria-label="Recommendation pricing model"
                style={{ width: "100%" }}
                value={config.pricing_model}
                options={[
                  { value: "on_demand", label: "On demand" },
                  { value: "spot", label: "Spot" },
                ]}
                onChange={(pricing_model) =>
                  patch({ pricing_model, machine_type: undefined })
                }
              />
            </label>
            <label>
              Region
              <Select
                aria-label="Recommendation region"
                style={{ width: "100%" }}
                value={config.region}
                options={(options.region ?? [])
                  .filter(templateOptionAvailable)
                  .map(({ value, label }) => ({ value, label }))}
                onChange={(region) =>
                  patch({ region, zone: undefined, machine_type: undefined })
                }
              />
            </label>
            {provider === "gcp" && (
              <label>
                Zone
                <Select
                  aria-label="Recommendation zone"
                  style={{ width: "100%" }}
                  value={config.zone}
                  options={(options.zone ?? [])
                    .filter(templateOptionAvailable)
                    .map(({ value, label }) => ({ value, label }))}
                  onChange={(zone) => patch({ zone, machine_type: undefined })}
                />
              </label>
            )}
            {provider === "gcp" && (
              <label>
                GPU
                <Select
                  aria-label="Recommendation GPU"
                  style={{ width: "100%" }}
                  value={config.gpu_type ?? "none"}
                  disabled={config.operating_system === "windows"}
                  options={(options.gpu_type ?? []).map(({ value, label }) => ({
                    value,
                    label,
                  }))}
                  onChange={(gpu_type) =>
                    patch({
                      gpu_type: gpu_type === "none" ? undefined : gpu_type,
                      machine_type: undefined,
                    })
                  }
                />
              </label>
            )}
            <label>
              Machine
              <Select
                aria-label="Recommendation machine"
                style={{ width: "100%" }}
                value={machine?.value}
                options={machines.map(({ value, label }) => ({ value, label }))}
                onChange={(value) => {
                  const selected = machines.find(
                    (item) => item.value === value,
                  );
                  if (selected) patch(selected.config);
                }}
              />
            </label>
            <label>
              Boot disk (GB)
              <InputNumber
                aria-label="Recommendation boot disk GB"
                min={10}
                max={catalog?.limits.max_boot_disk_gb}
                value={config.boot_disk_gb}
                onChange={(value) =>
                  patch({ boot_disk_gb: value ?? undefined })
                }
                style={{ width: "100%" }}
              />
            </label>
          </div>
          <Space wrap style={{ marginBlock: 12 }}>
            <Button
              onClick={() => {
                setEditing(undefined);
                setError("");
              }}
            >
              Cancel edit
            </Button>
            <Button
              icon={<PlusOutlined aria-hidden />}
              onClick={applyEdit}
              disabled={
                !machine ||
                !config.region ||
                (provider === "gcp" && !config.zone)
              }
            >
              Apply recommendation
            </Button>
          </Space>
        </div>
      )}
      {error && <Alert type="error" showIcon title={error} />}
      <Space wrap style={{ marginBlock: 8 }}>
        <Button
          icon={<PlusOutlined aria-hidden />}
          ref={addButton}
          disabled={
            !saved ||
            busy ||
            !!editing ||
            templates.length >= MAX_COURSE_VM_TEMPLATES
          }
          onClick={() => void edit()}
        >
          Add recommendation
        </Button>
        <Button
          icon={<SaveOutlined aria-hidden />}
          disabled={!dirty || busy || !!editing}
          loading={busy && !!saved}
          onClick={() => void save()}
        >
          Save recommendations
        </Button>
        <Button
          icon={<ReloadOutlined aria-hidden />}
          disabled={busy || !!editing}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Reload recommendations
        </Button>
      </Space>
      {notice && <div role="status">{notice}</div>}
    </section>
  );
}
