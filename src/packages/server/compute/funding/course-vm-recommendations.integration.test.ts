import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { CourseVmTemplate } from "@cocalc/util/course-vm-template";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  getCourseVmRecommendations,
  setCourseVmRecommendations,
  getCourseVmRecommendationsOnOwningBay,
  setCourseVmRecommendationsOnOwningBay,
  getPublishedCourseVmRecommendationsOnOwningBay,
  getPublishedCourseVmRecommendations,
} from "./course-vm-recommendations";

const mockRemote = {
  computeFundingGetCourseVmRecommendations: jest.fn(),
  computeFundingSetCourseVmRecommendations: jest.fn(),
  computeFundingGetPublishedCourseVmRecommendations: jest.fn(),
};
const mockClient = jest.fn(() => mockRemote);
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  ...jest.requireActual("@cocalc/conat/inter-bay/api"),
  createInterBayAccountLocalClient: (...args) => mockClient(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));

const template: CourseVmTemplate = {
  id: "cpu",
  label: "Notebook CPU",
  config: {
    provider: "gcp",
    operating_system: "linux",
    architecture: "x86_64",
    region: "us-west1",
    zone: "us-west1-a",
    machine_type: "e2-standard-2",
    gpu_count: 0,
    pricing_model: "on_demand",
    boot_disk_gb: 20,
  },
};
let account_id: string;
let course_project_id: string;
let course_instance_id: string;
const request = () => ({ account_id, course_project_id, course_instance_id });

beforeAll(async () => await before({ noConat: true }), 60_000);
afterAll(after);
beforeEach(async () => {
  jest.clearAllMocks();
  account_id = randomUUID();
  course_project_id = randomUUID();
  course_instance_id = randomUUID();
  // No payer account, pool, or balance is required to edit project metadata.
  await getPool().query(
    "INSERT INTO projects (project_id,owning_bay_id,users) VALUES ($1,$2,$3::jsonb)",
    [
      course_project_id,
      getConfiguredBayId(),
      JSON.stringify({ [account_id]: { group: "collaborator" } }),
    ],
  );
});

it("persists explicit versioned choices, isolates course instances, and preserves clear versions", async () => {
  expect(await getCourseVmRecommendations(request())).toEqual({
    templates: [],
    version: 0,
  });
  expect(
    await setCourseVmRecommendations({
      ...request(),
      templates: [template],
      expected_version: 0,
    }),
  ).toEqual({ templates: [template], version: 1 });
  expect(await getCourseVmRecommendations(request())).toEqual({
    templates: [template],
    version: 1,
  });
  expect(
    await getCourseVmRecommendations({
      ...request(),
      course_instance_id: randomUUID(),
    }),
  ).toEqual({ templates: [], version: 0 });
  await expect(
    setCourseVmRecommendations({
      ...request(),
      templates: [],
      expected_version: 0,
    }),
  ).rejects.toThrow("reload before saving");
  expect(
    await setCourseVmRecommendations({
      ...request(),
      templates: [],
      expected_version: 1,
    }),
  ).toEqual({ templates: [], version: 2 });
  expect(await getCourseVmRecommendations(request())).toEqual({
    templates: [],
    version: 2,
  });
});

it.each(["viewer", "none"])(
  "denies %s read/write, including RPC-local handlers",
  async (role) => {
    await getPool().query(
      "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
      [course_project_id, JSON.stringify({ [account_id]: { group: role } })],
    );
    await expect(getCourseVmRecommendations(request())).rejects.toThrow(
      "collaborator access required",
    );
    await expect(
      getCourseVmRecommendationsOnOwningBay(request()),
    ).rejects.toThrow("collaborator access required");
    await expect(
      setCourseVmRecommendationsOnOwningBay({
        ...request(),
        templates: [template],
        expected_version: 0,
      }),
    ).rejects.toThrow("collaborator access required");
  },
);

it("rechecks revoked collaborator access and rejects unauthenticated or deleted projects", async () => {
  await setCourseVmRecommendations({
    ...request(),
    templates: [template],
    expected_version: 0,
  });
  await getPool().query("UPDATE projects SET users='{}' WHERE project_id=$1", [
    course_project_id,
  ]);
  await expect(
    setCourseVmRecommendations({
      ...request(),
      templates: [],
      expected_version: 1,
    }),
  ).rejects.toThrow("collaborator access required");
  await expect(
    getCourseVmRecommendations({ ...request(), account_id: undefined }),
  ).rejects.toThrow("signed in");
  await getPool().query(
    "UPDATE projects SET deleted=true WHERE project_id=$1",
    [course_project_id],
  );
  await expect(
    getPublishedCourseVmRecommendationsOnOwningBay(request()),
  ).rejects.toThrow("not found");
});

it("routes to project owning bay with the original actor, and rejects stale local copies", async () => {
  await getPool().query(
    "UPDATE projects SET owning_bay_id='course-home' WHERE project_id=$1",
    [course_project_id],
  );
  mockRemote.computeFundingGetCourseVmRecommendations.mockResolvedValue({
    templates: [template],
    version: 7,
  });
  mockRemote.computeFundingSetCourseVmRecommendations.mockResolvedValue({
    templates: [],
    version: 8,
  });
  expect(await getCourseVmRecommendations(request())).toEqual({
    templates: [template],
    version: 7,
  });
  expect(mockClient).toHaveBeenCalledWith(
    expect.objectContaining({ dest_bay: "course-home" }),
  );
  expect(
    mockRemote.computeFundingGetCourseVmRecommendations,
  ).toHaveBeenCalledWith(request());
  const write = { ...request(), templates: [], expected_version: 7 };
  await setCourseVmRecommendations(write);
  expect(
    mockRemote.computeFundingSetCourseVmRecommendations,
  ).toHaveBeenCalledWith(write);
  mockRemote.computeFundingGetPublishedCourseVmRecommendations.mockResolvedValue(
    { templates: [template], version: 7 },
  );
  expect(await getPublishedCourseVmRecommendations(request())).toEqual({
    templates: [template],
    version: 7,
  });
  expect(
    mockRemote.computeFundingGetPublishedCourseVmRecommendations,
  ).toHaveBeenCalledWith({ course_project_id, course_instance_id });
  await expect(
    getCourseVmRecommendationsOnOwningBay(request()),
  ).rejects.toThrow("owning bay");
  await expect(setCourseVmRecommendationsOnOwningBay(write)).rejects.toThrow(
    "owning bay",
  );
  await expect(
    getPublishedCourseVmRecommendationsOnOwningBay(request()),
  ).rejects.toThrow("owning bay");
});

it("rejects financial configuration and invalid versions before routing or writing", async () => {
  await expect(
    setCourseVmRecommendations({
      ...request(),
      templates: [
        {
          ...template,
          config: { ...template.config, funding_source: { kind: "personal" } },
        } as any,
      ],
      expected_version: 0,
    }),
  ).rejects.toThrow("only labels and hardware");
  await expect(
    setCourseVmRecommendations({
      ...request(),
      templates: [template],
      expected_version: -1,
    }),
  ).rejects.toThrow("expected recommendation version");
  expect(mockClient).not.toHaveBeenCalled();
  expect(await getCourseVmRecommendations(request())).toEqual({
    templates: [],
    version: 0,
  });
});

it("fences writes during project rehome without changing metadata", async () => {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS project_rehome_operations (op_id uuid,project_id uuid,source_bay_id text,dest_bay_id text,stage text,status text,created_at timestamp default now())`,
  );
  await getPool().query(
    "INSERT INTO project_rehome_operations (op_id,project_id,source_bay_id,dest_bay_id,stage,status) VALUES ($1,$2,$3,'next','copy','running')",
    [randomUUID(), course_project_id, getConfiguredBayId()],
  );
  await expect(
    setCourseVmRecommendations({
      ...request(),
      templates: [template],
      expected_version: 0,
    }),
  ).rejects.toThrow("project rehome");
  expect(await getCourseVmRecommendations(request())).toEqual({
    templates: [],
    version: 0,
  });
});

const postgresIt = process.env.COCALC_TEST_USE_PGLITE ? it.skip : it;

it("keeps bounded versioned metadata outside the generic project user query", async () => {
  expect(SCHEMA.projects.user_query?.get?.fields).not.toHaveProperty(
    "course_vm_recommendations",
  );
  expect(SCHEMA.projects.user_query?.set?.fields).not.toHaveProperty(
    "course_vm_recommendations",
  );
  const stored = Object.fromEntries(
    Array.from({ length: 100 }, () => [
      randomUUID(),
      { templates: [], version: 1 },
    ]),
  );
  await getPool().query(
    "UPDATE projects SET course_vm_recommendations=$2::jsonb WHERE project_id=$1",
    [course_project_id, JSON.stringify(stored)],
  );
  await expect(
    setCourseVmRecommendations({
      ...request(),
      templates: [],
      expected_version: 0,
    }),
  ).rejects.toThrow("Too many course instances");
  expect(
    await setCourseVmRecommendations({
      ...request(),
      course_instance_id: Object.keys(stored)[0],
      templates: [template],
      expected_version: 1,
    }),
  ).toEqual({ templates: [template], version: 2 });
});
postgresIt(
  "serializes simultaneous saves so exactly one version wins",
  async () => {
    const results = await Promise.allSettled([
      setCourseVmRecommendations({
        ...request(),
        templates: [template],
        expected_version: 0,
      }),
      setCourseVmRecommendations({
        ...request(),
        templates: [],
        expected_version: 0,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await getCourseVmRecommendations(request())).version).toBe(1);
  },
);

postgresIt(
  "waits for a concurrent access revocation before authorizing a save",
  async () => {
    const db = await getPool().connect();
    let save: Promise<string> | undefined;
    try {
      await db.query("BEGIN");
      await db.query("UPDATE projects SET users='{}' WHERE project_id=$1", [
        course_project_id,
      ]);
      save = setCourseVmRecommendations({
        ...request(),
        templates: [template],
        expected_version: 0,
      }).then(
        () => "saved",
        (err) => String(err),
      );
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        await db.query("SELECT pg_stat_clear_snapshot()");
        const { rows } =
          await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`);
        if (rows.length) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await db.query("COMMIT");
      expect(await save).toContain("collaborator access required");
    } finally {
      await db.query("ROLLBACK");
      await save;
      db.release();
    }
  },
);
