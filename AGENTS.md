# SpainAssist — conventions for agents

Read `docs/ARCHITECTURE.md` (how it fits together) and the memos in `docs/research/` relevant to
your task before writing code.

Tests must never contact real government sites or paid APIs: use `apps/mock-sede` and
`tools/mock-llm` instead.

After changing how the agent's browser launches or handles its windows (`packages/browser`, the
CRLSet, `BrowserHolder`), also run it as the app does: `SA_TEST_HEADED=1 corepack pnpm --filter
@sa/browser test`, and `corepack pnpm e2e --project parity` after building the desktop app. A Mac
can't show what breaks on Windows and Linux; CI's Windows and Linux jobs can, and a release
refuses a commit without green CI (`docs/ARCHITECTURE.md`, "Checks before users get a build").

## Git

- **git-crypt in worktrees**: the key lives only in the main checkout, so in a worktree run git
  with `-c filter.git-crypt.smudge=cat -c filter.git-crypt.clean=cat -c
  filter.git-crypt.required=false` (also for `git worktree remove`), and never stage
  `infra/terraform/terraform.tfvars`, `terraform.tfstate` or `infra/terraform/secrets/` there. Only the main checkout
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

## Production (Coolify)

- Coolify's API and dashboard answer only on the server's loopback (port 8000); see
  `infra/README.md`. Use Terraform from `infra/terraform` in the main checkout (git-crypt
  unlocked): `./tf.sh plan|apply|output` opens the SSH tunnel to the API itself. For a direct
  API call, open the tunnel yourself
  (`ssh -N -L 18000:127.0.0.1:8000 root@$(./tf.sh output -raw ipv4_address)`) and send
  `coolify_api_token` from `terraform.tfvars` as a Bearer token to `http://127.0.0.1:18000/api/v1/…`.
- The dashboard is for humans on the tailnet (`./tf.sh output urls`, `coolify`).
- Never make Coolify public again: no instance domain, proxy route or published port. GitHub
  reaches it only through `services/webhook-ingester`, which `./tf.sh apply` deploys (a push
  doesn't).
