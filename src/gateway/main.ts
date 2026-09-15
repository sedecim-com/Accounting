import { readGatewayConfig } from './config.js';
import {
  GatewayDiscoveryFailed,
  GatewayListenFailed,
  GatewayStartupRefused,
  startGateway,
  startupExitCode,
} from './server.js';

// ============================================================
// DEPLOYMENT ENTRY: node dist/gateway/main.js
//
// Loads no dotenv, no src/config and no src/database. The gateway's
// environment is the process's own, read once by readGatewayConfig. A failed
// start exits with the CLI's contract codes, the same ones `mnemosine web
// start` gives (startupExitCode): 2 for a refusal of the configuration or the
// build, which names every problem; 8 for an IdP whose discovery could not be
// read, which is worth retrying; 1 for a socket that could not be opened,
// naming the host, the port and the system code (a port in use, a privileged
// port, an address this host lacks); 1 for anything else, with nothing echoed.
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
    if (err instanceof GatewayStartupRefused || err instanceof GatewayDiscoveryFailed || err instanceof GatewayListenFailed) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write('the web gateway failed to start\n');
    }
    process.exit(startupExitCode(err));
  });
