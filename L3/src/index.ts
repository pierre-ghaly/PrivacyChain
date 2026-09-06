import { config } from './config.js';
import { startIpfs, stopIpfs } from './ipfs.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  await startIpfs();

  const app = createServer();
  const server = app.listen(config.port, () => {
    console.log(`[L3] Encrypted Storage Service listening on :${config.port}`);
  });

  const shutdown = async () => {
    server.close();
    await stopIpfs();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[L3] Fatal:', err);
  process.exit(1);
});
