// Library entries as diagram shapes, and a flow said in words.

/** A library loop as the diagram's shape; a missing node shows by its id. */
export function libraryShape(payload, entry) {
  const nodes = new Map(payload.library.nodes.map((n) => [n.id, n]));
  const node = (id) => {
    const n = nodes.get(id);
    return { id, name: n?.name ?? `${id} (missing)`, kind: n?.kind ?? "check" };
  };
  const shape = (stages) => (stages ?? []).map((s) => ({ nodes: s.nodes.map(node) }));
  return { id: entry.id, name: entry.name, description: entry.description, maxPasses: entry.maxPasses, plan: entry.plan ?? "none", planReviewer: entry.planReviewer ? node(entry.planReviewer) : null, finish: entry.finish ?? "review", stages: shape(entry.stages) };
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
  if (shape.plan !== "none") {
    steps.push("The agent plans first (omp plan mode).");
    if (shape.plan === "ai") {
      steps.push(`${shape.planReviewer?.name ?? "An AI reviewer"} reviews the plan; problems send it back to be revised, and a plan it passes is approved without you.`);
      steps.push(`If the plan still has problems after ${shape.maxPasses} rounds, you approve it or send it back.`);
    } else steps.push("You approve the plan, or send it back.");
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
