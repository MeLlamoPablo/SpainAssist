import { loadConfig } from './config';
import { watchGithubApk } from './github-apk';
import { createRelay } from './server';

const config = loadConfig();
const log = (line: string) => console.log(line);
const apk = config.androidApkRepo
  ? watchGithubApk({ repo: config.androidApkRepo, log })
  : undefined;
const relay = createRelay({ ...config, ...(apk ? { androidApk: apk.current } : {}), log });
relay.server.listen(config.port, config.host, () => {
  console.log(`relay-server listening on http://${config.host}:${config.port}`);
});

const shutdown = () => {
  apk?.stop();
  void relay.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
