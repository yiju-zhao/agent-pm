import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { setup,NOW } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';
import { pickProjectReview,runProjectReview,reviewFamily,reviewDigestDependency,REVIEW_BATCH } from '../../src/understand/project-review.ts';
import { createApp } from '../../src/server/http.ts';
import { Scheduler } from '../../src/understand/scheduler.ts';
import type { LlmCall,LlmResult,LlmRunner } from '../../src/understand/llm.ts';
let t:Setup;
const A='codex:aaaaaaaa',B='codex:bbbbbbbb';
const ok=():Extract<LlmResult,{ok:true}>=>({ok:true,text:'整理完成',structured:null,usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0},costUsd:0,durationMs:1});
beforeEach(()=>{t=setup();t.db.prepare('INSERT INTO machines(label,last_heartbeat) VALUES (?,?)').run('laptop',NOW);});
afterEach(()=>t.db.close());
function session(key=A) {t.db.prepare(`INSERT INTO sessions(key,agent_kind,machine,cwd,title,live_status,lifecycle,ignored,first_seen,last_seen,status_changed_at) VALUES (?,'codex','laptop','/work','task','idle','live',0,?,?,?)`).run(key,NOW,NOW,NOW);}
function project(title='项目') {return t.user('create_project',{title}).id;}
function digest(key=A,label='过去已整理的事实',curated=1,ts=NOW) {
 const json=JSON.stringify({topics:[],decisions:[],progress:[label],todos_added:[],todos_done:[],blockers:[],open_questions:[],trivial:false});
 return Number(t.db.prepare('INSERT INTO digests(session_key,chunk_ids,json,model,ts_start,ts_end,backfill,trivial,skipped,curated,created_at) VALUES (?,\'[]\',?,\'m\',?,?,1,0,0,?,?)').run(key,json,ts,ts,curated,NOW).lastInsertRowid);
}
function job(){const j=pickProjectReview(t.db,t.deps.now());expect(j).not.toBeNull();return j!;}
async function write(call:LlmCall,name:string,args:Record<string,unknown>){const tool=call.tools!.find(x=>x.name===name)!;expect(tool).toBeTruthy();const out=await tool.handler(args);try{return JSON.parse(out.text);}catch{return out;}}

test('user association and merge atomically enqueue, duplicate links and AI writes do not loop',()=>{
 session();const p=project(),q=project('来源');
 const link=t.user('link_session',{session:A,project:q});expect(link.status).toBe('applied');expect(job().project_id).toBe(q);
 t.user('link_session',{session:A,project:q});expect(t.db.prepare("SELECT count(*) n FROM project_reviews WHERE status='pending'").get()).toEqual({n:1});
 t.ai('link_session',{session:A,project:p});expect(t.db.prepare('SELECT count(*) n FROM project_reviews').get()).toEqual({n:1});
 t.user('transition_stage',{project:q,stage:'merged',merge_into:p});
 expect(t.db.prepare("SELECT project_id FROM project_reviews WHERE project_id=? AND status='pending'").get(p)).toEqual({project_id:p});
 expect(reviewFamily(t.db,p).sessions).toEqual([A]);
 expect(t.user('transition_stage',{project:p,stage:'merged',merge_into:p}).status).toBe('rejected');
});

test('successive user associations coalesce and undo makes the old request obsolete',()=>{
 session();session(B);const p=project();
 const first=t.user('link_session',{session:A,project:p});
 t.user('link_session',{session:B,project:p});
 expect(t.db.prepare("SELECT count(*) n FROM project_reviews WHERE status='pending'").get()).toEqual({n:1});
 t.user('revert_event',{event_id:first.event_id});
 expect(reviewFamily(t.db,p).sessions).toEqual([B]);
 expect(job().event_id).not.toBe(first.event_id);
});

test('review replays historical curated digests and full source records into the target through scoped tools',async()=>{
 session();const target=project('主项目'),source=project('被并入项目');
 t.user('upsert_todo',{project:source,title:'历史工作不能丢'});
 t.user('link_session',{session:A,project:source});const old=digest(A,'陈旧但必要的历史摘要');
 t.user('transition_stage',{project:source,stage:'merged',merge_into:target});
 // Drop the obsolete source request by resolving it; the merge target is the work we test.
 pickProjectReview(t.db,t.deps.now());
 const j=job();expect(j.project_id).toBe(target);
 let calls=0;
 const result=await runProjectReview(t.db,t.deps,async call=>{
  calls++;expect(call.prompt).toContain('历史工作不能丢');expect(call.prompt).toContain('陈旧但必要的历史摘要');
  expect(call.prompt).toContain(`digest`);expect(call.tools!.some(x=>x.name==='delete_todo')).toBe(true);
  const denied=await write(call,'upsert_todo',{project:source,title:'不允许改来源',reason:'r',evidence:[`digest:${old}`]});expect(denied.isError??denied.status).not.toBe('applied');
  expect((await write(call,'upsert_todo',{project:target,title:'整合后的工作',reason:'用户合并后整合来源工作',evidence:[`digest:${old}`]})).status).toBe('applied');
  expect((await write(call,'link_session',{project:target,session:A,reason:'并入来源会话',evidence:[`event:${j.event_id}`]})).status).toBe('applied');
  return ok();
 },j,'m');
 expect(result.ok).toBe(true);expect(calls).toBe(1);
 expect(t.db.prepare('SELECT title FROM todos WHERE project_id=?').all(source)).toEqual([{title:'历史工作不能丢'}]);
 expect(t.db.prepare('SELECT title FROM todos WHERE project_id=?').all(target)).toEqual([{title:'整合后的工作'}]);
 expect(t.db.prepare('SELECT curated FROM digests WHERE id=?').get(old)).toEqual({curated:1});
});

test('many historical digests are replayed in bounded chronological batches; restart resumes the cursor',async()=>{
 session();const p=project();t.user('link_session',{session:A,project:p});
 for(let i=0;i<REVIEW_BATCH+3;i++)digest(A,`fact-${i}`,i%2,new Date(Date.parse(NOW)+i*1000).toISOString());
 let reads=0;
 const runner:LlmRunner=async call=>{reads+=(call.prompt.match(/<digest /g)||[]).length;return ok();};
 const first=await runProjectReview(t.db,t.deps,runner,job(),'m');expect(first.ok&&first.finished).toBe(false);
 expect(job().cursor).toBe(REVIEW_BATCH);
 const second=await runProjectReview(t.db,t.deps,runner,job(),'m');expect(second.ok&&second.finished).toBe(true);
 expect(reads).toBe(REVIEW_BATCH+3);expect(pickProjectReview(t.db,t.deps.now())).toBeNull();
 expect(t.db.prepare('SELECT count(*) n FROM digests WHERE curated=0').get()).toEqual({n:12});
});

test('refused session content is not resubmitted; the job records information gaps',async()=>{
 session();const p=project();digest(A,'可用的历史摘要');
 t.db.prepare("INSERT INTO chunks(session_key,kind,text,backfill,digest_block_id) VALUES (?,'transcript','被拒的原文',0,1)").run(A);
 t.db.prepare('INSERT INTO digest_blocks(session_key,chunk_ids,message,created_at) VALUES (?,\'[]\',\'refused\',?)').run(A,NOW);
 t.user('link_session',{session:A,project:p});const j=job();expect(reviewDigestDependency(t.db,j)).toBeNull();
 await runProjectReview(t.db,t.deps,async call=>{expect(call.prompt).toContain('可用的历史摘要');expect(call.prompt).not.toContain('被拒的原文');expect(call.prompt).toContain('信息缺口');return ok();},j,'m');
 expect(t.db.prepare('SELECT status FROM project_reviews WHERE id=?').get(j.id)).toEqual({status:'done_with_gaps'});
});

test('user edits during a call invalidate further writes; locked fields still require confirmation',async()=>{
 session();const p=project();t.user('update_project',{project:p,fields:{summary:'用户确定的简介'}});digest();
 t.user('link_session',{session:A,project:p});const j=job();
 await runProjectReview(t.db,t.deps,async call=>{
  expect((await write(call,'update_project',{project:p,fields:{summary:'AI改写'},reason:'r',evidence:[`event:${j.event_id}`]})).status).toBe('proposed');
  t.user('unlink_session',{session:A,project:p});
  const tool=call.tools!.find(x=>x.name==='upsert_todo')!;
  expect((await tool.handler({project:p,title:'不能写入',reason:'r',evidence:[`event:${j.event_id}`]})).isError).toBe(true);
  return ok();
 },j,'m');
 expect(t.db.prepare('SELECT summary FROM projects WHERE id=?').get(p)).toEqual({summary:'用户确定的简介'});
 expect(t.db.prepare('SELECT count(*) n FROM todos').get()).toEqual({n:0});
 expect(t.db.prepare('SELECT status FROM project_reviews WHERE id=?').get(j.id)).toEqual({status:'cancelled'});
});

test('scheduler digests pending session content first, then invokes project-wide curator without manual sync',async()=>{
 session();const p=project();
 const text='需要完整整理的新内容'.repeat(80);
 t.db.prepare(`INSERT INTO chunks(session_key,kind,offset_start,offset_end,ts_start,ts_end,text,backfill,digested,received_at) VALUES (?,'transcript',0,1,?,?,?,1,0,?)`).run(A,NOW,NOW,text,NOW);
 t.user('link_session',{session:A,project:p});let n=0;
 const runner: LlmRunner = async (call) => {
   n++;
   if (call.role !== 'digest') return ok();
   return {
     ...ok(), ok: true,
     structured: {
       topics: [], decisions: [], progress: [{ text: '准备完毕', turns: [] }],
       session_state: { goal: 'goal', state: 'active', waiting_on: null, next: null, note: null },
       todos_added: [], todos_done: [], blockers: [], open_questions: [], trivial: false,
     },
   };
 };
 const s=new Scheduler(t.db,t.deps,runner,{digest:'m',curate:'m'});
 expect(await s.tick()).toBe('digested');expect(await s.tick()).toBe('curated');expect(n).toBe(2);
 expect(s.status().pending_project_reviews).toBe(0);
});

test('queue insertion and user association share the same transaction',()=>{
 session();const p=project();const before=(t.db.prepare('SELECT count(*) n FROM events').get() as {n:number}).n;
 t.db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON project_reviews BEGIN SELECT RAISE(ABORT,'test queue failure'); END");
 expect(()=>t.user('link_session',{session:A,project:p})).toThrow('test queue failure');
 expect(t.db.prepare('SELECT count(*) n FROM contributions').get()).toEqual({n:0});
 expect(t.db.prepare('SELECT count(*) n FROM events').get()).toEqual({n:before});
});

test('partial curator writes fail visibly and are not automatically replayed',async()=>{
 session();const p=project();digest();t.user('link_session',{session:A,project:p});let calls=0;
 const runner:LlmRunner=async call=>{
  calls++;const j=job();
  await write(call,'upsert_todo',{project:p,title:'只写一次',reason:'r',evidence:[`event:${j.event_id}`]});
  return {ok:false,kind:'other',message:'stream lost',durationMs:1};
 };
 const s=new Scheduler(t.db,t.deps,runner,{digest:'m',curate:'m'});
 expect(await s.tick()).toBe('skipped');expect(s.status().failed_project_reviews).toBe(1);
 expect(await s.tick()).toBe('idle');expect(calls).toBe(1);
 expect(t.db.prepare('SELECT title FROM todos').all()).toEqual([{title:'只写一次'}]);
 const restarted=new Scheduler(t.db,t.deps,runner,{digest:'m',curate:'m'});
 expect(await restarted.tick()).toBe('idle');expect(restarted.status().last_error).toContain('stream lost');
});

test('a failed review backs off durably while another project can still be reorganized',async()=>{
 session();session(B);const p=project(),q=project('另一个');digest();digest(B);
 t.user('link_session',{session:A,project:p});t.user('link_session',{session:B,project:q});let calls=0;
 const runner:LlmRunner=async()=>++calls===1?{ok:false,kind:'other',message:'transient',durationMs:1}:ok();
 const s=new Scheduler(t.db,t.deps,runner,{digest:'m',curate:'m'});
 expect(await s.tick()).toBe('skipped');expect(await s.tick()).toBe('curated');
 expect(await s.tick()).toBe('idle');expect(calls).toBe(2);
 t.setNow(new Date(Date.parse(NOW)+61000).toISOString());
 expect(await s.tick()).toBe('curated');expect(calls).toBe(3);expect(s.status().pending_project_reviews).toBe(0);
});


test('the authenticated HTTP association wakes the project curator immediately',async()=>{
 session();const p=project();digest();let calls=0;
 const s=new Scheduler(t.db,t.deps,async()=>{calls++;return ok();},{digest:'m',curate:'m'});
 const cfg={port:1,dbPath:':memory:',userToken:'test-admin-key-123456',mcpToken:'test-mcp-key-123456',collectors:{}};
 const app=createApp(t.db,cfg,t.deps.now,t.deps.newId,{scheduler:s});
 const response=await app.request('http://localhost/sessions/'+encodeURIComponent(A)+'/links',{method:'POST',headers:{Authorization:'Bearer '+cfg.userToken,'Content-Type':'application/json'},body:JSON.stringify({project_id:p})});
 expect(response.status).toBe(200);expect((await response.json()).project_review_queued).toBe(true);
 await vi.waitFor(()=>expect(t.db.prepare("SELECT status FROM project_reviews WHERE project_id=?").get(p)).toEqual({status:'done'}));
 expect(calls).toBe(1);await s.stop();
});
