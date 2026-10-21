#!/usr/bin/env node
// Calls the cloud project's public cs_ping() function so a free-tier Supabase project is not paused for inactivity.
// Used by .github/workflows/keepalive.yml. It reads the same public settings the app uses (cloud.json); nothing secret is involved.
import { readFile } from 'node:fs/promises';
import { parseCloudConfig } from '../js/cloud-config.js';

let raw;
try {
  raw = JSON.parse(await readFile(new URL('../cloud.json', import.meta.url), 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('There is no cloud.json, so there is nothing to keep awake.');
    process.exit(0);
  }
  console.error(`cloud.json could not be read: ${err.message}`);
  process.exit(1);
}

const parsed = parseCloudConfig(raw);
if (!parsed.ok) {
  console.error(parsed.errors.join('\n'));
  process.exit(1);
}
if (!parsed.config) {
  console.log('Cloud sync is switched off in cloud.json, so there is nothing to keep awake.');
  process.exit(0);
}

const { url, publishableKey } = parsed.config;
const res = await fetch(`${url}/rest/v1/rpc/cs_ping`, {
  method: 'POST',
  headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(30000),
});
console.log(`cs_ping: HTTP ${res.status}`);
if (!res.ok) {
  console.error('The cloud project did not answer. If it was paused, restore it from the Supabase dashboard (Project > Restore).');
  process.exit(1);
}
