import { Worker } from 'bullmq';
import { logger } from '../lib/logger.js';
import { migrate } from '../db/migrate.js';
import { queue, redis, QUEUE_NAMES } from './queues.js';
import { handlers, SCHEDULES } from './handlers.js';

await migrate();

for (const s of SCHEDULES) {
  await queue(s.queue).upsertJobScheduler(s.name, { pattern: s.pattern, tz: 'Asia/Kolkata' }, { name: s.name, data: {} });
}

// WhatsApp conversations run with concurrency 1 so a user's messages are handled in order.
const CONCURRENCY = { sync: 3, rules: 2, leads: 5, reports: 2, wallet: 1, whatsapp: 1 };

for (const name of QUEUE_NAMES) {
  const w = new Worker(name, async (job) => {
    const fn = handlers[name]?.[job.name];
    if (!fn) throw new Error(`No handler for ${name}/${job.name}`);
    return fn(job.data);
  }, { connection: redis(), concurrency: CONCURRENCY[name] || 1 });
  w.on('failed', (job, err) => logger.error({ queue: name, job: job?.name, err: err.message }, 'job failed'));
}
logger.info('wayne-ads worker up');
