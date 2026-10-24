import { config } from './core/config';
import { initSchema } from './core/db';
import { retryQueued } from './core/notificationService';
import { createApp } from './transport/web/app';

initSchema();

const app = createApp();

// Periodically retry any queued emails (e.g. after the provider recovers).
setInterval(() => {
  void retryQueued();
}, 30_000).unref();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`HMS running at ${config.publicBaseUrl} (port ${config.port})`);
  console.log('Open /login and use a demo account from the seed output.');
});
