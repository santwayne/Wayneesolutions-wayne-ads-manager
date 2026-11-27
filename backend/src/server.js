import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { migrate } from './db/migrate.js';

await migrate();
createApp().listen(config.port, () => logger.info({ port: config.port, apiVersion: config.meta.apiVersion }, 'wayne-ads api up'));
