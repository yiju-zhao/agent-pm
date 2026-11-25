import { afterEach, beforeEach, expect, test } from 'vitest';

import { rebuildSearchIndex, searchContext } from '../../src/server/search.ts';
import { agent, event, PaseoWriter, startCenter, type Center } from '../helpers/center.ts';

let center: Center;
beforeEach(() => {
  center = startCenter();
  center.db.exec(`INSERT INTO projects(id,title,created_at) VALUES ('p_old','主题','2026-01-01'),('p_new','主题','2026-02-01');
    INSERT INTO decisions(id,project_id,text) VALUES ('d_one','p_old','采集改为订阅驱动，解决阻塞 HTTP');`);
});
afterEach(() => center.close());
const search = (query: string) => searchContext(center.db, query, { scope: 'all', limit: 10 });

test('a Chinese substring opens its decision', () => {
  expect(search('订阅驱动')).toMatchObject([{ ref: 'd_one', kind: 'decision', snippet: expect.stringContaining('订阅驱动') }]);
});

test('two-character Chinese terms find ledger entries', () => {
  expect(search('阻塞').map(hit => hit.ref)).toEqual(['d_one']);
});

test('English search ignores case', () => {
  expect(search('http').map(hit => hit.ref)).toEqual(['d_one']);
});

test('editing a todo replaces its searchable text', () => {
  center.db.exec("INSERT INTO todos(id,project_id,title) VALUES ('t_one','p_old','旧的条目'); UPDATE todos SET title='新的文字' WHERE id='t_one'");
  expect(search('旧的条目')).toEqual([]);
  expect(search('新的文字')).toHaveLength(1);
});

test('deleted decisions no longer appear in search', () => {
  center.db.exec("UPDATE decisions SET deleted_at='today' WHERE id='d_one'");
  expect(search('订阅驱动')).toEqual([]);
});

test('a limited search returns the newest match first', () => {
  expect(searchContext(center.db, '主题', { scope: 'ledger', limit: 1 }).map(hit => hit.ref)).toEqual(['p_new']);
});

test('project-scoped search returns only that project’s matches', () => {
  expect(searchContext(center.db, '主题', { scope: 'all', limit: 10, projectId: 'p_old' }).map(hit => hit.ref)).toEqual(['p_old']);
});

test('digest-scoped search excludes matching ledger entries', () => {
  center.db.prepare("INSERT INTO digests(session_key,json) VALUES ('claude:session',?)").run(JSON.stringify({ progress: ['摘要主题'] }));
  expect(searchContext(center.db, '主题', { scope: 'digests', limit: 10 }).map(hit => hit.kind)).toEqual(['digest']);
});

async function writeMessageRevision(): Promise<void> {
  const writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent('a', { native_id: 'session1', native_id_origin: 'runtime' })]);
  const end = { epoch: 'epoch-1', seq: 1 };
  const first = event('msg:question', 1, { kind: 'user', text: '寻找旧关键词' });
  await writer.batch(writer.batchBody('a', null, end, [first]));
  await writer.batch(writer.batchBody('a', end, end, [{ ...first, text: '寻找新关键词' }]));
}

test('message search opens the turn containing the matching user message', async () => {
  await writeMessageRevision();
  expect(search('新关键词')).toMatchObject([{ kind: 'message', ref: 's:session1#1' }]);
});

test('message search drops the previous text after a revision', async () => {
  await writeMessageRevision();
  expect(search('旧关键词')).toEqual([]);
});

test('rebuilding the index restores the original ledger and message hits', async () => {
  await writeMessageRevision();
  const hits = [...search('订阅驱动'), ...search('新关键词')];
  center.db.exec('DELETE FROM search_index');
  rebuildSearchIndex(center.db);
  expect([...search('订阅驱动'), ...search('新关键词')]).toEqual(hits);
});
