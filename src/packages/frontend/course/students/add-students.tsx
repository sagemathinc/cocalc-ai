/*
Component for adding one or more students to the course.
*/

import {
  Alert,
  Button,
  Card,
  Flex,
  Form,
  Input,
  Space,
  Tag,
  Typography,
} from "antd";
import { useMemo, useState } from "react";
import { FormattedMessage } from "react-intl";

import { useActions } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import type { UserMap } from "@cocalc/frontend/todo-types";
import {
  is_valid_email_address,
  lower_email_address,
  trunc,
} from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import type { CourseActions } from "../actions";
import type { StudentsMap } from "../store";

const { Paragraph, Text, Title } = Typography;

interface Props {
  name: string;
  students: StudentsMap;
  user_map: UserMap;
  project_id;
  close?: Function;
}

interface ParsedStudent {
  email_address: string;
  display_name?: string;
}

interface RosterParseResult {
  students: ParsedStudent[];
  alreadyAdded: string[];
  duplicateEmails: string[];
  invalidRows: string[];
}

export default function AddStudents({ name, students, close }: Props) {
  const actions = useActions<CourseActions>({ name });
  const [rosterInput, setRosterInput] = useState<string>("");
  const [err, setErr] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState<boolean>(false);

  const parsed = useMemo(
    () => parseRoster(rosterInput, existingStudentEmails(students)),
    [rosterInput, students],
  );
  const canAdd = parsed.students.length > 0 && !adding;

  async function addStudents(): Promise<void> {
    setErr(undefined);
    if (parsed.students.length === 0) {
      setErr("Enter at least one valid student email address.");
      return;
    }
    setAdding(true);
    try {
      await actions.students.add_students(parsed.students);
      setRosterInput("");
      close?.();
    } catch (err) {
      setErr(`${err}`);
    } finally {
      setAdding(false);
    }
  }

  function clear(): void {
    setErr(undefined);
    setRosterInput("");
  }

  function renderFeedback() {
    if (err) {
      return <ShowError error={trunc(err, 1024)} setError={setErr} />;
    }
    if (adding) {
      return (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: "12px" }}
          message="Adding students..."
          description="CoCalc is preparing private student projects and invite links. Students get access only after they accept."
        />
      );
    }
    if (parsed.invalidRows.length > 0) {
      return (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: "12px" }}
          message="Some lines do not contain valid email addresses."
          description={parsed.invalidRows.slice(0, 5).join("; ")}
        />
      );
    }
    if (parsed.alreadyAdded.length > 0 || parsed.duplicateEmails.length > 0) {
      return (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: "12px" }}
          message="Some entries will be skipped."
          description={[
            parsed.alreadyAdded.length > 0
              ? `Already in this course: ${parsed.alreadyAdded.join(", ")}`
              : "",
            parsed.duplicateEmails.length > 0
              ? `Duplicates in this roster: ${parsed.duplicateEmails.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("  ")}
        />
      );
    }
  }

  return (
    <Card
      style={{
        borderColor: COLORS.GRAY_L0,
      }}
    >
      <Space direction="vertical" size={18} style={{ width: "100%" }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <Icon name="users" /> Add Students to Your Course
          </Title>
          <Paragraph type="secondary" style={{ margin: "8px 0 0" }}>
            Paste student email addresses or a roster. CoCalc will prepare
            private projects and secure invite links; students choose their own
            CoCalc account and get access when they accept.
          </Paragraph>
        </div>
        <Form onFinish={addStudents}>
          <Form.Item
            label={<Text strong>Student email addresses</Text>}
            style={{ marginBottom: 8 }}
          >
            <Input.TextArea
              value={rosterInput}
              rows={8}
              autoFocus
              onChange={(e) => setRosterInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  clear();
                }
              }}
              placeholder={`alice@school.edu\nBob Lee <bob@school.edu>\ncarol@school.edu`}
              style={{ fontFamily: "monospace" }}
            />
          </Form.Item>
          <Text type="secondary">
            One email per line is best. Names are optional, e.g.{" "}
            <Text code>Jane Doe &lt;jane@school.edu&gt;</Text>. This does not
            search for CoCalc accounts.
          </Text>
          {renderFeedback()}
          <Card
            size="small"
            style={{
              marginTop: 16,
              background: COLORS.GRAY_LLL,
              borderColor: COLORS.GRAY_L0,
            }}
          >
            <Flex gap={24} align="stretch" wrap="wrap">
              <div style={{ flex: "1 1 360px", minWidth: 280 }}>
                <Space direction="vertical" size={12}>
                  <div>
                    <Text strong>
                      <Icon name="lock" /> Privacy-safe invite flow
                    </Text>
                    <Paragraph type="secondary" style={{ margin: "6px 0 0" }}>
                      CoCalc uses email to deliver invite links, not to look up
                      or expose student accounts.
                    </Paragraph>
                  </div>
                  <Space direction="vertical" size={10}>
                    <StepTag n={1} text="Paste roster emails" />
                    <StepTag n={2} text="Prepare private projects" />
                    <StepTag n={3} text="Create invite links" />
                    <StepTag n={4} text="Students accept to get access" />
                  </Space>
                </Space>
              </div>
              <div style={{ flex: "1 1 300px", minWidth: 260 }}>
                <Alert
                  type="success"
                  showIcon
                  style={{ height: "100%" }}
                  message="Access starts after acceptance"
                  description="Opening the link shows an accept/decline page. The private project and invite link are prepared now, but students are not added until they accept."
                />
              </div>
            </Flex>
          </Card>
          <Flex
            justify="space-between"
            align="center"
            gap={12}
            wrap="wrap"
            style={{ marginTop: 16 }}
          >
            <Space wrap>
              <Button
                type="primary"
                htmlType="submit"
                loading={adding}
                disabled={!canAdd}
              >
                <Icon name="user-plus" />{" "}
                <FormattedMessage
                  id="course.add-students.create-invites"
                  defaultMessage="{count, plural, one {Add 1 student} other {Add # students}}"
                  values={{ count: parsed.students.length }}
                />
              </Button>
              <Button onClick={clear} disabled={!rosterInput.trim()}>
                Clear
              </Button>
            </Space>
            <Text type="secondary">
              {parsed.students.length > 0
                ? `${parsed.students.length} ready to add`
                : "No valid emails yet"}
            </Text>
          </Flex>
        </Form>
      </Space>
    </Card>
  );
}

function StepTag({ n, text }: { n: number; text: string }) {
  return (
    <Space>
      <Tag color="blue" style={{ marginInlineEnd: 0 }}>
        {n}
      </Tag>
      <Text>{text}</Text>
    </Space>
  );
}

function existingStudentEmails(students: StudentsMap): Set<string> {
  const existing = new Set<string>();
  students?.map((student) => {
    const email = lower_email_address(student.get("email_address"));
    if (email) {
      existing.add(email);
    }
  });
  return existing;
}

function parseRoster(input: string, existing: Set<string>): RosterParseResult {
  const students: ParsedStudent[] = [];
  const alreadyAdded: string[] = [];
  const duplicateEmails: string[] = [];
  const invalidRows: string[] = [];
  const seen = new Set<string>();
  for (const row of rosterFragments(input)) {
    const email = extractEmail(row);
    if (!email) {
      invalidRows.push(row);
      continue;
    }
    if (existing.has(email)) {
      alreadyAdded.push(email);
      continue;
    }
    if (seen.has(email)) {
      duplicateEmails.push(email);
      continue;
    }
    seen.add(email);
    students.push({ email_address: email, ...extractName(row, email) });
  }
  return { students, alreadyAdded, duplicateEmails, invalidRows };
}

function rosterFragments(input: string): string[] {
  const fragments: string[] = [];
  for (const line of input.split(/\n|;/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes("<") && trimmed.includes(">")) {
      fragments.push(trimmed);
    } else {
      fragments.push(...trimmed.split(",").map((part) => part.trim()));
    }
  }
  return fragments.filter(Boolean);
}

function extractEmail(row: string): string | undefined {
  const match = row.match(/[^\s<>,;]+@[^\s<>,;]+/);
  const email = lower_email_address(match?.[0] ?? "");
  return is_valid_email_address(email) ? email : undefined;
}

function extractName(row: string, email: string): { display_name?: string } {
  const name = row
    .replace(email, "")
    .replace(/[<>"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return {};
  return { display_name: name };
}
