import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const ROUTE_RESTRAINTS: Record<
  string,
  {
    readonly source: string;
    readonly phrases: Record<string, number>;
  }
> = {
  "/": {
    source: "public/home/app.tsx",
    phrases: {
      "Compare operating models": 1,
      "research, technical teams, and teaching": 1,
    },
  },
  "/features/ai": {
    source: "public/features/ai-page.tsx",
    phrases: {
      "Stay in a project when someone needs to pick up the work later.": 0,
    },
  },
  "/features/compare": {
    source: "public/features/compare-page.tsx",
    phrases: {
      "about CoCalc fit": 0,
      "about workflow fit": 1,
    },
  },
  "/features/jupyter-notebook": {
    source: "public/features/jupyter-notebook-page.tsx",
    phrases: {
      "and instructors": 0,
      "Compare operating models when procurement, licensing, or deployment control matters.": 1,
    },
  },
  "/features/linux": {
    source: "public/features/linux-page.tsx",
    phrases: {
      "Install software, run services, and keep the environment reproducible with the project": 0,
      "Run services beside the work": 0,
      "Services run beside files": 0,
    },
  },
  "/features/teaching": {
    source: "public/features/teaching-page.tsx",
    phrases: {
      "Compare operating models": 1,
      "Compare operating models when deployment, procurement, or licensing questions shape the course.": 0,
      "Keep administration in the LMS. Run coursework in CoCalc.": 0,
    },
  },
  "/features/terminal": {
    source: "public/features/terminal-page.tsx",
    phrases: {
      "One live stream for collaborators": 1,
      "One session stays visible": 0,
      "Output remains reviewable": 0,
      "Split the shell around the work": 0,
    },
  },
};

function trackedPublicSources(): Set<string> {
  const output = execFileSync(
    "git",
    ["ls-files", "public/home/app.tsx", "public/features/*.tsx"],
    { encoding: "utf8" },
  ).trim();
  return new Set(output ? output.split("\n") : []);
}

function countLiteral(source: string, phrase: string): number {
  return source.split(phrase).length - 1;
}

describe("public site restraint regression canaries", () => {
  it("keeps curated deduped phrases within route-local caps", () => {
    const trackedSources = trackedPublicSources();

    for (const [route, { source: sourcePath, phrases }] of Object.entries(
      ROUTE_RESTRAINTS,
    )) {
      expect(trackedSources.has(sourcePath)).toBe(true);
      const source = readFileSync(sourcePath, "utf8");

      for (const [phrase, maxOccurrences] of Object.entries(phrases)) {
        const occurrences = countLiteral(source, phrase);
        if (occurrences > maxOccurrences) {
          throw new Error(
            `${route} (${sourcePath}) has ${occurrences} occurrences of "${phrase}", expected <= ${maxOccurrences}`,
          );
        }
      }
    }
  });
});
