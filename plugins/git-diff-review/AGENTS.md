# Agent notes

- Marketplace installs do not build. Run `bun run build` from the repository root after changing plugin or shared sources, and commit the generated bundles, Python helpers and web assets.
- Run `bun run test` from the repository root before committing.
- Extension changes need an omp restart after rebuilding; web changes need a rebuild and browser reload.
