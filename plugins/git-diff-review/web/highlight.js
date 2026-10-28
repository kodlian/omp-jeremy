import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";

// omp's syntax categories as CSS variables, so theme changes need no re-highlighting.
const SYNTAX = {
  comment: ["comment", "punctuation.definition.comment"],
  keyword: ["keyword", "storage", "storage.type", "storage.modifier", "variable.language", "markup.heading", "entity.name.section"],
  operator: ["keyword.operator"],
  function: ["entity.name.function", "support.function", "entity.other.attribute-name"],
  variable: ["variable", "support.variable", "meta.object-literal.key"],
  string: ["string", "punctuation.definition.string", "constant.character.escape", "markup.inline.raw"],
  number: ["constant", "support.constant"],
  type: ["entity.name.type", "entity.name.class", "entity.name.namespace", "entity.name.tag", "entity.other.inherited-class", "support.type", "support.class"],
  punctuation: ["punctuation", "meta.brace"],
};
const THEME = {
  name: "omp",
  settings: [
    { settings: { foreground: "var(--fg)" } },
    ...Object.entries(SYNTAX).map(([name, scope]) => ({ scope, settings: { foreground: `var(--syn-${name})` } })),
  ],
};
const EXT_LANG = {
  mjs: "javascript", cjs: "javascript", jsx: "jsx", mts: "typescript", cts: "typescript", h: "c", hpp: "cpp", cc: "cpp",
  m: "objective-c", mm: "objective-cpp", kt: "kotlin", kts: "kotlin", gradle: "groovy", yml: "yaml", zsh: "shellscript",
  bash: "shellscript", sh: "shellscript", env: "dotenv", lock: "json", jsonc: "jsonc", plist: "xml", xcconfig: "ini",
  pbxproj: "ini", entitlements: "xml", storyboard: "xml", xib: "xml", svg: "xml", gql: "graphql", tf: "hcl", rules: "javascript",
};
const NAME_LANG = { Dockerfile: "docker", Makefile: "makefile", Podfile: "ruby", Gemfile: "ruby", Fastfile: "ruby", Brewfile: "ruby", "Package.swift": "swift" };

let core = null;
const loaded = new Set();

function highlighter() {
  core ??= createHighlighterCore({
    themes: [THEME],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return core;
}

export function langFor(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (NAME_LANG[name]) return NAME_LANG[name];
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const lang = EXT_LANG[ext] ?? ext;
  return lang && bundledLanguages[lang] ? lang : null;
}

// Tokens per line for `lines` (one string each), or null when the language is unknown.
export async function tokenize(lines, path) {
  const lang = langFor(path);
  if (!lang || !lines.length) return null;
  const hl = await highlighter();
  if (!loaded.has(lang)) {
    await hl.loadLanguage(bundledLanguages[lang]);
    loaded.add(lang);
  }
  const result = hl.codeToTokensBase(lines.join("\n"), { lang, theme: THEME.name });
  return result.map((line) => line.map((t) => ({ content: t.content, color: t.color })));
}
