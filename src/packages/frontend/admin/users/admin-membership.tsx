/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  DatePicker,
  Input,
  Select,
  Space,
  Spin,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import api from "@cocalc/frontend/client/api";
import { ErrorDisplay, TimeAgo } from "@cocalc/frontend/components";
import { actions } from "./actions";

const { Text } = Typography;

interface MembershipTier {
  id: string;
  label?: string;
  priority?: number;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: MembershipTier[];
  error?: string;
}

interface AdminAssignment {
  account_id: string;
  membership_class: string;
  assigned_by: string;
  assigned_at: Date;
  expires_at?: Date | null;
  notes?: string | null;
}

export function AdminMembership({ account_id }: { account_id: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string>("");
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [assignment, setAssignment] = useState<AdminAssignment | null>(null);
  const [selectedTier, setSelectedTier] = useState<string | undefined>();
  const [expiresAt, setExpiresAt] = useState<dayjs.Dayjs | null>(null);
  const [notes, setNotes] = useState<string>("");

  const tierOptions = useMemo(() => {
    return [...tiers]
      .sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
      )
      .map((tier) => ({
        value: tier.id,
        label: tier.label ? `${tier.label} (${tier.id})` : tier.id,
        disabled: !!tier.disabled,
      }));
  }, [tiers]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [assignmentResult, tiersResult] = await Promise.all([
        actions.get_admin_membership(account_id),
        api("purchases/get-membership-tiers"),
      ]);
      const tierData = tiersResult as MembershipTiersResponse;
      if (tierData?.error) {
        throw Error(tierData.error);
      }
      setTiers(tierData?.tiers ?? []);
      const nextAssignment = (assignmentResult as AdminAssignment | undefined) ?? null;
      setAssignment(nextAssignment);
      setSelectedTier(nextAssignment?.membership_class ?? undefined);
      setExpiresAt(nextAssignment?.expires_at ? dayjs(nextAssignment.expires_at) : null);
      setNotes(nextAssignment?.notes ?? "");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  async function applyAssignment() {
    if (!selectedTier) {
      setError("Select a membership tier to assign.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await actions.set_admin_membership({
        account_id,
        membership_class: selectedTier,
        expires_at: expiresAt ? expiresAt.toDate() : null,
        notes: notes.trim() ? notes.trim() : null,
      });
      await refresh();
      message.success("Admin membership updated.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("cocalc:membership-changed"));
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function clearAssignment() {
    setClearing(true);
    setError("");
    try {
      await actions.clear_admin_membership(account_id);
      await refresh();
      message.success("Admin membership cleared.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("cocalc:membership-changed"));
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setClearing(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [account_id]);

  return (
    <div>
      {loading ? (
        <Spin />
      ) : (
        <>
          {error && (
            <ErrorDisplay
              style={{ marginBottom: "10px" }}
              error={error}
              onClose={() => setError("")}
            />
          )}
          {assignment ? (
            <div style={{ marginBottom: "10px" }}>
              <Text>
                Current assignment: <b>{assignment.membership_class}</b>
              </Text>
              {assignment.expires_at && (
                <>
                  {" "}
                  <Text type="secondary">
                    (expires <TimeAgo date={assignment.expires_at} />)
                  </Text>
                </>
              )}
            </div>
          ) : (
            <Text type="secondary">No admin-assigned membership.</Text>
          )}
          <div style={{ marginTop: "10px" }}>
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <div>
                <Text>Membership tier</Text>
                <Select
                  style={{ width: "100%", marginTop: "6px" }}
                  placeholder="Select a tier"
                  options={tierOptions}
                  value={selectedTier}
                  onChange={(value) => setSelectedTier(value)}
                  showSearch
                  optionFilterProp="label"
                />
              </div>
              <div>
                <Text>Expires</Text>
                <DatePicker
                  style={{ width: "100%", marginTop: "6px" }}
                  value={expiresAt}
                  onChange={(value) => setExpiresAt(value)}
                  allowClear
                  placeholder="Never"
                />
              </div>
              <div>
                <Text>Notes (optional)</Text>
                <Input.TextArea
                  rows={2}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Reason or internal notes"
                />
              </div>
              <Space>
                <Button type="primary" onClick={applyAssignment} loading={saving}>
                  {assignment ? "Update" : "Assign"}
                </Button>
                <Button onClick={clearAssignment} loading={clearing} danger>
                  Clear
                </Button>
              </Space>
              <Text type="secondary">
                Membership resolution uses tier priority across subscriptions and admin
                assignments.
              </Text>
            </Space>
          </div>
        </>
      )}
    </div>
  );
}
