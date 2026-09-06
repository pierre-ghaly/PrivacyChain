import { config } from './config';
import { KeyStore } from './keyStore';
import { createServer } from './server';
import { startEventListener } from './eventListener';

// WebSocket connection failures surface as unhandled 'error' events on the
// underlying ws.WebSocket before ethers attaches its own listener. Log and
// swallow them — the retry loop in eventListener.ts handles reconnection.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
    console.warn('[L2] L1 connection error (will retry):', err.message);
    return;
  }
  console.error('[L2] Uncaught exception:', err);
  process.exit(1);
});

async function main(): Promise<void> {
  const keyStore = new KeyStore();
  const app = createServer(keyStore);

  app.listen(config.port, () => {
    console.log(`[L2] Key Management Service listening on :${config.port}`);
  });

  await startEventListener(keyStore);
}

main().catch(err => {
  console.error('[L2] Fatal:', err);
  process.exit(1);
});
