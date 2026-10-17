import './no-network';
import { refreshCodexCredentialIfNeeded } from '../../../src/llm/codex-auth';

/** A second eval process: refreshes the stored Codex login against the fake auth server. */
const [home, endpoints] = process.argv.slice(2);
const credential = await refreshCodexCredentialIfNeeded({
  home: home!,
  consent: true,
  endpoints: JSON.parse(endpoints!),
});
process.stdout.write(JSON.stringify({ refresh: credential.refresh, access: credential.access }));
