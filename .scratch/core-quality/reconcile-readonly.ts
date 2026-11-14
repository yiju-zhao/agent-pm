// Read-only reconciliation of a real center database: opens it read-only (no migrations, no writes) and prints the
// coverage report. Tokens in the config are read to learn which sources are configured and are never printed.
//   node .scratch/core-quality/reconcile-readonly.ts <server.json>
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sourceCoverage } from '../../src/server/coverage.ts';
import type { ServerConfig } from '../../src/server/config.ts';

const configPath = process.argv[2]!;
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ServerConfig;
const db = new DatabaseSync(resolve(dirname(configPath), config.dbPath), { readOnly: true });
const now = new Date();
console.log(`schema v${(db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version}, checked ${now.toISOString()}`);
for (const s of sourceCoverage(db, config, now)) {
  const { limits: _limits, last_error, ...rest } = s;
  console.log(JSON.stringify({ ...rest, last_error: last_error ? last_error.slice(0, 160) : null }));
}
const one = (sql: string) => db.prepare(sql).get();
console.log('sessions', JSON.stringify(one("SELECT count(*) AS total, sum(lifecycle='live') AS live, sum(ignored) AS ignored FROM sessions WHERE merged_into IS NULL")));
console.log('sessions without any chunk', JSON.stringify(one('SELECT count(*) AS n FROM sessions s WHERE merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.session_key = s.key)')));
console.log('paseo agents by lifecycle/content', JSON.stringify(db.prepare("SELECT o.source_id, o.lifecycle, o.end_reason, o.content_state, count(*) AS n FROM session_sources o JOIN ingest_sources s ON s.source_id = o.source_id WHERE s.kind = 'paseo' GROUP BY 1,2,3,4").all()));
console.log('digest blocks', JSON.stringify(one('SELECT count(*) AS n FROM digest_blocks')));
db.close();
