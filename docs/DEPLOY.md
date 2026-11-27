# Deploy (spec stack: Node/Express, Postgres, React, BullMQ + Redis, AWS EC2 ap-south-1)

Note: the AWS budget rule says new software should go on another provider. The stack is plain Node + Postgres + Redis, so any Ubuntu VM works. Decide before provisioning.

## Server (Ubuntu)
```bash
git clone <repo> ~/wayne-ads-manager && cd ~/wayne-ads-manager/backend
npm ci && cp .env.example .env   # Pankaj fills secrets — never in chat/repo
npm run migrate
pm2 start src/server.js --name wayne-ads-api --update-env
pm2 start src/jobs/worker.js --name wayne-ads-worker --update-env
cd ../frontend && npm ci && VITE_API_URL=https://ads-api.wayneesolutions.com npm run build
sudo rsync -a --delete dist/ /var/www/wayne-ads/
```
nginx: `ads.wayneesolutions.com` → `/var/www/wayne-ads` (SPA fallback `try_files $uri /index.html`); `ads-api.wayneesolutions.com` → `127.0.0.1:4100`, with `proxy_set_header Host $host`. HTTPS via certbot. **Webhooks need HTTPS.**

## Security checklist
- Tokens are envelope-encrypted with KMS (`KMS_KEY_ID`), never logged (pino redaction).
- The DB app role must **not** own the tables, otherwise RLS is bypassed. Create the tables as `wayne_owner` and run the app as `wayne_app` with `GRANT SELECT, INSERT, UPDATE, DELETE`. withOrg() + `org_id` filters protect data even without RLS.
- Webhooks: `X-Hub-Signature-256` is verified on the raw body; the CRM webhook is HMAC-signed.
- Secrets live in `.env` or AWS Secrets Manager only. `.env` is gitignored.
- The app never calls billing, funding-source or payment endpoints (blocked in `meta/graph.js`).
