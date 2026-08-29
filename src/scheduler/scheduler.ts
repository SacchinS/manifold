export interface ComponentForScheduling {
  id: number;
  status: string;
  dependsOn: number[];
}

// Module 2 in manifold-handoff.md. Deliberately dumb for v1: no partial-
// dependency starts, no speculative starts against unmerged interfaces.
// A component only becomes launchable once every one of its dependencies
// has fully merged.
export function findLaunchableComponents(components: ComponentForScheduling[]): number[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const launchable: number[] = [];

  for (const component of components) {
    if (component.status !== "blocked_on_deps") continue;
    const depsAllMerged = component.dependsOn.every((depId) => byId.get(depId)?.status === "merged");
    if (depsAllMerged) launchable.push(component.id);
  }

  return launchable;
}
