import { loadConfig } from './config';
import { createRelay } from './server';

const config = loadConfig();
const relay = createRelay({ ...config, log: (line) => console.log(line) });
relay.server.listen(config.port, config.host, () => {
  console.log(`relay-server listening on http://${config.host}:${config.port}`);
});

const shutdown = () => {
  void relay.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
