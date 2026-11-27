import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

export const QUEUE_NAMES = ['sync', 'rules', 'leads', 'reports', 'wallet', 'whatsapp'];
let connection;
const queues = new Map();
export const enqueued = []; // test mode capture

export function redis() {
  if (!connection) connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  return connection;
}

export function queue(name) {
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection: redis(), defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 } }));
  return queues.get(name);
}

export async function enqueue(name, jobName, data, opts = {}) {
  if (config.isTest || process.env.QUEUE_MODE === 'memory') { enqueued.push({ name, jobName, data, opts }); return null; }
  return queue(name).add(jobName, data, opts);
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  if (connection) await connection.quit();
}
