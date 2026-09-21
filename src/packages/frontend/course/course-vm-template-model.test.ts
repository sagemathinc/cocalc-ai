import {
  quoteCourseVmTemplate,
  templateHardwarePatch,
} from "./course-vm-template-model";
import { catalog, template } from "./test/course-vm-template-fixture";

it("quotes the current catalog and reports missing machines independently of funding", () => {
  const quote = quoteCourseVmTemplate(catalog, template.config);
  expect(quote.available).toBe(true);
  expect(quote.price?.usd_per_hour).toBeGreaterThan(0);
  const missing = quoteCourseVmTemplate(catalog, {
    ...template.config,
    machine_type: "gone",
  });
  expect(missing.available).toBe(false);
  expect(missing.price).toBeUndefined();
  expect(missing.alternatives.length).toBeGreaterThan(0);
});
it("never promotes metadata to payer, deadline, attachment or credential fields", () => {
  const patch = templateHardwarePatch({
    ...template.config,
    stop_after_minutes: null,
    funding_source: "attacker",
    ssh_public_key: "key",
    home_volume: "volume",
  } as any);
  expect(patch).not.toHaveProperty("funding_source");
  expect(patch).not.toHaveProperty("stop_after_minutes");
  expect(patch).not.toHaveProperty("home_volume");
  expect(patch).not.toHaveProperty("ssh_public_key");
  expect(patch).toHaveProperty("provider_platform", undefined);
  expect(patch).toHaveProperty("gpu_type", undefined);
});
it("does not treat missing provider inventory or incompatible architecture as an offer", () => {
  expect(
    quoteCourseVmTemplate({ ...catalog, providers: [] }, template.config)
      .available,
  ).toBe(false);
  expect(
    quoteCourseVmTemplate(catalog, {
      ...template.config,
      architecture: "arm64",
    }).available,
  ).toBe(false);
});

it("separates missing prices from missing hardware and finds nearby replacements", () => {
  const unpriced = {
    ...catalog,
    provider_catalogs: {
      gcp: {
        ...catalog.provider_catalogs.gcp!,
        entries: catalog.provider_catalogs.gcp!.entries.filter(
          (entry) => entry.kind !== "prices",
        ),
      },
    },
  };
  const quote = quoteCourseVmTemplate(unpriced, template.config);
  expect(quote.available).toBe(true);
  expect(quote.price).toBeUndefined();
  const removedZone = quoteCourseVmTemplate(catalog, {
    ...template.config,
    zone: "removed-zone",
  });
  expect(removedZone.available).toBe(false);
  expect(removedZone.alternatives[0]?.config.zone).toBe("us-west1-a");
});
