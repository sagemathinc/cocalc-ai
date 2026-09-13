import { normalizeCourseVmTemplates } from "./course-vm-template";

const template = {
  id: "cpu",
  label: "Notebook CPU",
  config: {
    provider: "gcp",
    operating_system: "linux",
    architecture: "x86_64",
    region: "us-central1",
    zone: "us-central1-a",
    machine_type: "e2-standard-2",
    gpu_count: 0,
    pricing_model: "on_demand",
    boot_disk_gb: 20,
  },
};
it("normalizes bounded hardware-only recommendations and permits an empty list", () => {
  expect(normalizeCourseVmTemplates([template])).toEqual([template]);
  expect(normalizeCourseVmTemplates([])).toEqual([]);
  expect(() => normalizeCourseVmTemplates([template, template])).toThrow(
    "unique",
  );
  expect(() => normalizeCourseVmTemplates(Array(11).fill(template))).toThrow(
    "At most",
  );
});
it.each([
  "funding_source",
  "payer_account_id",
  "stop_after_minutes",
  "ttl_minutes",
  "ssh_public_key",
  "price_usd",
  "home_volume",
])("rejects non-hardware field %s", (key) => {
  expect(() =>
    normalizeCourseVmTemplates([
      { ...template, config: { ...template.config, [key]: "untrusted" } },
    ]),
  ).toThrow("only labels and hardware");
});
it.each([NaN, Infinity, -1, 0.5, 257])(
  "rejects invalid GPU count %s",
  (gpu_count) => {
    expect(() =>
      normalizeCourseVmTemplates([
        { ...template, config: { ...template.config, gpu_count } },
      ]),
    ).toThrow("GPU count");
  },
);
