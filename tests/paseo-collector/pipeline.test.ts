// Task 5 acceptance: real-shaped (fixture) Paseo rows go SDK → collector → HTTP → DB → digest window → digest → project
// evidence, with an injected model; and the herdr + Paseo pair on one session feeds the analysis once.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getEvidence } from '../../src/domain/evidence.ts';
import { createCenterClient } from '../../src/paseo-collector/client.ts';
import { PaseoCollectorConfig } from '../../src/paseo-collector/config.ts';
import { PaseoCollector } from '../../src/paseo-collector/loop.ts';
import { Outbox } from '../../src/paseo-collector/outbox.ts';
import type { TimelinePage } from '../../src/paseo-collector/sdk.ts';
import { StateDir } from '../../src/paseo-collector/state-store.ts';
import { getSession } from '../../src/server/sessions-repo.ts';
import { nextWindow, runDigest } from '../../src/understand/digest.ts';
import type { LlmRunner } from '../../src/understand/llm.ts';
import { call, count, HERDR_TOKEN, herdrChunks, herdrSession, herdrSnapshot, MACHINE, PASEO_SOURCE, PASEO_TOKEN, SERVER_ID, startCenter } from '../helpers/center.ts';
import type { Center } from '../helpers/center.ts';
import { FakePaseo } from '../helpers/fake-paseo.ts';

let dir: string;
let center: Center;
let fake: FakePaseo;
let c: PaseoCollector;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'paseo-pipeline-'));
  center = startCenter(join(dir, 'center.db'));
  fake = new FakePaseo();
});
afterEach(async () => {
  await c?.stop();
  center.close();
  await rm(dir, { recursive: true, force: true });
});

function startCollector(): PaseoCollector {
  const cfg = PaseoCollectorConfig.parse({
    server: 'http://center.test',
    sourceId: PASEO_SOURCE,
    machine: MACHINE,
    tokenFile: '/dev/null',
    paseo: { url: 'ws://daemon.test/ws', serverId: SERVER_ID },
    stateDir: join(dir, 'state'),
    debounceMs: 0,
    pageLimit: 5,
  });
  const state = StateDir.open(cfg.stateDir, { sourceId: cfg.sourceId, serverId: cfg.paseo.serverId, server: cfg.server });
  return new PaseoCollector(cfg, {
    sdk: fake,
    client: createCenterClient({ server: cfg.server, token: PASEO_TOKEN, fetch: (u, i) => Promise.resolve(center.app.request(u, i)) }),
    state,
    outbox: new Outbox(cfg.stateDir),
    now: () => center.now,
    log: () => {},
  });
}

async function run(): Promise<void> {
  await c.reconcile();
  await c.heartbeat();
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await c.settled();
  }
}

function loadFixture(agentId: string, provider: string): void {
  const page = JSON.parse(readFileSync(new URL(`../fixtures/paseo/timeline-${provider}-after-0.json`, import.meta.url), 'utf8')) as TimelinePage;
  fake.addAgent(agentId, { provider, nativeId: `${provider}-native-1` });
  const a = fake.agents.get(agentId)!;
  a.epoch = page.epoch;
  a.rows = page.entries;
  a.nextSeq = Math.max(...page.entries.map((e) => e.seqEnd)) + 1;
}

const digestRunner = (quote: (chunkIds: number[]) => string): { runner: LlmRunner; prompts: string[] } => {
  const prompts: string[] = [];
  const runner: LlmRunner = async (llmCall) => {
    prompts.push(llmCall.prompt);
    const ids = [...llmCall.prompt.matchAll(/<chunk id="(\d+)"/g)].map((m) => Number(m[1]));
    return {
      ok: true,
      text: '',
      structured: {
        topics: [{ label: '采集器', summary: '修采集器', likely_project_ids: [], is_new_topic: true, confidence: 0.9 }],
        decisions: [{ text: '用 Paseo SDK 采集', quote_ref: quote(ids) }],
        progress: ['完成第一步'],
        todos_added: [],
        todos_done: [],
        blockers: [],
        open_questions: [],
        trivial: false,
      },
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
      costUsd: 0,
      durationMs: 1,
    };
  };
  return { runner, prompts };
};

test.each(['claude', 'codex'])('%s fixture rows reach the digest and come back as traceable evidence', async (provider) => {
  loadFixture('fx', provider);
  c = startCollector();
  await run();
  const key = `${provider}:${provider}-native-1`;
  const window = nextWindow(center.db, key, 'backfill');
  expect(window).not.toBeNull();
  // Tool calls with outcomes are in the analysis input; reasoning is not.
  expect(window!.text).toMatch(/tool: \S+/);
  expect(window!.text).not.toMatch(/reasoning/);
  const { runner, prompts } = digestRunner((ids) => `chunk:${ids[0]}`);
  const outcome = await runDigest(center.db, { now: () => center.now, newId: () => 'id-1' }, runner, window!, { model: 'test', force: true });
  expect(outcome.status).toBe('digested');
  expect(prompts[0]).toContain('<chunk id=');
  const digestId = (outcome as { digestId: number }).digestId;
  const evidence = getEvidence(center.db, center.now, `digest:${digestId}`)!;
  expect(evidence.session!.key).toBe(key);
  expect(evidence.session!.sources[0]).toMatchObject({ source_id: PASEO_SOURCE, kind: 'paseo', external_id: 'fx', content_role: 'owner' });
  for (const ch of evidence.chunks) {
    expect(ch.source).toMatchObject({ source_id: PASEO_SOURCE, kind: 'paseo', agent_id: 'fx', epoch: expect.stringMatching(/^epoch-/) });
    expect(ch.source!.events).toBeGreaterThan(0);
    expect(ch.source!.seq_start).toBeLessThanOrEqual(ch.source!.seq_end!);
  }
  // Every chunk in the window is now processed and none is queued twice.
  expect(count(center.db, 'SELECT count(*) AS n FROM chunks WHERE session_key = ? AND digested = 0 AND backfill = 1', key)).toBe(0);
});

test('herdr and Paseo on the same provider session: one logical session, the analysis input is not doubled', async () => {
  const key = 'claude:shared-native';
  await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot([herdrSession(key)]));
  await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks(key, 0, 900, '[2026-11-06T09:00Z] user: please fix the collector'));
  fake.addAgent('both', { nativeId: 'shared-native' });
  fake.user('both', 'please fix the collector', 'm-1');
  fake.assistant('both', 'fixed it', 'm-2');
  c = startCollector();
  await run();
  const view = getSession(center.db, key, center.now)!;
  expect(view.sources.map((s) => [s.source_id, s.content_role])).toEqual([
    [`herdr:${MACHINE}`, 'owner'],
    [PASEO_SOURCE, 'standby'],
  ]);
  const realtime = nextWindow(center.db, key, 'realtime');
  const backfill = nextWindow(center.db, key, 'backfill');
  const inputs = [realtime?.text ?? '', backfill?.text ?? ''].join('\n');
  expect(inputs.split('please fix the collector').length - 1).toBe(1);
  expect(count(center.db, "SELECT count(*) AS n FROM source_events WHERE source_id = ? AND disposition = 'standby'", PASEO_SOURCE)).toBe(2);
});

test('an agent going idle or being archived changes no project', async () => {
  fake.addAgent('p1');
  fake.user('p1', 'start', 'p1-u');
  c = startCollector();
  await run();
  const key = 'claude:native-p1';
  center.db.prepare(`INSERT INTO projects (id, title, stage, created_at) VALUES ('proj', 'P', 'building', 'x')`).run();
  center.db.prepare(`INSERT INTO contributions (id, session_key, project_id, created_at) VALUES ('c', ?, 'proj', 'x')`).run(key);
  fake.setStatus('p1', 'idle');
  fake.archive('p1');
  await run();
  await run();
  expect(getSession(center.db, key, center.now)!.effective_status).toBe('ended');
  expect(center.db.prepare("SELECT stage FROM projects WHERE id = 'proj'").get()).toEqual({ stage: 'building' });
  expect(count(center.db, 'SELECT count(*) AS n FROM events')).toBe(0);
});
