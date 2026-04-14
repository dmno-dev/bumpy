import { test, expect, describe } from "bun:test";
import { assembleReleasePlan } from "../../src/core/release-plan.ts";
import { DependencyGraph } from "../../src/core/dep-graph.ts";
import type { WorkspacePackage, Changeset, BumpyConfig } from "../../src/types.ts";
import { DEFAULT_CONFIG } from "../../src/types.ts";

function makePkg(
  name: string,
  version: string,
  deps: Partial<Pick<WorkspacePackage, "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies" | "bumpy">> = {},
): WorkspacePackage {
  return {
    name,
    version,
    dir: `/fake/${name}`,
    relativeDir: `packages/${name}`,
    packageJson: {},
    private: false,
    dependencies: deps.dependencies || {},
    devDependencies: deps.devDependencies || {},
    peerDependencies: deps.peerDependencies || {},
    optionalDependencies: deps.optionalDependencies || {},
    bumpy: deps.bumpy,
  };
}

function makeConfig(overrides: Partial<BumpyConfig> = {}): BumpyConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("assembleReleasePlan", () => {
  test("basic single package bump", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("pkg-a", makePkg("pkg-a", "1.0.0"));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "pkg-a", type: "minor" }], summary: "Added feature" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe("pkg-a");
    expect(plan.releases[0]!.type).toBe("minor");
    expect(plan.releases[0]!.oldVersion).toBe("1.0.0");
    expect(plan.releases[0]!.newVersion).toBe("1.1.0");
  });

  test("multiple changesets for same package take highest bump", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("pkg-a", makePkg("pkg-a", "1.0.0"));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "pkg-a", type: "patch" }], summary: "Fix" },
      { id: "cs2", releases: [{ name: "pkg-a", type: "minor" }], summary: "Feature" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.type).toBe("minor");
    expect(plan.releases[0]!.newVersion).toBe("1.1.0");
  });

  test("dependency propagation - patch bump propagates patch to dependents", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("app", makePkg("app", "2.0.0", {
      dependencies: { core: "^1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "patch" }], summary: "Fix" },
    ];

    const graph = new DependencyGraph(packages);
    // Use "patch" mode so propagation always happens regardless of range
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig({ updateInternalDependencies: "patch" }));

    expect(plan.releases).toHaveLength(2);
    const coreRelease = plan.releases.find((r) => r.name === "core")!;
    const appRelease = plan.releases.find((r) => r.name === "app")!;
    expect(coreRelease.newVersion).toBe("1.0.1");
    expect(appRelease.type).toBe("patch");
    expect(appRelease.isDependencyBump).toBe(true);
  });

  test("peer dependency minor bump does NOT propagate by default", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("plugin", makePkg("plugin", "1.0.0", {
      peerDependencies: { core: "^1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "minor" }], summary: "Feature" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    // Only core should be released - peer dep minor doesn't trigger major (unlike changesets!)
    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe("core");
  });

  test("peer dependency major bump DOES propagate by default", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("plugin", makePkg("plugin", "1.0.0", {
      peerDependencies: { core: "^1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "major" }], summary: "Breaking" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(2);
    const pluginRelease = plan.releases.find((r) => r.name === "plugin")!;
    expect(pluginRelease.type).toBe("major");
    expect(pluginRelease.isDependencyBump).toBe(true);
  });

  test("isolated bump skips dependency propagation", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("app", makePkg("app", "2.0.0", {
      dependencies: { core: "^1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "patch-isolated" }], summary: "Internal" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    // Only core - no propagation due to isolated
    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe("core");
    expect(plan.releases[0]!.newVersion).toBe("1.0.1");
  });

  test("non-isolated changeset overrides isolated for same package", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("app", makePkg("app", "2.0.0", {
      dependencies: { core: "^1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "patch-isolated" }], summary: "Internal" },
      { id: "cs2", releases: [{ name: "core", type: "patch" }], summary: "Fix" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig({ updateInternalDependencies: "patch" }));

    // Both should be released because one changeset is non-isolated
    expect(plan.releases).toHaveLength(2);
  });

  test("out-of-range: skips propagation when version still satisfies range", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("app", makePkg("app", "1.0.0", {
      dependencies: { core: "^1.0.0" }, // ^1.0.0 includes 1.1.0
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "minor" }], summary: "Feature" },
    ];

    const graph = new DependencyGraph(packages);
    const config = makeConfig({ updateInternalDependencies: "out-of-range" });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    // core bumps to 1.1.0, ^1.0.0 still satisfies → app NOT bumped
    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe("core");
  });

  test("out-of-range: propagates when version leaves range", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("app", makePkg("app", "1.0.0", {
      dependencies: { core: "^1.0.0" }, // ^1.0.0 does NOT include 2.0.0
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "major" }], summary: "Breaking" },
    ];

    const graph = new DependencyGraph(packages);
    const config = makeConfig({ updateInternalDependencies: "out-of-range" });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    // core bumps to 2.0.0, ^1.0.0 no longer satisfies → app bumped
    expect(plan.releases).toHaveLength(2);
  });

  test("changeset-level cascade overrides", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("plugin-a", makePkg("plugin-a", "1.0.0"));
    packages.set("plugin-b", makePkg("plugin-b", "1.0.0"));

    const changesets: Changeset[] = [
      {
        id: "cs1",
        releases: [{
          name: "core",
          type: "minor",
          cascade: { "plugin-*": "patch" as const },
        }],
        summary: "Feature with cascades",
      },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(3);
    const pluginA = plan.releases.find((r) => r.name === "plugin-a")!;
    const pluginB = plan.releases.find((r) => r.name === "plugin-b")!;
    expect(pluginA.type).toBe("patch");
    expect(pluginA.isCascadeBump).toBe(true);
    expect(pluginB.type).toBe("patch");
    expect(pluginB.isCascadeBump).toBe(true);
  });

  test("cascadeTo config on source package", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0", {
      bumpy: {
        cascadeTo: {
          "plugin-*": { trigger: "minor", bumpAs: "patch" },
        },
      },
    }));
    packages.set("plugin-a", makePkg("plugin-a", "1.0.0"));
    packages.set("plugin-b", makePkg("plugin-b", "1.0.0"));
    packages.set("unrelated", makePkg("unrelated", "1.0.0"));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "minor" }], summary: "Feature" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(3); // core + 2 plugins, NOT unrelated
    expect(plan.releases.find((r) => r.name === "unrelated")).toBeUndefined();
    expect(plan.releases.find((r) => r.name === "plugin-a")!.type).toBe("patch");
  });

  test("specific dependency rules override global rules", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("special", makePkg("special", "1.0.0", {
      dependencies: { core: "^1.0.0" },
      bumpy: {
        specificDependencyRules: {
          core: { trigger: "none", bumpAs: "patch" }, // never propagate from core
        },
      },
    }));
    packages.set("normal", makePkg("normal", "1.0.0", {
      dependencies: { core: "^1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "patch" }], summary: "Fix" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig({ updateInternalDependencies: "patch" }));

    // normal gets bumped (default dep rule), special does NOT (specific rule says none)
    expect(plan.releases).toHaveLength(2);
    expect(plan.releases.find((r) => r.name === "normal")).toBeDefined();
    expect(plan.releases.find((r) => r.name === "special")).toBeUndefined();
  });

  test("fixed groups: all packages get highest bump", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("pkg-a", makePkg("pkg-a", "1.0.0"));
    packages.set("pkg-b", makePkg("pkg-b", "1.0.0"));
    packages.set("pkg-c", makePkg("pkg-c", "1.0.0"));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "pkg-a", type: "minor" }], summary: "Feature" },
      { id: "cs2", releases: [{ name: "pkg-b", type: "patch" }], summary: "Fix" },
    ];

    const graph = new DependencyGraph(packages);
    const config = makeConfig({ fixed: [["pkg-a", "pkg-b", "pkg-c"]] });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    // All three should get minor (highest in group)
    expect(plan.releases).toHaveLength(3);
    for (const r of plan.releases) {
      expect(r.type).toBe("minor");
      expect(r.newVersion).toBe("1.1.0");
    }
  });

  test("devDependencies do not propagate by default", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("test-utils", makePkg("test-utils", "1.0.0"));
    packages.set("app", makePkg("app", "1.0.0", {
      devDependencies: { "test-utils": "^1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "test-utils", type: "major" }], summary: "Breaking" },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    // Only test-utils - devDep trigger is "none" by default
    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe("test-utils");
  });

  test("empty changesets returns empty plan", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("pkg-a", makePkg("pkg-a", "1.0.0"));

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan([], packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(0);
    expect(plan.changesets).toHaveLength(0);
  });

  test("transitive dependency propagation", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("middle", makePkg("middle", "1.0.0", {
      dependencies: { core: "~1.0.0" }, // ~1.0.0 does NOT include 1.1.0
    }));
    packages.set("app", makePkg("app", "1.0.0", {
      dependencies: { middle: "~1.0.0" },
    }));

    const changesets: Changeset[] = [
      { id: "cs1", releases: [{ name: "core", type: "minor" }], summary: "Feature" },
    ];

    const graph = new DependencyGraph(packages);
    // out-of-range: ~1.0.0 doesn't include 1.1.0, so middle gets bumped
    // then middle bumps to 1.0.1, ~1.0.0 still includes → app NOT bumped
    const config = makeConfig({ updateInternalDependencies: "out-of-range" });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    expect(plan.releases.find((r) => r.name === "core")).toBeDefined();
    expect(plan.releases.find((r) => r.name === "middle")).toBeDefined();
    // app's dep on middle ~1.0.0 still satisfies 1.0.1, so no bump
    expect(plan.releases.find((r) => r.name === "app")).toBeUndefined();
  });
});
