import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const designSystem = resolve(root, "packages/web-design-system/design-system.css");
for (const target of ["plugins/mission-control/design-system.css", "plugins/git-diff-review/web/design-system.css"]) {
  await copyFile(designSystem, resolve(root, target));
}
// Minifying drops the packages' license comments, so the licenses of every package in a bundle ship beside it.
async function writeNotices(result: Bun.BuildOutput, target: string) {
  const packages = new Map<string, string>();
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(resolve(root, input));
    if (match) packages.set(match[1].split("node_modules/").at(-1)!, match[1]);
  }
  const notices: string[] = [];
  for (const [name, dir] of [...packages].sort()) {
    const meta = await Bun.file(resolve(dir, "package.json")).json();
    const license = (await readdir(dir)).find((file) => /^licen[cs]e/i.test(file));
    const repository = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
    const text = license ? (await Bun.file(resolve(dir, license)).text()).trim() : `The package ships no license file; see ${repository ?? meta.homepage}.`;
    notices.push(`${name}@${meta.version} (${meta.license})\n\n${text}\n`);
  }
  await Bun.write(resolve(root, target), notices.join("\n---\n\n"));
}
// Mission Control's page from web/app: app.js and app.css are committed, so installs need no build.
const app = await Bun.build({
  entrypoints: [resolve(root, "plugins/mission-control/web/app/main.jsx")],
  outdir: resolve(root, "plugins/mission-control"),
  naming: "app.[ext]",
  target: "browser",
  format: "esm",
  minify: true,
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!app.success) throw new AggregateError(app.logs, "Could not bundle Mission Control's page");
await writeNotices(app, "plugins/mission-control/app.LICENSES.txt");
for (const [name, entry] of [["mission-control", "omp/mission-control.ts"], ["git-diff-review", "src/extension.ts"], ["control", "src/extension.ts"], ["better-annotate-plan", "src/extension.ts"]]) {
  const dir = resolve(root, "plugins", name);
  const result = await Bun.build({
    entrypoints: [resolve(dir, entry)],
    outdir: resolve(dir, "dist"),
    naming: "extension.js",
    target: "bun",
    external: ["@oh-my-pi/*"],
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not build ${name}`);
  if (name !== "control" && name !== "better-annotate-plan") {
    await mkdir(resolve(dir, "python"), { recursive: true });
    await copyFile(resolve(root, "packages/integrations/python/omp_terminals.py"), resolve(dir, "python/omp_terminals.py"));
  }
}
await rm(resolve(root, "plugins/git-diff-review/web/dist"), { recursive: true, force: true });
const web = Bun.spawn([process.execPath, "run", "build"], { cwd: resolve(root, "plugins/git-diff-review"), stdout: "inherit", stderr: "inherit" });
if (await web.exited !== 0) throw new Error("Could not build review web assets");
// The Review page's script and its lazy chunks, read again only to list the packages they bundle.
const review = await Bun.build({
  entrypoints: [resolve(root, "plugins/git-diff-review/web/main.jsx")],
  target: "browser",
  format: "esm",
  splitting: true,
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!review.success) throw new AggregateError(review.logs, "Could not read the review page's packages");
await writeNotices(review, "plugins/git-diff-review/web/dist/LICENSES.txt");
