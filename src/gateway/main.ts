import { readGatewayConfig } from './config.js';
import { GatewayStartupRefused, startGateway } from './server.js';

// ============================================================
// DEPLOYMENT ENTRY: node dist/gateway/main.js
//
// Loads no dotenv, no src/config and no src/database. The gateway's
// environment is the process's own, read once by readGatewayConfig. A refusal
// exits with 2 (bad configuration) and names every problem; nothing else is
// printed about the configuration.
// ============================================================

startGateway(readGatewayConfig())
  .then((running) => {
    const stop = () => {
      running.close().then(
        () => process.exit(0),
        () => process.exit(1)
      );
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  })
  .catch((err: unknown) => {
    if (err instanceof GatewayStartupRefused) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write('the web gateway failed to start\n');
    process.exit(1);
  });
