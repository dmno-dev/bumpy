import { test, expect, describe } from "bun:test";
import { DependencyGraph } from "../../src/core/dep-graph.ts";
import type { WorkspacePackage } from "../../src/types.ts";

function makePkg(name: string, version: string, deps: Partial<Pick<WorkspacePackage, "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies">> = {}): WorkspacePackage {
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
  };
}

describe("DependencyGraph", () => {
  test("finds direct dependents", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("plugin-a", makePkg("plugin-a", "1.0.0", {
      dependencies: { core: "^1.0.0" },
    }));
    packages.set("plugin-b", makePkg("plugin-b", "1.0.0", {
      peerDependencies: { core: "^1.0.0" },
    }));

    const graph = new DependencyGraph(packages);
    const dependents = graph.getDependents("core");
    expect(dependents).toHaveLength(2);
    expect(dependents.map((d) => d.name).sort()).toEqual(["plugin-a", "plugin-b"]);
  });

  test("ignores external dependencies", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("my-pkg", makePkg("my-pkg", "1.0.0", {
      dependencies: { lodash: "^4.0.0", "external-thing": "^1.0.0" },
    }));

    const graph = new DependencyGraph(packages);
    expect(graph.getDependents("lodash")).toEqual([]);
    expect(graph.getDependents("external-thing")).toEqual([]);
  });

  test("tracks dependency type correctly", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("app", makePkg("app", "1.0.0", {
      dependencies: { core: "^1.0.0" },
    }));
    packages.set("tests", makePkg("tests", "1.0.0", {
      devDependencies: { core: "^1.0.0" },
    }));

    const graph = new DependencyGraph(packages);
    const dependents = graph.getDependents("core");
    const app = dependents.find((d) => d.name === "app")!;
    const tests = dependents.find((d) => d.name === "tests")!;
    expect(app.depType).toBe("dependencies");
    expect(tests.depType).toBe("devDependencies");
  });

  test("topological sort puts deps before dependents", () => {
    const packages = new Map<string, WorkspacePackage>();
    packages.set("core", makePkg("core", "1.0.0"));
    packages.set("utils", makePkg("utils", "1.0.0", {
      dependencies: { core: "^1.0.0" },
    }));
    packages.set("app", makePkg("app", "1.0.0", {
      dependencies: { utils: "^1.0.0", core: "^1.0.0" },
    }));

    const graph = new DependencyGraph(packages);
    const sorted = graph.topologicalSort(packages);

    expect(sorted.indexOf("core")).toBeLessThan(sorted.indexOf("utils"));
    expect(sorted.indexOf("utils")).toBeLessThan(sorted.indexOf("app"));
    expect(sorted.indexOf("core")).toBeLessThan(sorted.indexOf("app"));
  });
});
