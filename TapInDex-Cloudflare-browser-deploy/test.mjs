import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {cloud,cleanupRecovery} from './cloud.mjs';
import {createHash,randomBytes} from 'node:crypto';
import worker,{dispatch,authenticate,cleanup} from './worker.mjs';
function fixture() {
  const sqlite=new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('./migrations/0001.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0002.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){return {bind(...args){return {async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};}};},
    async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}},withSession(){return this;}};
  const objects=new Map();const FILES={async put(k,v){objects.set(k,v);},async get(k){const v=objects.get(k);return v===undefined?null:{async json(){return JSON.parse(v);}};},async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])objects.delete(k);}};
  const env={DB,FILES,SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public-fixture',BACKUP_KEY_ID:'v1',BACKUP_KEYS_JSON:JSON.stringify({v1:randomBytes(32).toString('base64')})};
  const a={id:crypto.randomUUID(),name:'Owner'},b={id:crypto.randomUUID(),name:'Viewer'},c={id:crypto.randomUUID(),name:'Other'};
  return {env,a,b,c,sqlite,objects,call:(u,op,p={})=>dispatch(env,u,op,p)};
}
const row=i=>({ordinal:i,printing_id:'printing-'+i,name:'Card '+i,set_code:'TST',collector_number:''+i,language:'en',artist:'Artist',finish:'Normal',condition:'NM',quantity:2,available:1,private_notes:'NEVER SHARE'});
async function upload(f,count=501){const id=await f.call(f.a,'begin',{p_kind:'collection',p_count:count});for(let i=0;i<count;i+=250)await f.call(f.a,'stage',{p_snapshot:id,p_rows:Array.from({length:Math.min(250,count-i)},(_,j)=>row(i+j))});return id;}
async function approve(f){await f.call(f.a,'list');await f.call(f.b,'request',{p_owner:f.a.id,p_name:'forged'});await f.call(f.a,'grant',{p_viewer:f.b.id,p_collection:true,p_wishlist:false,p_trades:true});}
const page=(f,u=f.b,extra={})=>f.call(u,'page',{p_owner:f.a.id,p_kind:'collection',p_after:-1,p_query:'',...extra});
test('owner approval, immutable upload retry, private fields, exact pagination and revocation',async()=>{
 const f=fixture();await f.call(f.a,'list');await f.call(f.b,'request',{p_owner:f.a.id});
 const id=await upload(f);await assert.rejects(page(f),e=>e.status===403);
 await f.call(f.a,'publish',{p_snapshot:id});await approve(f);
 assert.equal((await f.call(f.a,'list'))[0].viewer_name,'Viewer');
 const p=await page(f);assert.equal(p.rows.length,80);assert.equal(p.next_after,79);assert.equal(p.has_more,true);assert.equal('private_notes' in p.rows[0],false);
 let all=p.rows,cursor=p.next_after,more=p.has_more;while(more){const q=await page(f,f.b,{p_snapshot:id,p_after:cursor});all.push(...q.rows);cursor=q.next_after;more=q.has_more;}
 assert.equal(all.length,501);assert.equal(new Set(all.map(r=>r.ordinal)).size,501);
 await assert.rejects(page(f,f.c),e=>e.status===403);
 await assert.rejects(page(f,f.b,{p_kind:'wishlist'}),e=>e.status===403);
 await f.call(f.a,'revoke',{p_other:f.b.id,p_as_owner:true});await assert.rejects(page(f),e=>e.status===403);
 await f.call(f.b,'request',{p_owner:f.a.id});assert.equal((await f.call(f.b,'list'))[0].approved,false);
});
test('incomplete uploads cannot replace a visible snapshot; old uploads cannot roll back or resurrect it',async()=>{
 const f=fixture();await approve(f);const old=await upload(f,1);await f.call(f.a,'publish',{p_snapshot:old});
 const incomplete=await f.call(f.a,'begin',{p_kind:'collection',p_count:251});await f.call(f.a,'stage',{p_snapshot:incomplete,p_rows:Array.from({length:250},(_,i)=>row(i))});
 await assert.rejects(f.call(f.a,'publish',{p_snapshot:incomplete}),e=>e.status===409);assert.equal((await page(f)).snapshot_id,old);
 const fresh=await upload(f,1);await f.call(f.a,'publish',{p_snapshot:fresh});await f.call(f.a,'publish',{p_snapshot:fresh});
 await assert.rejects(f.call(f.a,'publish',{p_snapshot:old}),e=>e.status===409);
 await assert.rejects(page(f,f.b,{p_snapshot:old}),e=>e.status===409);
 await f.call(f.a,'unpublish',{p_kind:'collection'});await assert.rejects(f.call(f.a,'publish',{p_snapshot:fresh}),e=>e.status===409);await assert.rejects(page(f),e=>e.message==='HDX_NOT_PUBLISHED');
});
test('empty snapshots, chunk integrity, identity isolation and malformed fields',async()=>{
 const f=fixture();await approve(f);const empty=await upload(f,0);await f.call(f.a,'publish',{p_snapshot:empty});assert.deepEqual((await page(f)).rows,[]);
 const id=await f.call(f.a,'begin',{p_kind:'collection',p_count:1});const p={p_snapshot:id,p_rows:[row(0)]};await f.call(f.a,'stage',p);await f.call(f.a,'stage',p);
 await assert.rejects(f.call(f.a,'stage',{...p,p_rows:[{...row(0),quantity:3}]}),e=>e.status===409);
 await assert.rejects(f.call(f.b,'publish',{p_snapshot:id}),e=>e.status===404);
 await assert.rejects(f.call(f.a,'grant',{p_viewer:f.b.id,p_collection:'true',p_wishlist:false,p_trades:true}),e=>e.status===400);
 await assert.rejects(f.call(f.a,'begin',{p_kind:'collection',p_count:true}),e=>e.status===400);
 await assert.rejects(f.call(f.b,'grant',{p_viewer:f.c.id,p_collection:true,p_wishlist:false,p_trades:true}),e=>e.status===404);
});
test('bounded search advances through empty pages and finds late matches',async()=>{
 const f=fixture();await approve(f);const id=await upload(f,1251);await f.call(f.a,'publish',{p_snapshot:id});
 const p=await page(f,f.b,{p_query:'Card 1250'});assert.equal(p.rows.length,0);assert.equal(p.next_after,999);assert.equal(p.has_more,true);
 const q=await page(f,f.b,{p_query:'Card 1250',p_after:p.next_after,p_snapshot:id});assert.equal(q.rows[0].ordinal,1250);assert.equal(q.has_more,false);
});
test('permission rechecked after file download, upload failure retry and discarded cleanup',async()=>{
 const f=fixture();await approve(f);const id=await f.call(f.a,'begin',{p_kind:'collection',p_count:1});const put=f.env.FILES.put;
 f.env.FILES.put=async()=>{throw Error('failure');};await assert.rejects(f.call(f.a,'stage',{p_snapshot:id,p_rows:[row(0)]}));await assert.rejects(f.call(f.a,'publish',{p_snapshot:id}));
 f.env.FILES.put=put;await f.call(f.a,'stage',{p_snapshot:id,p_rows:[row(0)]});await f.call(f.a,'publish',{p_snapshot:id});
 const get=f.env.FILES.get;f.env.FILES.get=async k=>{await f.call(f.a,'revoke',{p_other:f.b.id,p_as_owner:true});return get(k);};await assert.rejects(page(f),e=>e.status===403);
 const abandoned=await upload(f,1);await f.call(f.a,'discard',{p_snapshot:abandoned});await cleanup(f.env);assert.equal(f.sqlite.prepare('SELECT id FROM snapshots WHERE id=?').get(abandoned),undefined);assert.equal([...f.objects.keys()].some(k=>k.includes(abandoned)),false);
});
test('rate and staging quotas; identity verifier never trusts body or unverified JWT claims',async()=>{
 const f=fixture();for(let i=0;i<4;i++)await f.call(f.a,'begin',{p_kind:'collection',p_count:1});await assert.rejects(f.call(f.a,'begin',{p_kind:'collection',p_count:1}),e=>e.status===429);
 await f.call(f.b,'list');for(let i=0;i<20;i++)await f.call(f.a,'request',{p_owner:f.b.id});await assert.rejects(f.call(f.a,'request',{p_owner:f.b.id}),e=>e.status===429);
 const req=new Request('https://sharing.test/v1/sharing/list',{method:'POST',headers:{authorization:'Bearer fixture-token-12345'}});
 const verified=await authenticate(req,f.env,async(url,opts)=>{assert.equal(url,'https://fixture.supabase.co/auth/v1/user');assert.equal(opts.redirect,'manual');return Response.json({id:f.a.id,email_confirmed_at:'today',user_metadata:{display_name:'Verified'}});});assert.equal(verified.id,f.a.id);
 await assert.rejects(authenticate(req,f.env,async()=>new Response('',{status:401})),e=>e.status===401);
 await assert.rejects(authenticate(req,f.env,async()=>{throw Error('offline');}),e=>e.status===503);
 const huge=new Request(req.url,{method:'POST',body:'x'.repeat(512*1024+1)});assert.equal((await worker.fetch(huge,f.env)).status,413);
 assert.equal((await worker.fetch(new Request('https://sharing.test/v1/sharing/unknown',{method:'POST'}),f.env)).status,404);
});
test('concurrent retries reserve one chunk; storage quota and cleanup protect current snapshots',async()=>{
 const f=fixture();await approve(f);const id=await f.call(f.a,'begin',{p_kind:'collection',p_count:1});
 const payload={p_snapshot:id,p_rows:[row(0)]};await Promise.all([f.call(f.a,'stage',payload),f.call(f.a,'stage',payload)]);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM chunks WHERE snapshot=?').get(id).n,1);
 await f.call(f.a,'publish',{p_snapshot:id});f.sqlite.prepare('UPDATE snapshots SET created=0 WHERE id=?').run(id);await cleanup(f.env);assert.equal((await page(f)).snapshot_id,id);
 const pending=await f.call(f.a,'begin',{p_kind:'collection',p_count:1});f.sqlite.prepare('UPDATE chunks SET bytes=? WHERE snapshot=?').run(50*1024*1024,id);
 await assert.rejects(f.call(f.a,'stage',{p_snapshot:pending,p_rows:[row(0)]}),e=>e.status===413);
 const f2=fixture();const results=await Promise.allSettled(Array.from({length:8},()=>f2.call(f2.a,'begin',{p_kind:'collection',p_count:1})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,4);
});

const hash=b=>createHash('sha256').update(b).digest('hex');
async function cloudFixture(){const f=fixture();await f.call(f.a,'list');await f.call(f.b,'list');f.device=crypto.randomUUID();f.cc=(op,p={},user=f.a)=>cloud(f.env,user,op,{device:f.device,...p});await f.cc('claim',{take_over:false});return f;}
async function recovery(f,bytes=Buffer.from('private inventory purchase records'),commit=true){
 const {id}=await f.cc('begin',{size:bytes.length,sha256:hash(bytes)});
 for(let i=0;i<bytes.length;i+=256*1024)await f.cc('stage',{id,part:i/(256*1024),data:bytes.subarray(i,i+256*1024).toString('base64')});
 if(commit)await f.cc('commit',{id});return id;
}
test('recovery encrypts multiple packets, verifies exact round trip and denies friends',async()=>{
 const f=await cloudFixture(),bytes=randomBytes(600000),id=await recovery(f,bytes);
 assert.equal((await f.cc('status')).backup.id,id);
 const restored=[];for(let i=0;i<3;i++)restored.push(Buffer.from((await f.cc('chunk',{id,part:i})).data,'base64'));
 assert.deepEqual(Buffer.concat(restored),bytes);
 assert.equal([...f.objects.values()].some(v=>v.includes(bytes.subarray(0,80).toString('base64'))),false);
 await approve(f);await assert.rejects(f.cc('chunk',{id,part:0},f.b),e=>e.status===404);
 const key=[...f.objects.keys()][0],obj=JSON.parse(f.objects.get(key));obj.data=obj.data.slice(0,20)+'AAAA'+obj.data.slice(24);f.objects.set(key,JSON.stringify(obj));
 await assert.rejects(f.cc('chunk',{id,part:0}),e=>e.status===503);
});
test('primary phone takeover fences old uploads while allowing owner recovery',async()=>{
 const f=await cloudFixture(),id=await recovery(f),pending=await recovery(f,Buffer.from('pending'),false),other=crypto.randomUUID();
 await assert.rejects(f.cc('claim',{device:other,take_over:false}),e=>e.status===409);
 await f.cc('claim',{device:other,take_over:true});
 await assert.rejects(f.cc('commit',{id:pending}),e=>e.status===409);
 await assert.rejects(f.cc('begin',{size:1,sha256:hash('x')}),e=>e.status===409);
 await assert.rejects(f.call(f.a,'begin',{p_device:f.device,p_kind:'collection',p_count:1}),e=>e.status===409);
 assert.equal(Buffer.from((await f.cc('chunk',{id,part:0})).data,'base64').toString(),'private inventory purchase records');
});
test('incomplete and corrupt recovery never replace the last good backup; retries are immutable',async()=>{
 const f=await cloudFixture(),old=await recovery(f),bytes=Buffer.from('next');
 const {id}=await f.cc('begin',{size:bytes.length,sha256:hash(bytes)});
 await assert.rejects(f.cc('commit',{id}),e=>e.status===409);
 const p={id,part:0,data:bytes.toString('base64')};await f.cc('stage',p);await f.cc('stage',p);
 await assert.rejects(f.cc('stage',{...p,data:Buffer.from('oops').toString('base64')}),e=>e.status===409);
 await f.cc('commit',{id});await f.cc('commit',{id});await assert.rejects(f.cc('commit',{id:old}),e=>e.status===409);
 const bad=await f.cc('begin',{size:4,sha256:hash('fake')});await f.cc('stage',{id:bad.id,part:0,data:bytes.toString('base64')});
 await assert.rejects(f.cc('commit',{id:bad.id}),e=>e.status===400);assert.equal((await f.cc('status')).backup.id,id);
});
test('backup rotation retains decryption keys; cleanup preserves newest three and current head',async()=>{
 const f=await cloudFixture(),ids=[];for(let i=0;i<4;i++)ids.push(await recovery(f,Buffer.from('backup '+i)));
 f.sqlite.exec('UPDATE recovery SET created=0');await cleanupRecovery(f.env);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM recovery').get().n,3);
 assert.equal((await f.cc('status')).backup.id,ids[3]);
 const keys=JSON.parse(f.env.BACKUP_KEYS_JSON);keys.v2=randomBytes(32).toString('base64');f.env.BACKUP_KEYS_JSON=JSON.stringify(keys);f.env.BACKUP_KEY_ID='v2';
 assert.equal(Buffer.from((await f.cc('chunk',{id:ids[3],part:0})).data,'base64').toString(),'backup 3');
 const latest=await recovery(f);assert.equal((await f.cc('status')).backup.id,latest);
 delete keys.v1;f.env.BACKUP_KEYS_JSON=JSON.stringify(keys);await assert.rejects(f.cc('chunk',{id:ids[3],part:0}),e=>e.status===503);
});
test('backup size bounds, quota, missing encryption setup and abandoned cleanup',async()=>{
 const f=await cloudFixture();await assert.rejects(f.cc('begin',{size:10485761,sha256:hash('x')}),e=>e.status===400);
 const id=await recovery(f,Buffer.from('pending'),false);await assert.rejects(f.cc('stage',{id,part:0,data:'eA=='}),e=>e.status===400);
 await recovery(f,Buffer.from('pending2'),false);await assert.rejects(f.cc('begin',{size:1,sha256:hash('x')}),e=>e.status===429);
 f.sqlite.exec('UPDATE recovery SET created=0');await cleanupRecovery(f.env);assert.equal(f.objects.size,0);
 f.env.BACKUP_KEYS_JSON='{}';await assert.rejects(f.cc('begin',{size:1,sha256:hash('x')}),e=>e.status===503);
});
test('takeover during a final publication cannot move either pointer',async()=>{
 const f=await cloudFixture(),old=await recovery(f),pending=await recovery(f,Buffer.from('pending'),false);
 const batch=f.env.DB.batch.bind(f.env.DB),other=crypto.randomUUID();
 f.env.DB.batch=async statements=>{f.sqlite.prepare('UPDATE primary_devices SET device=? WHERE owner=?').run(other,f.a.id);return batch(statements);};
 await assert.rejects(f.cc('commit',{id:pending}),e=>e.status===409);assert.equal((await f.cc('status')).backup.id,old);
 f.env.DB.batch=batch;await f.cc('claim',{take_over:true});
 const snapshot=await upload(f,1);
 f.env.DB.batch=async statements=>{f.sqlite.prepare('UPDATE primary_devices SET device=? WHERE owner=?').run(other,f.a.id);return batch(statements);};
 await assert.rejects(f.call(f.a,'publish',{p_snapshot:snapshot,p_device:f.device}),e=>e.status===409);
 assert.equal(f.sqlite.prepare('SELECT snapshot FROM feeds WHERE owner=?').get(f.a.id).snapshot,null);
});
test('HTTP cloud routes verify account bearer and return structured authorization failures',async()=>{
 const f=fixture(),original=globalThis.fetch;globalThis.fetch=async()=>Response.json({id:f.a.id,email_confirmed_at:'today',user_metadata:{display_name:'Owner'}});
 try {
 const request=(op,p)=>new Request('https://sharing.test/v1/cloud/'+op,{method:'POST',headers:{authorization:'Bearer fixture-token-12345','content-type':'application/json'},body:JSON.stringify(p)});
 const status=await worker.fetch(request('status',{}),f.env);assert.equal(status.status,200);assert.equal((await status.json()).backup,null);
 const claim=await worker.fetch(request('claim',{device:crypto.randomUUID(),take_over:false}),f.env);assert.equal(claim.status,200);
 const conflict=await worker.fetch(request('claim',{device:crypto.randomUUID(),take_over:false}),f.env);assert.equal(conflict.status,409);assert.equal((await conflict.json()).message,'PRIMARY_DEVICE_REQUIRED');
 const unauthorized=await worker.fetch(new Request('https://sharing.test/v1/cloud/status',{method:'POST',body:'{}'}),f.env);assert.equal(unauthorized.status,401);
 }finally{globalThis.fetch=original;}
});
