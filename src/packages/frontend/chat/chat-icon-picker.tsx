import { Button, Modal, Space } from "antd";
import { React, useMemo, useState } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import IconSelect from "@cocalc/frontend/components/icon-select";
import type { IconName } from "@cocalc/frontend/components/icon";

interface ChatIconPickerProps {
  value?: string;
  onChange: (value?: string) => void;
  modalTitle?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function ChatIconPicker({
  value,
  onChange,
  modalTitle = "Select Icon",
  placeholder = "Select an icon",
  disabled = false,
}: ChatIconPickerProps): React.JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const iconName = useMemo(
    () => (value?.trim() ? (value.trim() as IconName) : undefined),
    [value],
  );

  return (
    <>
      <Space style={{ width: "100%" }}>
        <Button
          disabled={disabled}
          onClick={() => setOpen(true)}
          style={{
            flex: 1,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{iconName ? iconName : placeholder}</span>
          {iconName ? <Icon name={iconName} /> : null}
        </Button>
        <Button
          disabled={disabled || !iconName}
          onClick={() => onChange(undefined)}
        >
          Clear
        </Button>
      </Space>
      <Modal
        title={modalTitle}
        open={open}
        footer={null}
        onCancel={() => setOpen(false)}
        width={700}
        destroyOnHidden
      >
        <IconSelect
          defaultSearch={iconName}
          onSelect={(name) => {
            onChange(name);
            setOpen(false);
          }}
          fontSize="9pt"
          style={{
            fontSize: "20pt",
            width: "100%",
            maxHeight: "58vh",
            overflowY: "auto",
          }}
        />
      </Modal>
    </>
  );
}
