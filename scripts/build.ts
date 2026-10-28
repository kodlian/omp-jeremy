import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
for (const [name, entry] of [["orchestrator", "omp/kanboard.ts"], ["git-diff-review", "src/extension.ts"]]) {
  const dir = resolve(root, "plugins", name);
  const result = await Bun.build({
    entrypoints: [resolve(dir, entry)],
    outdir: resolve(dir, "dist"),
    naming: "extension.js",
    target: "bun",
    external: ["@oh-my-pi/*"],
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${name}`);
  await mkdir(resolve(dir, "python"), { recursive: true });
  await copyFile(resolve(root, "packages/integrations/python/omp_terminals.py"), resolve(dir, "python/omp_terminals.py"));
}
const graph = await Bun.build({
  entrypoints: [resolve(root, "plugins/orchestrator/graph-layout.ts")],
  outdir: resolve(root, "plugins/orchestrator"),
  target: "browser",
  format: "iife",
  minify: true,
});
if (!graph.success) throw new AggregateError(graph.logs, "Could not build task graph layout");
const dagre = Bun.resolveSync("@dagrejs/dagre", resolve(root, "plugins/orchestrator"));
const graphlib = Bun.resolveSync("@dagrejs/graphlib", dirname(dagre));
const licenses = resolve(root, "plugins/orchestrator/licenses");
await mkdir(licenses, { recursive: true });
for (const [name, entry] of [["dagre", dagre], ["graphlib", graphlib]]) {
  await copyFile(resolve(dirname(entry), "../LICENSE"), resolve(licenses, `${name}.LICENSE`));
}
await rm(resolve(root, "plugins/git-diff-review/web/dist"), { recursive: true, force: true });
const web = Bun.spawn([process.execPath, "run", "build"], { cwd: resolve(root, "plugins/git-diff-review"), stdout: "inherit", stderr: "inherit" });
if (await web.exited !== 0) throw new Error("Could not build review web assets");
