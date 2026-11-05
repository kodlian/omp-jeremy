// Library entries as diagram shapes, and a flow said in words.

/** A library loop as the diagram's shape; a missing node shows by its id. */
export function libraryShape(payload, entry) {
  const nodes = new Map(payload.library.nodes.map((n) => [n.id, n]));
  const shape = (stages) =>
    (stages ?? []).map((s) => ({
      nodes: s.nodes.map((id) => {
        const n = nodes.get(id);
        return { id, name: n?.name ?? `${id} (missing)`, kind: n?.kind ?? "check" };
      }),
    }));
  return { id: entry.id, name: entry.name, description: entry.description, maxPasses: entry.maxPasses, plan: entry.plan === true, finish: entry.finish ?? "review", planStages: shape(entry.planStages), stages: shape(entry.stages) };
}

const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]);

/** What the checks of some stages do, in order: "Tests runs, then Quality and Conventions review it". */
function machines(stages, object) {
  const parts = stages
    .map((s) => s.nodes)
    .filter((nodes) => nodes.length)
    .map((nodes) => {
      const commands = nodes.filter((n) => n.kind === "check").map((n) => n.name);
      const ai = nodes.filter((n) => n.kind === "review").map((n) => n.name);
      return [commands.length ? `${list(commands)} must pass` : "", ai.length ? `${list(ai)} ${ai.length > 1 ? "review" : "reviews"} ${object}` : ""].filter(Boolean).join(" and ");
    });
  return parts.join(", then ");
}

/** The flow's steps in plain words, in the order they happen. */
export function describeFlow(shape) {
  const steps = [];
  if (shape.plan) {
    steps.push("The agent plans first (omp plan mode).");
    const planChecks = machines(shape.planStages, "the plan");
    if (planChecks) steps.push(`${planChecks[0].toUpperCase()}${planChecks.slice(1)}; problems send the plan back to be revised.`);
    steps.push("You approve the plan, or send it back.");
    steps.push("The agent implements the approved plan.");
  } else steps.push("The agent implements your request.");
  const changeChecks = machines(shape.stages, "the change");
  if (changeChecks) steps.push(`${changeChecks[0].toUpperCase()}${changeChecks.slice(1)}; problems go back to the agent.`);
  steps.push(`After ${shape.maxPasses} rounds, anything left comes to you.`);
  steps.push(
    shape.finish === "auto"
      ? "Once the checks pass, the task is done without your review; an Orchestrator task merges on its own."
      : "You review the final change: approve it, or send it back with what to change.",
  );
  return steps;
}
