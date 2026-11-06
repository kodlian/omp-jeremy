---
name: Project rules
kind: review
description: The change follows AGENTS.md / CLAUDE.md, the docs they link, the project's rules and the skills that apply
timeout: 600
ask: doubts
tools:
  - read
  - grep
  - glob
resources:
  - AGENTS.md
  - CLAUDE.md
---

Check the change against what the project wrote down for agents, and nothing else:

1. Instruction files. Read AGENTS.md and CLAUDE.md at the repository root, and those in every folder between the root and each changed file (the closest one wins on conflict). Skip any that don't exist.
2. Linked docs. Follow the links and paths these files point to (docs, style guides, architecture notes) when they concern the changed code, and read them.
3. Rules. Read the rule files that apply to the changed paths: `.omp/rules`, `.claude/rules`, `.cursor/rules` and similar folders; a rule's globs or description say where it applies.
4. Skills. List the skills the instruction files or rules name, plus `.omp/skills`, `.claude/skills` and `skill://` skills whose description matches the kind of code changed (for example a SwiftUI skill for SwiftUI views). Read the ones that apply and check their rules.

Report each place the change breaks one of those written rules. In rule, name the source (file and section, or skill name); in expected, quote or paraphrase the rule and say what to do instead.

Mark a finding certain when the rule is explicit and plainly applies to the changed code. When a rule is ambiguous, conflicts with another, or only arguably applies, use certain false. Don't report style preferences no written rule backs; the Conventions reviewer covers consistency with existing code.
