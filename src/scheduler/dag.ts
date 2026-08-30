export interface DependencyNode<Id> {
  id: Id;
  dependsOn: Id[];
}

// Generic over the id type: numeric component ids once persisted (the
// scheduler's own defensive check against malformed data), or the string
// keys a plan uses to reference its own components before any of them have
// a real id yet (the orchestrator, module 1, validating before ever
// showing a plan to the human). A cycle would deadlock the scheduler
// forever — every component in it stays blocked_on_deps with no path to
// merged — so both callers need the same check.
export function hasCycle<Id>(nodes: DependencyNode<Id>[]): boolean {
  const dependsOnById = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  const state = new Map<Id, "visiting" | "done">();

  function visit(id: Id): boolean {
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
