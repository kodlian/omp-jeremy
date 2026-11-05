---
name: Conventions
kind: review
description: Naming, structure and patterns consistent with the rest of the codebase
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

Check that the change reads as if the people who wrote the rest of this codebase wrote it:

- Names follow the neighboring files: casing, prefixes and suffixes, vocabulary for the same concepts.
- It reuses the existing helpers, components and patterns instead of adding parallel ones. Search for them before deciding something is new.
- Structure and layering match where similar code lives: which module owns what, where types, tests and assets go.
- Comments, error messages and log lines follow the project's style.

In expected, cite the existing code to match: its path and symbol. Project rules (AGENTS.md, CLAUDE.md, rules and skills) beat what you infer from the code.

Mark a finding certain only for an explicit project rule or a clear, consistent pattern the change breaks; a preference or a pattern with exceptions is a judgment call with certain false.
