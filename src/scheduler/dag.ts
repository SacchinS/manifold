export interface DependencyNode {
  id: number;
  dependsOn: number[];
}

// Used by the orchestrator (module 1) before ever showing a plan to the
// human, and available to the scheduler as a defensive check against
// malformed data. A cycle would deadlock the scheduler forever — every
// component in it stays blocked_on_deps with no path to merged.
export function hasCycle(nodes: DependencyNode[]): boolean {
  const dependsOnById = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  const state = new Map<number, "visiting" | "done">();

  function visit(id: number): boolean {
    const current = state.get(id);
    if (current === "visiting") return true;
    if (current === "done") return false;

    state.set(id, "visiting");
    for (const depId of dependsOnById.get(id) ?? []) {
      if (visit(depId)) return true;
    }
    state.set(id, "done");
    return false;
  }

  for (const node of nodes) {
    if (visit(node.id)) return true;
  }
  return false;
}
