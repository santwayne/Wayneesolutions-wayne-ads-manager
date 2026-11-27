import bcrypt from 'bcryptjs';
import { pool } from '../lib/db.js';
import { migrate } from './migrate.js';

/** Creates the Wayne agency org + first owner. Usage: SEED_EMAIL=.. SEED_PASSWORD=.. npm run seed */
const email = process.env.SEED_EMAIL;
const password = process.env.SEED_PASSWORD;
if (!email || !password) { console.error('Set SEED_EMAIL and SEED_PASSWORD'); process.exit(1); }
await migrate();
const { rows: [org] } = await pool.query("INSERT INTO orgs (name, type, plan) VALUES ('Wayne E Solutions', 'agency', 'agency') RETURNING id");
const { rows: [u] } = await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email.toLowerCase(), process.env.SEED_NAME || 'Wayne Admin', await bcrypt.hash(password, 10)]);
await pool.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')", [u.id, org.id]);
console.log(`Agency org ${org.id}, owner user ${u.id} created`);
await pool.end();
