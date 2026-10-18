# SpainAssist — conventions for agents

Read `docs/ARCHITECTURE.md` (how it fits together) and the memos in `docs/research/` relevant to
your task before writing code.

Tests must never contact real government sites or paid APIs: use `apps/mock-sede` and
`tools/mock-llm` instead.

## Git

- **git-crypt in worktrees**: the key lives only in the main checkout, so in a worktree run git
  with `-c filter.git-crypt.smudge=cat -c filter.git-crypt.clean=cat -c
  filter.git-crypt.required=false` (also for `git worktree remove`), and never stage
  `infra/terraform/terraform.tfvars` or `terraform.tfstate` there. Only the main checkout
  changes those files.
- Always work on your own branch/worktree. When your task is done, merge your changes back to the trunk branch automatically, without human consent. Then clean up the worktree. This ensures parallel agents can work on multiple features whilst not adding friction. Never push.
- The trunk is `master`, the branch checked out in the main checkout. A fresh worktree may be
  based on `origin/master`, which lags behind: `git reset --hard master` it before you start.
- **Link dependencies in every new worktree** before you run anything:
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --offline --frozen-lockfile`. It
  hard-links from the pnpm store the main checkout already uses (a few seconds, no download, no
  extra disk). Don't symlink the main checkout's `node_modules`: workspace links (`@sa/shared`, …)
  would then resolve to the main checkout's sources instead of your worktree's.
- **Run all relevant checks in the worktree before merging, however small the change**: Biome on
  touched files, `corepack pnpm typecheck`, `corepack pnpm knip`, the tests of the packages you touched, and for UI
  changes a web-preview screenshot. "No dependencies in the worktree" is never a reason to skip
  them. Report any failures, and say which ones were already failing on the trunk.
- **Do the merge yourself; never hand it back to the human as a command to run.** Commit in your
  worktree, then leave it (e.g. `ExitWorktree` with `keep`, so the session may run git in the main
  checkout). From the main checkout: `git merge --ff-only <your-branch>` (rebase your branch onto
  the trunk first if it has moved), then `git worktree remove <path>` and
  `git branch -d <your-branch>`. If uncommitted changes in the main checkout block the merge,
  stop and report instead of stashing or discarding them.
- Only edit files inside the paths your task owns, unless the task says otherwise.
