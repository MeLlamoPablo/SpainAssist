import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 30_000,
    // The hooks that stop an app (agent hosts, Chromium) take longer than the default 10 s on a
    // machine that is busy with the rest of the suite.
    hookTimeout: 120_000,
    // The Codex login is refused when a CI variable is set (src/llm/codex-auth.ts). The tests of it
    // pass their own environment where they test that; everywhere else they must not depend on the
    // machine that runs them being or not being a CI runner.
    env: {
      CI: '',
      GITHUB_ACTIONS: '',
      GITLAB_CI: '',
      BUILDKITE: '',
      CIRCLECI: '',
      JENKINS_URL: '',
      TF_BUILD: '',
    },
  },
});
