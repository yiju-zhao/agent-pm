import { afterEach, beforeEach, expect, test } from 'vitest';

import { rebuildSearchIndex, searchContext } from '../../src/server/search.ts';
import { agent, event, PaseoWriter, startCenter, type Center } from '../helpers/center.ts';

let center: Center;
beforeEach(() => { center=startCenter(); });
afterEach(() => center.close());
const search = (query:string) => searchContext(center.db,query,{scope:'all',limit:10});

test('ledger search matches literal Chinese substrings and ignores English case', () => {
  center.db.exec("INSERT INTO projects(id,title) VALUES ('p_one','采集'); INSERT INTO decisions(id,project_id,text) VALUES ('d_one','p_one','采集改为订阅驱动，解决阻塞 HTTP')");
  for (const term of ['订阅驱动','阻塞','http']) expect(search(term).map(h=>h.ref)).toEqual(['d_one']);
  expect(search('驱动')[0].snippet).toContain('驱动');
});

test('editing and deleting ledger items updates their searchable text', () => {
  center.db.exec("INSERT INTO projects(id,title) VALUES ('p_one','测试'); INSERT INTO todos(id,project_id,title) VALUES ('t_one','p_one','旧的条目')");
  center.db.exec("UPDATE todos SET title='新的文字' WHERE id='t_one'");
  expect(search('旧的条目')).toEqual([]);
  expect(search('新的文字')).toHaveLength(1);
  center.db.exec("UPDATE todos SET deleted_at='today' WHERE id='t_one'");
  expect(search('新的文字')).toEqual([]);
});

test('scope, project membership, time ordering and limit narrow the results', () => {
  center.db.exec("INSERT INTO projects(id,title,created_at) VALUES ('p_old','主题','2026-01-01'),('p_new','主题','2026-02-01')");
  expect(searchContext(center.db,'主题',{scope:'ledger',limit:1})[0].ref).toBe('p_new');
  expect(searchContext(center.db,'主题',{scope:'ledger',limit:1,projectId:'p_old'})[0].ref).toBe('p_old');
  center.db.prepare("INSERT INTO digests(session_key,json) VALUES ('claude:session',?)").run(JSON.stringify({progress:['摘要主题']}));
  expect(searchContext(center.db,'主题',{scope:'digests',limit:10}).map(h=>h.kind)).toEqual(['digest']);
});

test('message revisions are searchable at their turn address before and after rebuilding', async () => {
  const w=new PaseoWriter(center); await w.lease(); await w.snapshot([agent('a',{native_id:'session1',native_id_origin:'runtime'})]);
  const end={epoch:'epoch-1',seq:1};
  const first=event('msg:question',1,{kind:'user',text:'寻找旧关键词'});
  await w.batch(w.batchBody('a',null,end,[first]));
  await w.batch(w.batchBody('a',end,end,[{...first,text:'寻找新关键词'}]));
  expect(search('旧关键词')).toEqual([]);
  const hits=search('新关键词');
  expect(hits).toMatchObject([{kind:'message',ref:'s:session1#1'}]);
  center.db.exec('DELETE FROM search_index');
  rebuildSearchIndex(center.db);
  expect(search('新关键词')).toEqual(hits);
});
