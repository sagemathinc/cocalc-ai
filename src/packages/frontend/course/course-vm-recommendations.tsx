import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentRef } from "react";
import { Alert, Button, Input, Space, Typography } from "antd";
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
import { templateHardwarePatch } from "./course-vm-template-model";
import {
  VmCreateModal,
  type VmDraft,
} from "@cocalc/frontend/project/compute-vms";

type Course = CourseFundingCourseRequest;
export type CourseVmRecommendationsApi = Pick<
  ComputeFundingApi,
  "getCourseVmRecommendations" | "setCourseVmRecommendations"
>;
const loadCatalog = () => webapp_client.conat_client.hub.compute.getCatalog({});

function recommendationConfig(values: VmDraft): CourseVmTemplateConfig {
  return {
    provider: values.provider,
    operating_system: values.operating_system,
    architecture: values.architecture,
    region: values.region,
    ...(values.zone ? { zone: values.zone } : {}),
    machine_type: values.machine_type,
    ...(values.provider_platform
      ? { provider_platform: values.provider_platform }
      : {}),
    ...(values.gpu_type ? { gpu_type: values.gpu_type } : {}),
    gpu_count: values.gpu_count ?? 0,
    pricing_model: values.pricing_model,
    boot_disk_gb: values.boot_disk_gb,
  };
}

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
  function applyEdit(values: VmDraft) {
    try {
      if (!editing) return;
      const [next] = normalizeCourseVmTemplates([
        { ...editing, config: recommendationConfig(values) },
      ]);
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
  const recommendationInitial: VmDraft | undefined = useMemo(
    () =>
      editing && catalog
        ? {
            ...catalog.defaults,
            name: "recommended-vm",
            funding_mode: catalog.default_funding_mode,
            pricing_model: "on_demand",
            allow_on_demand_fallback: false,
            stop_after_minutes: 360,
            use_project_ssh_key: false,
            configure_project_ssh: false,
            ...editing.config,
            gpu_count: editing.config.gpu_count ?? 0,
          }
        : undefined,
    [catalog, editing?.config],
  );
  const dirty =
    !!saved && JSON.stringify(saved.templates) !== JSON.stringify(templates);
  return (
    <section aria-label="Recommended VM templates" style={{ marginBlock: 20 }}>
      <Typography.Title level={5}>Recommended VM templates</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="GCP public network usage is a course-payer charge"
        description="CoCalc stops a course-funded GCP VM after its network spending threshold is observed, but GCP reports usage after traffic is sent. The course payer is responsible for the actual $0.10/GB charge, which can slightly exceed a student's remaining allocation before automatic shutdown completes."
      />
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
      {editing && catalog && recommendationInitial && (
        <VmCreateModal
          open
          mode="recommendation"
          catalog={catalog}
          volumes={[]}
          initial={recommendationInitial}
          projectSshPublicKey={null}
          sshKeys={[]}
          preferredR2Region={undefined}
          saving={busy}
          onCancel={() => {
            setEditing(undefined);
            setError("");
          }}
          onCreate={async (values) => applyEdit(values)}
          intro={
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit,minmax(min(100%,220px),1fr))",
                gap: 12,
                marginBottom: 16,
              }}
            >
              <label>
                Recommendation label
                <Input
                  autoFocus
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
            </div>
          }
        />
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
