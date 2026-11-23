import { graphlib, layout } from "@dagrejs/dagre";

interface LayoutTask {
  id: string;
  dependsOn: string[];
}

function layoutTaskGraph(tasks: LayoutTask[]): Map<string, { x: number; y: number }> {
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 80, ranksep: 140 });
  graph.setDefaultEdgeLabel(() => ({}));
  const ordered = [...tasks].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const task of ordered) graph.setNode(task.id, { width: 260, height: 130 });
  for (const task of ordered) {
    for (const id of [...task.dependsOn].sort()) {
      if (graph.hasNode(id)) graph.setEdge(id, task.id);
    }
  }
  layout(graph);
  return new Map(ordered.map(task => {
    const node = graph.node(task.id);
    return [task.id, { x: node.x - 130, y: node.y - 65 }];
  }));
}

Object.assign(globalThis, { layoutTaskGraph });
