import { useEffect, useId, useRef, useState } from "react";
import type { InputRef } from "antd";
import { Alert, Button, Form, Input, Modal, Radio, Select, Tabs } from "antd";
import RemoteKernelTargets from "./remote-kernel-targets";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  setupRemoteKernel,
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
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState("prepare");
  const [form] = Form.useForm<RemoteKernelSetup>();
  const formId = useId();
  const nameInput = useRef<InputRef>(null);
  const generation = useRef(0);
  const [tab, setTab] = useState("setup");
  useEffect(() => {
    return () => {
      generation.current++;
    };
  }, [project_id]);

  async function submit(values: RemoteKernelSetup) {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const name = await setupRemoteKernel(project_id, {
        ...values,
        python: mode === "existing" ? values.python : undefined,
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
        onCancel={() => !busy && setOpen(false)}
        footer={null}
        mask={{ closable: !busy }}
        keyboard={!busy}
        closable={!busy}
        width={560}
        afterOpenChange={(visible) => {
          // Do not steal focus if the user already reached another form field
          // during the modal's entrance animation.
          if (
            visible &&
            tab === "setup" &&
            !document.activeElement?.closest(`form[id="${formId}"]`)
          ) {
            nameInput.current?.focus();
          }
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
            {error && (
              <Alert
                type="error"
                showIcon
                title="Remote kernel setup failed"
                description={error}
                style={{ marginBottom: 12 }}
              />
            )}
            <Form
              id={formId}
              name={formId}
              form={form}
              layout="vertical"
              onFinish={submit}
              disabled={busy}
              initialValues={{ name: "my-vm", environment: "teaching" }}
            >
              <Form.Item
                name="name"
                label="Kernel name"
                rules={[
                  { required: true },
                  {
                    pattern: /^[a-zA-Z0-9_-]{1,100}$/,
                    message: "Use letters, numbers, hyphens or underscores.",
                  },
                ]}
              >
                <Input ref={nameInput} autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="host"
                label="SSH destination or alias"
                rules={[{ required: true }]}
              >
                <Input placeholder="user@vm.example.com" autoComplete="off" />
              </Form.Item>
              <Form.Item label="Environment">
                <Radio.Group
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <Radio value="prepare">Prepare Python</Radio>
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
              {mode === "prepare" && (
                <Form.Item name="recipe" label="Kernel software">
                  <Select
                    placeholder="Python"
                    options={[
                      { value: "python", label: "Python" },
                      {
                        value: "pytorch-cu128",
                        label: "PyTorch 2.8 / CUDA 12.8 (NVIDIA GPU)",
                      },
                    ]}
                  />
                </Form.Item>
              )}
              {mode === "existing" && (
                <Form.Item
                  name="python"
                  label="Remote Python interpreter"
                  rules={[{ required: true }]}
                >
                  <Input
                    placeholder="/home/user/venv/bin/python"
                    autoComplete="off"
                  />
                </Form.Item>
              )}
              <div
                role="status"
                aria-live="polite"
                style={{ marginBottom: 12 }}
              >
                {busy ? "Preparing and verifying remote kernel..." : null}
              </div>
              <Button
                type="primary"
                htmlType="submit"
                loading={busy}
                icon={<Icon name="plus" />}
              >
                Register kernel
              </Button>
            </Form>
          </div>
        </KeyboardBoundary>
      </Modal>
    </>
  );
}
