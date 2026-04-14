import type { WorkspacePackage, DependentInfo, DepType } from '../types.ts';

export class DependencyGraph {
  /** Map from package name → packages that depend on it */
  private dependents = new Map<string, DependentInfo[]>();
  /** Set of all internal package names */
  private internalPackages: Set<string>;

  constructor(packages: Map<string, WorkspacePackage>) {
    this.internalPackages = new Set(packages.keys());
    this.build(packages);
  }

  private build(packages: Map<string, WorkspacePackage>) {
    for (const [name, pkg] of packages) {
      const depTypes: [DepType, Record<string, string>][] = [
        ['dependencies', pkg.dependencies],
        ['devDependencies', pkg.devDependencies],
        ['peerDependencies', pkg.peerDependencies],
        ['optionalDependencies', pkg.optionalDependencies],
      ];

      for (const [depType, deps] of depTypes) {
        for (const [depName, versionRange] of Object.entries(deps)) {
          if (!this.internalPackages.has(depName)) continue;
          if (!this.dependents.has(depName)) {
            this.dependents.set(depName, []);
          }
          this.dependents.get(depName)!.push({
            name,
            depType,
            versionRange,
          });
        }
      }
    }
  }

  /** Get all packages that depend on the given package */
  getDependents(pkgName: string): DependentInfo[] {
    return this.dependents.get(pkgName) || [];
  }

  /** Check if a package is an internal workspace package */
  isInternal(pkgName: string): boolean {
    return this.internalPackages.has(pkgName);
  }

  /** Get all internal package names */
  allPackages(): string[] {
    return [...this.internalPackages];
  }

  /** Topological sort — returns packages in dependency order (deps first) */
  topologicalSort(packages: Map<string, WorkspacePackage>): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const pkg = packages.get(name);
      if (!pkg) return;
      // Visit all internal dependencies first
      for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
        for (const depName of Object.keys(deps)) {
          if (this.internalPackages.has(depName)) {
            visit(depName);
          }
        }
      }
      result.push(name);
    };

    for (const name of this.internalPackages) {
      visit(name);
    }
    return result;
  }
}
