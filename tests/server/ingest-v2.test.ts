import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LEASE_TTL_MS } from '../../src/shared/ingest-v2.ts';
import { agent, count, event, PaseoWriter, startCenter } from '../helpers/center.ts';
import type { Center } from '../helpers/center.ts';

let center: Center;
let w: PaseoWriter;
const A = 'agent-1';

beforeEach(async () => {
  center = startCenter();
  w = new PaseoWriter(center);
  await w.lease();
  await w.snapshot([agent(A, { native_id: 'n-1', native_id_origin: 'runtime' })]);
});
afterEach(() => center.close());

const chunks = () => count(center.db, 'SELECT count(*) AS n FROM chunks');
const queued = () => count(center.db, 'SELECT count(*) AS n FROM chunks WHERE digested = 0');

describe('lease and snapshot revisions', () => {
  test('a second instance is refused while the lease lives, and takes over after it expires', async () => {
    const b = new PaseoWriter(center, 'instance-b-0002');
    expect((await b.lease()).json.error).toBe('lease_held');
    center.advance(LEASE_TTL_MS + 1);
    expect((await b.lease()).status).toBe(200);
    expect(b.epoch).toBe(w.epoch + 1);
    // The old instance cannot write any more, even with a newer revision.
    expect((await w.snapshot([])).json.error).toBe('stale_lease');
    const late = await w.batch(w.batchBody(A, null, { epoch: 'e', seq: 1 }, [event('msg:1', 1)]));
    expect(late.json.error).toBe('stale_lease');
    expect(chunks()).toBe(0);
  });

  test('a late or repeated snapshot revision is refused', async () => {
    const sent = await w.snapshot([agent(A)]);
    expect(sent.status).toBe(200);
    const rev = sent.json.snapshot_rev as number;
    expect((await w.snapshot([], { snapshot_rev: rev })).json.error).toBe('stale_snapshot');
    expect((await w.snapshot([], { snapshot_rev: rev - 1 })).json.error).toBe('stale_snapshot');
    // A refused late snapshot changed nothing.
    expect(count(center.db, "SELECT count(*) AS n FROM session_sources WHERE lifecycle = 'live'")).toBe(1);
  });

  test('a collector connected to another daemon is refused', async () => {
    const wrong = new PaseoWriter(center, 'instance-c-0003', w.token, w.sourceId, 'srv_somebody_else');
    expect((await wrong.lease()).json.error).toBe('identity_mismatch');
    expect((await w.snapshot([], { daemon: { status: 'connected', error: null, server_id: 'srv_somebody_else' } })).json.error).toBe('identity_mismatch');
  });
});

describe('batches', () => {
  test('commit, then a retry of the same batch (lost ack) returns the same ack and adds nothing', async () => {
    const body = w.batchBody(A, null, { epoch: 'epoch-1', seq: 2 }, [event('msg:1', 1), event('tool:1', 2, { kind: 'tool', item_type: 'tool_call', text: '', tool: { name: 'shell', status: 'completed', exit_code: 1, input: 'npm test', input_truncated: null, output: '2 failed', output_truncated: null, error: null } })]);
    const first = await w.batch(body);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ accepted: 2, materialized: 2, duplicates: 0, checkpoint: { epoch: 'epoch-1', seq: 2 } });
    const before = { chunks: chunks(), events: count(center.db, 'SELECT count(*) AS n FROM source_events') };
    const retry = await w.batch(body);
    expect(retry.json).toEqual(first.json);
    expect({ chunks: chunks(), events: count(center.db, 'SELECT count(*) AS n FROM source_events') }).toEqual(before);
    // The tool failure is visible to the analysis as a failure.
    const text = (center.db.prepare('SELECT text FROM chunks').get() as { text: string }).text;
    expect(text).toMatch(/tool: shell npm test → 失败\(exit 1\)/);
    expect((await w.checkpoint(A)).json).toMatchObject({ checkpoint: { epoch: 'epoch-1', seq: 2 }, last_batch_id: body.batch_id });
  });

  test('the same batch id with other content is a conflict', async () => {
    const body = w.batchBody(A, null, { epoch: 'epoch-1', seq: 1 }, [event('msg:1', 1)]);
    await w.batch(body);
    const other = await w.batch({ ...body, events: [event('msg:1', 1, { text: 'changed' })] });
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('batch_conflict');
  });

  test('a batch that does not continue from the committed position is refused with that position', async () => {
    await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 5 }, [event('msg:1', 1)]));
    const stale = await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 9 }, [event('msg:2', 7)]));
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: 'checkpoint_mismatch', checkpoint: { epoch: 'epoch-1', seq: 5 } });
    const ahead = await w.batch(w.batchBody(A, { epoch: 'epoch-1', seq: 7 }, { epoch: 'epoch-1', seq: 9 }, [event('msg:2', 8)]));
    expect(ahead.json.error).toBe('checkpoint_mismatch');
    const backwards = await w.batch(w.batchBody(A, { epoch: 'epoch-1', seq: 5 }, { epoch: 'epoch-1', seq: 4 }, []));
    expect(backwards.status).toBe(400);
  });

  test('a page whose rows were all filtered still commits its position', async () => {
    const r = await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 40 }, [], { filtered: { reasoning: 38 } }));
    expect(r.json).toMatchObject({ accepted: 0, checkpoint: { seq: 40 } });
    expect(chunks()).toBe(0);
    expect((await w.checkpoint(A)).json.checkpoint).toEqual({ epoch: 'epoch-1', seq: 40 });
  });

  test('a batch for an agent never reported is refused', async () => {
    const r = await w.batch(w.batchBody('agent-unknown', null, { epoch: 'e', seq: 1 }, [event('msg:1', 1)]));
    expect(r.json.error).toBe('unknown_agent');
  });

  test('an oversized body is refused before it is parsed', async () => {
    const huge = w.batchBody(A, null, { epoch: 'e', seq: 1 }, Array.from({ length: 10 }, (_, i) => event(`msg:${i}`, i, { text: 'x'.repeat(60_000) })));
    const r = await w.batch(huge);
    expect(r.status).toBe(413);
    expect(chunks()).toBe(0);
  });

  test('a failing transaction commits nothing and does not move the checkpoint', async () => {
    center.db.exec('DROP TABLE chunk_sources');
    const body = w.batchBody(A, null, { epoch: 'epoch-1', seq: 3 }, [event('msg:1', 1)]);
    await expect(w.batch(body)).resolves.toMatchObject({ status: 500 });
    center.db.exec('CREATE TABLE chunk_sources (chunk_id INTEGER NOT NULL, source_event_id INTEGER NOT NULL, PRIMARY KEY (chunk_id, source_event_id))');
    expect(count(center.db, 'SELECT count(*) AS n FROM source_events')).toBe(0);
    expect(count(center.db, 'SELECT count(*) AS n FROM ingest_batches')).toBe(0);
    expect((await w.checkpoint(A)).json.checkpoint).toBeNull();
    // The same batch goes through once the problem is gone.
    expect((await w.batch(body)).json).toMatchObject({ materialized: 1 });
  });
});

describe('revisions and overlap', () => {
  test('a re-read row is a duplicate; grown text adds only the suffix; a rewrite is kept for review, never overwritten', async () => {
    const one = event('msg:a', 1, { text: 'first part of the answer' });
    await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 1 }, [one]));
    // The straddling row comes again on the next page: duplicate.
    const again = await w.batch(w.batchBody(A, { epoch: 'epoch-1', seq: 1 }, { epoch: 'epoch-1', seq: 2 }, [one]));
    expect(again.json).toMatchObject({ duplicates: 1, materialized: 0 });
    // Projected text grew.
    const grown = await w.batch(w.batchBody(A, { epoch: 'epoch-1', seq: 2 }, { epoch: 'epoch-1', seq: 3 }, [{ ...one, text: 'first part of the answer, and the rest of it' }]));
    expect(grown.json).toMatchObject({ materialized: 1 });
    const texts = (center.db.prepare('SELECT text FROM chunks ORDER BY id').all() as Array<{ text: string }>).map((r) => r.text);
    expect(texts[1]).toMatch(/assistant（续）: , and the rest of it$/);
    // Rewritten text: a revision for review; the chunk already cited stays as it was.
    const firstChunk = texts[0];
    const rewritten = await w.batch(w.batchBody(A, { epoch: 'epoch-1', seq: 3 }, { epoch: 'epoch-1', seq: 4 }, [{ ...one, text: 'a completely different answer' }]));
    expect(rewritten.json).toMatchObject({ review: 1, materialized: 0 });
    expect((center.db.prepare('SELECT text FROM chunks ORDER BY id').get() as { text: string }).text).toBe(firstChunk);
    expect(count(center.db, "SELECT count(*) AS n FROM source_events WHERE event_key = 'msg:a'")).toBe(3);
  });

  test('two projected rows under one provider message id (seen on codex) are two events, both analysed', async () => {
    // As on the real daemon: assistant rows 309-318 and 321-322 carry the same messageId, a tool call between them.
    const first = event('msg:m1', 309, { seq_end: 318, text: 'first part of a codex message, long enough' });
    const tool = event('tool:t1', 319, { seq_end: 320, kind: 'tool', item_type: 'tool_call', text: '', tool: { name: 'shell', status: 'completed', exit_code: 0, input: 'ls', input_truncated: null, output: '', output_truncated: null, error: null } });
    const second = event('msg:m1', 321, { seq_end: 322, text: 'a second, separate part' });
    const r = await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 322 }, [first, tool, second]));
    expect(r.json).toMatchObject({ accepted: 3, materialized: 3, review: 0 });
    expect(center.db.prepare("SELECT event_key FROM source_events WHERE base_key = 'msg:m1' ORDER BY id").all()).toEqual([{ event_key: 'msg:m1' }, { event_key: 'msg:m1~321' }]);
    // The same rows replayed in a replaced epoch are duplicates, both of them.
    const replay = await w.batch(
      w.batchBody(A, { epoch: 'epoch-1', seq: 322 }, { epoch: 'epoch-2', seq: 14 }, [{ ...first, epoch: 'epoch-2', seq_start: 1, seq_end: 10 }, { ...second, epoch: 'epoch-2', seq_start: 13, seq_end: 14 }], {
        reset: { previous_epoch: 'epoch-1', reason: 'replacement' },
      }),
    );
    expect(replay.json).toMatchObject({ duplicates: 2, materialized: 0, review: 0 });
  });

  test('the same words said twice are two events, not a duplicate', async () => {
    const r = await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 2 }, [event('msg:u1', 1, { kind: 'user', item_type: 'user_message', text: 'run the tests again' }), event('msg:u2', 2, { kind: 'user', item_type: 'user_message', text: 'run the tests again' })]));
    expect(r.json).toMatchObject({ accepted: 2, materialized: 2 });
  });

  test('a running tool call that finishes is analysed once finished', async () => {
    const running = event('tool:t', 1, { kind: 'tool', item_type: 'tool_call', text: '', tool: { name: 'shell', status: 'running', exit_code: null, input: 'make', input_truncated: null, output: '', output_truncated: null, error: null } });
    await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 0 }, [running]));
    const done = await w.batch(w.batchBody(A, { epoch: 'epoch-1', seq: 0 }, { epoch: 'epoch-1', seq: 2 }, [{ ...running, tool: { ...running.tool!, status: 'failed', error: 'exit 2' } }]));
    expect(done.json).toMatchObject({ materialized: 1, review: 0 });
  });

  test('after a replacement, id-less rows of already received history are unverified overlap; provider ids dedupe; new rows flow', async () => {
    await w.batch(w.batchBody(A, null, { epoch: 'epoch-1', seq: 10 }, [event('msg:1', 1), event('row:epoch-1:5:compaction', 5, { kind: 'notice', item_type: 'compaction', stable_id: false, text: 'compacted' }), event('msg:2', 10)]));
    const before = queued();
    // The epoch was replaced: seqs start over and the id-less row comes back under a new key.
    const reread = await w.batch(
      w.batchBody(A, { epoch: 'epoch-1', seq: 10 }, { epoch: 'epoch-2', seq: 4 }, [
        event('msg:1', 1, { epoch: 'epoch-2' }),
        event('row:epoch-2:2:compaction', 2, { epoch: 'epoch-2', ts: event('x', 5).ts, kind: 'notice', item_type: 'compaction', stable_id: false, text: 'compacted' }),
      ], { reset: { previous_epoch: 'epoch-1', reason: 'replacement' } }),
    );
    expect(reread.json).toMatchObject({ duplicates: 1, review: 1, materialized: 0 });
    // A later page of the same re-read: still guarded; then genuinely new rows are analysed.
    const later = await w.batch(
      w.batchBody(A, { epoch: 'epoch-2', seq: 4 }, { epoch: 'epoch-2', seq: 9 }, [
        event('row:epoch-2:3:compaction', 3, { epoch: 'epoch-2', ts: event('x', 7).ts, kind: 'notice', item_type: 'compaction', stable_id: false, text: 'x' }),
        event('msg:3', 30, { epoch: 'epoch-2' }),
      ]),
    );
    expect(later.json).toMatchObject({ review: 1, materialized: 1 });
    expect(queued()).toBe(before + 1);
    expect(count(center.db, "SELECT count(*) AS n FROM ingest_gaps WHERE reason = 'epoch_replaced'")).toBe(1);
  });
});
