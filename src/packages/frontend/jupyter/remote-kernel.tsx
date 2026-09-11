import { useEffect, useId, useRef, useState } from "react";
import type { InputRef } from "antd";
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Tabs,
} from "antd";
import RemoteKernelTargets from "./remote-kernel-targets";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  setupRemoteKernel,
  remoteSshTargets,
  probeRemoteKernel,
  suggestedEnvironment,
  type RemoteKernelProbe,
  type RemoteKernelSetup,
} from "./remote-kernel-service";

export default function RemoteKernel({
  project_id,
  onRegistered,
  onRemoved,
}: {
  project_id: string;
  onRegistered: (name: string) => Promise<void>;
  onRemoved?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasWarning, setAliasWarning] = useState<string>();
  const [host, setHost] = useState("");
  const [probe, setProbe] = useState<RemoteKernelProbe>();
  const [choice, setChoice] = useState("python");
  const [mode, setMode] = useState("prepare");
  const [advanced, setAdvanced] = useState(false);
  const [searchPath, setSearchPath] = useState("");
  const [form] = Form.useForm<RemoteKernelSetup>();
  const formId = useId();
  const hostInput = useRef<InputRef>(null);
  const generation = useRef(0);
  const edited = useRef(new Set<string>());
  const [tab, setTab] = useState("setup");
  useEffect(() => {
    setProbe(undefined);
    setHost("");
    setChecking(false);
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [project_id]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void remoteSshTargets(project_id)
      .then((result) => {
        if (!active) return;
        setAliases(result.aliases);
        setAliasWarning(result.warnings.join("\n") || undefined);
      })
      .catch((err) => {
        if (active) setAliasWarning(String(err));
      });
    return () => {
      active = false;
    };
  }, [open, project_id]);

  function defaults(
    result: RemoteKernelProbe,
    target: string,
    selection: string,
  ) {
    const values: Partial<RemoteKernelSetup> = {};
    if (!edited.current.has("name")) values.name = result.suggested_name;
    if (!edited.current.has("environment"))
      values.environment = suggestedEnvironment(
        target,
        selection,
        result.environments,
      );
    if (!edited.current.has("recipe") || result.gpu.status !== "available")
      values.recipe =
        selection === "pytorch-cu128" ? "pytorch-cu128" : "python";
    form.setFieldsValue(values);
  }
  async function connect(target = host) {
    const current = ++generation.current;
    setHost(target);
    setProbe(undefined);
    setChecking(true);
    setError(undefined);
    try {
      const result = await probeRemoteKernel(
        project_id,
        target,
        searchPath || undefined,
      );
      if (current !== generation.current) return;
      const selected =
        probe &&
        target === host &&
        (result.kernels.some((kernel) => kernel.id === choice) ||
          choice === "python" ||
          (choice === "pytorch-cu128" && result.gpu.status === "available"))
          ? choice
          : result.gpu.status === "available"
            ? "pytorch-cu128"
            : result.kernels[0]?.id || "python";
      setProbe(result);
      setChoice(selected);
      defaults(result, target, selected);
    } catch (err) {
      if (current === generation.current) setError(String(err));
    } finally {
      if (current === generation.current) setChecking(false);
    }
  }
  function changeHost(value: string) {
    generation.current++;
    setHost(value);
    setProbe(undefined);
    setChecking(false);
    setError(undefined);
  }
  async function submit(values: RemoteKernelSetup) {
    if (busy || checking || !probe) return;
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      if (
        mode !== "existing" &&
        !choice.startsWith("/") &&
        values.recipe === "pytorch-cu128" &&
        probe.gpu.status !== "available"
      ) {
        throw Error(
          "GPU availability must be confirmed before preparing PyTorch.",
        );
      }
      const name = await setupRemoteKernel(project_id, {
        ...values,
        host,
        kernel:
          mode !== "existing" && choice.startsWith("/") ? choice : undefined,
        python: mode === "existing" ? values.python : undefined,
        recipe:
          mode === "existing" || choice.startsWith("/")
            ? undefined
            : values.recipe,
      });
      if (current !== generation.current) return;
      await onRegistered(name);
      if (current !== generation.current) return;
      setOpen(false);
    } catch (err) {
      if (current === generation.current) setError(String(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        size="small"
        icon={<Icon name="server" />}
        onClick={() => setOpen(true)}
      >
        Remote kernel
      </Button>
      <Modal
        title="Remote Jupyter kernel"
        open={open}
        footer={null}
        width={560}
        onCancel={() => {
          if (!busy) {
            generation.current++;
            setChecking(false);
            setOpen(false);
          }
        }}
        mask={{ closable: !busy }}
        keyboard={!busy}
        closable={!busy}
        afterOpenChange={(visible) => {
          if (visible && tab === "setup") hostInput.current?.focus();
        }}
      >
        <KeyboardBoundary boundary="remote-kernel">
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              { key: "setup", label: "Register", disabled: busy },
              { key: "targets", label: "Registered kernels", disabled: busy },
            ]}
          />
          {tab === "targets" && (
            <RemoteKernelTargets
              project_id={project_id}
              onRemoved={onRemoved}
            />
          )}
          <div hidden={tab !== "setup"}>
            {aliasWarning && (
              <Alert
                type="warning"
                title="SSH alias discovery"
                description={aliasWarning}
                showIcon
              />
            )}
            <label htmlFor={`${formId}-host`}>SSH destination or alias</label>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                margin: "8px 0 16px",
              }}
            >
              <AutoComplete
                virtual={false}
                value={host}
                onChange={changeHost}
                onSelect={(value) => void connect(value)}
                disabled={busy}
                options={aliases.map((value) => ({ value }))}
                style={{ flex: "1 1 240px", minWidth: 0 }}
                filterOption={(input, option) =>
                  !!option?.value.toLowerCase().includes(input.toLowerCase())
                }
              >
                <Input
                  id={`${formId}-host`}
                  ref={hostInput}
                  placeholder="user@vm.example.com"
                  autoComplete="off"
                  onPressEnter={(event) => {
                    event.preventDefault();
                    void connect();
                  }}
                />
              </AutoComplete>
              <Button
                loading={checking}
                disabled={busy || !host.trim()}
                onClick={() => void connect()}
                icon={<Icon name="link" />}
              >
                Connect
              </Button>
            </div>
            {error && (
              <Alert
                role="alert"
                type="error"
                showIcon
                title={
                  probe
                    ? "Remote kernel setup failed"
                    : "SSH connection or discovery failed"
                }
                description={error}
                style={{ marginBottom: 12 }}
              />
            )}
            <div role="status" aria-live="polite">
              {checking
                ? "Checking SSH connection and remote kernels..."
                : null}
            </div>
            {probe && (
              <>
                <div role="status" style={{ marginBottom: 12 }}>
                  Connected: {probe.platform}
                  {probe.gpu.description ? ` · ${probe.gpu.description}` : ""}
                </div>
                {!["available", "absent"].includes(probe.gpu.status) && (
                  <Alert
                    type="warning"
                    showIcon
                    title="GPU availability not confirmed"
                    description={probe.gpu.reason}
                    style={{ marginBottom: 12 }}
                  />
                )}
                {probe.warnings.map((warning, i) => (
                  <Alert
                    key={i}
                    type="warning"
                    title={warning}
                    style={{ marginBottom: 8 }}
                  />
                ))}
                <Form
                  id={formId}
                  name={formId}
                  form={form}
                  layout="vertical"
                  disabled={busy}
                  onFinish={submit}
                  onValuesChange={(values) => {
                    for (const key of Object.keys(values))
                      edited.current.add(key);
                  }}
                >
                  {mode !== "existing" && (
                    <Form.Item label="Kernel" htmlFor={`${formId}-choice`}>
                      <Select
                        id={`${formId}-choice`}
                        value={choice}
                        onChange={(value) => {
                          setChoice(value);
                          edited.current.delete("recipe");
                          defaults(probe, host, value);
                        }}
                        options={[
                          ...probe.kernels.map((k) => ({
                            value: k.id,
                            label: `${k.display_name} (${k.language || k.name})`,
                            title: k.id,
                          })),
                          {
                            value: "python",
                            label: "Create Python environment",
                          },
                          ...(probe.gpu.status === "available"
                            ? [
                                {
                                  value: "pytorch-cu128",
                                  label:
                                    "Create GPU Python environment (PyTorch)",
                                },
                              ]
                            : []),
                        ]}
                      />
                    </Form.Item>
                  )}
                  <Checkbox
                    checked={advanced}
                    onChange={(e) => setAdvanced(e.target.checked)}
                    style={{ marginBottom: 16 }}
                  >
                    Advanced
                  </Checkbox>
                  <div hidden={!advanced}>
                    <Form.Item
                      name="name"
                      label="Kernel name"
                      rules={[
                        { required: true },
                        {
                          pattern: /^[a-zA-Z0-9_-]{1,100}$/,
                          message:
                            "Use letters, numbers, hyphens or underscores.",
                        },
                      ]}
                    >
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item label="Environment">
                      <Radio.Group
                        value={mode}
                        onChange={(e) => setMode(e.target.value)}
                      >
                        <Radio value="prepare">
                          Selected kernel or prepare Python
                        </Radio>
                        <Radio value="existing">Existing Python</Radio>
                      </Radio.Group>
                    </Form.Item>
                    <Form.Item
                      name="environment"
                      label="Environment name"
                      rules={[{ required: true }]}
                    >
                      <Input autoComplete="off" />
                    </Form.Item>
                    {mode === "existing" && (
                      <Form.Item
                        name="python"
                        label="Remote Python interpreter"
                        rules={[{ required: true }]}
                      >
                        <Input placeholder="/home/user/venv/bin/python" />
                      </Form.Item>
                    )}
                    {mode !== "existing" && !choice.startsWith("/") && (
                      <Form.Item name="recipe" label="Kernel software">
                        <Select
                          options={[
                            { value: "python", label: "Python" },
                            ...(probe.gpu.status === "available"
                              ? [
                                  {
                                    value: "pytorch-cu128",
                                    label:
                                      "PyTorch 2.8 / CUDA 12.8 (NVIDIA GPU)",
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </Form.Item>
                    )}
                    <Form.Item
                      label="Additional remote kernelspec directory"
                      htmlFor={`${formId}-search`}
                    >
                      <Input
                        id={`${formId}-search`}
                        value={searchPath}
                        onChange={(e) => setSearchPath(e.target.value)}
                        placeholder="/opt/venv/share/jupyter/kernels"
                      />
                    </Form.Item>
                    <Button
                      disabled={busy || checking}
                      onClick={() => void connect()}
                      icon={<Icon name="refresh" />}
                      style={{ marginBottom: 16 }}
                    >
                      Refresh discovery
                    </Button>
                  </div>
                  <div role="status" aria-live="polite">
                    {busy ? "Preparing and registering remote kernel..." : null}
                  </div>
                  <Button
                    type="primary"
                    htmlType="submit"
                    loading={busy}
                    icon={<Icon name="plus" />}
                  >
                    Set up kernel
                  </Button>
                </Form>
              </>
            )}
          </div>
        </KeyboardBoundary>
      </Modal>
    </>
  );
}
