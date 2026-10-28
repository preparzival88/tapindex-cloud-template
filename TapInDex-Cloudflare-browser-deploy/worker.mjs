import {cloud, CloudError, requirePrimary, cleanupRecovery, backupEncryptionConfigured} from './cloud.mjs';
// Private sharing service. Supabase is used ONLY to verify the account bearer.
const MAX_BODY = 512 * 1024, MAX_STORAGE = 50 * 1024 * 1024;
class Failure extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new Failure(status, message); };
// Closed, non-sensitive categories only. Never attach an upstream body, token, URL, or raw exception.
const identityFailure = (reason, status=503, message='Identity service unavailable', detail={}) => {
  const error=new Failure(status,message); error.identityDiagnostic={reason,...detail}; throw error;
};
const identityFetchFailure = error => {
  const error_type=['AbortError','TimeoutError','TypeError','RangeError'].includes(error?.name)?error.name:'Error';
  identityFailure(error_type==='AbortError'||error_type==='TimeoutError'?'FETCH_TIMEOUT':'FETCH_ERROR',503,'Identity service unavailable',{error_type});
};
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : fail(400, 'Invalid account or snapshot ID');
const kind = value => ['collection','wishlist'].includes(value) ? value : fail(400, 'Invalid snapshot kind');
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(400, 'Invalid count');
const bool = v => typeof v === 'boolean' ? Number(v) : fail(400, 'Invalid permission');
const text = (v, max) => typeof v === 'string' && v.length <= max ? v : fail(400, 'Invalid text');
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const first = (env, sql, ...args) => stmt(env, sql, ...args).first();
const rows = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results;
const run = (env, sql, ...args) => stmt(env, sql, ...args).run();
const response = (value, status=200) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json', 'cache-control':'no-store','x-content-type-options':'nosniff'}});
const key = (owner, snapshot, part) => `snapshots/${owner}/${snapshot}/${part}.json`;
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function body(request) {
  const reader=request.body?.getReader(); if (!reader) return {};
  const parts=[]; let size=0;
  while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>MAX_BODY) { await reader.cancel(); fail(413,'Request too large'); } parts.push(value); }
  const bytes=new Uint8Array(size); let offset=0; for(const p of parts) { bytes.set(p,offset); offset+=p.length; }
  let result; try {result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch {fail(400,'Invalid JSON');}
  if(!result || Array.isArray(result) || typeof result!=='object') fail(400,'Expected JSON object'); return result;
}
export async function authenticate(request, env, fetcher=fetch) {
  if(!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) identityFailure('CONFIG_MISSING',503,'Service configuration incomplete');
  let origin; try { origin=new URL(env.SUPABASE_URL); } catch { identityFailure('CONFIG_INVALID',503,'Service configuration invalid'); }
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) identityFailure('CONFIG_INVALID',503,'Service configuration invalid');
  const bearer=request.headers.get('authorization') || '';
  if(!/^Bearer [A-Za-z0-9._~-]{16,8192}$/.test(bearer)) fail(401,'Unauthorized');
  let result;
  try { result=await fetcher(`${origin.origin}/auth/v1/user`, {headers:{Authorization:bearer,apikey:env.SUPABASE_PUBLISHABLE_KEY},redirect:'manual',signal:AbortSignal.timeout(8000)}); }
  catch(error) { identityFetchFailure(error); }
  if(result.status>=300 && result.status<400) identityFailure('UPSTREAM_REDIRECT',503,'Identity service unavailable',{upstream_status:result.status});
  if(result.status===401 || result.status===403) identityFailure('UPSTREAM_REJECTED',401,'Unauthorized',{upstream_status:result.status});
  if(!result.ok) identityFailure('UPSTREAM_HTTP',503,'Identity service unavailable',{upstream_status:result.status});
  let user; try {user=await body(result);} catch(error) {
    if(error?.name==='AbortError'||error?.name==='TimeoutError') identityFetchFailure(error);
    identityFailure('UPSTREAM_BODY',503,'Identity service unavailable',{upstream_status:result.status});
  }
  if(user.is_anonymous || !user.email_confirmed_at) fail(403,'Confirm your account email first');
  return {id:uuid(user.id), name:typeof user.user_metadata?.display_name==='string' ? user.user_metadata.display_name.slice(0,80) : 'TapInDex friend'};
}
async function register(env, actor, op) {
  await run(env,'INSERT INTO profiles(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',actor.id,actor.name);
  const minute=Math.floor(Date.now()/60000);
  const limit=await first(env,'INSERT INTO limits VALUES(?,?,1) ON CONFLICT(actor,minute) DO UPDATE SET calls=calls+1 RETURNING calls',actor.id + (op==='request'?':requests':':all'),minute);
  if(limit.calls>(op==='request'?20:600)) fail(429,'HDX_RATE_LIMIT');
}
async function owned(env, actor, id) {
  const s=await first(env,'SELECT * FROM snapshots WHERE id=? AND owner=?',uuid(id),actor.id);
  if(!s) fail(404,'Snapshot unavailable'); return s;
}
async function allowed(env, actor, owner, resource) {
  if(owner===actor.id) return;
  const a=await first(env,'SELECT * FROM access WHERE owner=? AND viewer=?',owner,actor.id);
  if(!a?.approved || !a[resource]) fail(403,'Access not approved');
}
function cleanRow(r, ordinal) {
  if(!r || typeof r!=='object' || Array.isArray(r) || r.ordinal!==ordinal) fail(400,'Rows must be contiguous');
  const v={ordinal};
  for(const [field,max] of Object.entries({printing_id:120,name:220,set_code:24,collector_number:40,language:24,artist:220,finish:32,condition:32})) v[field]=text(r[field],max);
  if(!v.printing_id.trim() || !v.name.trim()) fail(400,'Printing identity required');
  v.quantity=integer(r.quantity,1,9999); v.available=integer(r.available,0,v.quantity); return v;
}
export async function dispatch(env, actor, op, p) {
  await register(env,actor,op);
  if (p.p_device != null) await requirePrimary(env,actor.id,p.p_device);
  if(op==='list') return (await rows(env,`SELECT a.*,o.name owner_name,v.name viewer_name FROM access a JOIN profiles o ON o.id=a.owner JOIN profiles v ON v.id=a.viewer WHERE a.owner=? OR a.viewer=? ORDER BY a.owner,a.viewer`,actor.id,actor.id)).map(a=>({owner_id:a.owner,viewer_id:a.viewer,owner_name:a.owner_name,viewer_name:a.viewer_name,approved:!!a.approved,view_collection:!!a.collection,view_wishlist:!!a.wishlist,trade_requests:!!a.trades}));
  if(op==='request') {
    const owner=uuid(p.p_owner); if(owner===actor.id) fail(400,'Choose another account');
    if(!await first(env,'SELECT id FROM profiles WHERE id=?',owner)) fail(404,'Friend has not connected sharing yet');
    if(await first(env,'SELECT 1 FROM access WHERE owner=? AND viewer=?',owner,actor.id)) return null;
    const inserted=await run(env,`INSERT INTO access(owner,viewer) SELECT ?,? WHERE (SELECT count(*) FROM access WHERE owner=? OR viewer=?)<500 AND (SELECT count(*) FROM access WHERE owner=? OR viewer=?)<500 ON CONFLICT(owner,viewer) DO NOTHING`,owner,actor.id,owner,owner,actor.id,actor.id);
    if(!inserted.meta.changes && !await first(env,'SELECT 1 FROM access WHERE owner=? AND viewer=?',owner,actor.id)) fail(429,'Connection limit reached'); return null;
  }
  if(op==='grant') {
    const viewer=uuid(p.p_viewer);
    const result=await run(env,'UPDATE access SET approved=1,collection=?,wishlist=?,trades=? WHERE owner=? AND viewer=?',bool(p.p_collection),bool(p.p_wishlist),bool(p.p_trades),actor.id,viewer);
    if(!result.meta.changes) fail(404,'Access request unavailable'); return null;
  }
  if(op==='revoke') {
    const other=uuid(p.p_other), asOwner=bool(p.p_as_owner);
    await run(env,'DELETE FROM access WHERE owner=? AND viewer=?',asOwner?actor.id:other,asOwner?other:actor.id); return null;
  }
  if(op==='begin') {
    const resource=kind(p.p_kind), count=integer(p.p_count,0,100000), id=crypto.randomUUID();
    await run(env,'INSERT INTO feeds(owner,kind) VALUES(?,?) ON CONFLICT(owner,kind) DO NOTHING',actor.id,resource);
    // Conditional insert makes the staging quota safe under concurrent requests.
    const result=await run(env,`INSERT INTO snapshots(id,owner,kind,epoch,count,created) SELECT ?,?,?,epoch,?,? FROM feeds WHERE owner=? AND kind=? AND (SELECT count(*) FROM snapshots WHERE owner=? AND status='staging')<4`,id,actor.id,resource,count,Date.now(),actor.id,resource,actor.id);
    if(!result.meta.changes) fail(429,'Too many unfinished uploads'); return id;
  }
  if(op==='stage') {
    const s=await owned(env,actor,p.p_snapshot);
    if(s.status!=='staging') fail(409,'Snapshot is sealed');
    if(!Array.isArray(p.p_rows) || !p.p_rows.length || p.p_rows.length>250) fail(400,'Invalid chunk');
    const start=integer(p.p_rows[0]?.ordinal,0,99999), part=start/250;
    if(!Number.isInteger(part) || start>=s.count || p.p_rows.length!==Math.min(250,s.count-start)) fail(400,'Invalid chunk range');
    const data=JSON.stringify(p.p_rows.map((r,i)=>cleanRow(r,start+i))), bytes=new TextEncoder().encode(data).length, digest=await hash(data);
    await run(env,`INSERT INTO chunks(snapshot,part,hash,bytes,count) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM snapshots WHERE id=? AND status='staging') AND COALESCE((SELECT sum(c.bytes) FROM chunks c JOIN snapshots s ON c.snapshot=s.id WHERE s.owner=?),0)+?<=? ON CONFLICT(snapshot,part) DO NOTHING`,s.id,part,digest,bytes,p.p_rows.length,s.id,actor.id,bytes,MAX_STORAGE);
    const c=await first(env,'SELECT * FROM chunks WHERE snapshot=? AND part=?',s.id,part);
    if(!c) fail(413,'HDX_UPLOAD_LIMIT'); if(c.hash!==digest) fail(409,'Chunk cannot be changed; restart upload');
    if(!c.ready) {
      await env.FILES.put(key(actor.id,s.id,part),data,{httpMetadata:{contentType:'application/json'}});
      const updated=await run(env,'UPDATE chunks SET ready=1 WHERE snapshot=? AND part=? AND hash=?',s.id,part,digest);
      if(!updated.meta.changes) { await env.FILES.delete(key(actor.id,s.id,part)); fail(409,'Upload expired'); }
    } return null;
  }
  if(op==='publish') {
    const s=await owned(env,actor,p.p_snapshot), published=new Date().toISOString();
    await env.DB.batch([
      stmt(env,`UPDATE snapshots SET status='sealed',published=? WHERE id=? AND status='staging' AND count=COALESCE((SELECT sum(count) FROM chunks WHERE snapshot=? AND ready=1),0) AND (SELECT count(*) FROM chunks WHERE snapshot=?)=((count+249)/250)`,published,s.id,s.id,s.id),
      stmt(env,`UPDATE feeds SET snapshot=?,sequence=? WHERE owner=? AND kind=? AND epoch=? AND sequence<=? AND EXISTS(SELECT 1 FROM snapshots WHERE id=? AND status='sealed') AND (? IS NULL OR EXISTS(SELECT 1 FROM primary_devices WHERE owner=? AND device=?))`,s.id,s.sequence,actor.id,s.kind,s.epoch,s.sequence,s.id,p.p_device??null,actor.id,p.p_device??null)
    ]);
    const feed=await first(env,'SELECT snapshot FROM feeds WHERE owner=? AND kind=?',actor.id,s.kind);
    if(feed?.snapshot!==s.id) fail(409,'HDX_SNAPSHOT_CHANGED'); return null;
  }
  if(op==='unpublish') {
    const resource=kind(p.p_kind);
    await run(env,`INSERT INTO feeds(owner,kind,epoch) VALUES(?,?,1) ON CONFLICT(owner,kind) DO UPDATE SET epoch=epoch+1,snapshot=NULL`,actor.id,resource); return null;
  }
  if(op==='discard') {
    const s=await owned(env,actor,p.p_snapshot);
    await run(env,"UPDATE snapshots SET status='discarded' WHERE id=? AND status='staging'",s.id); return null;
  }
  if(op==='page') {
    const owner=uuid(p.p_owner), resource=kind(p.p_kind), after=integer(p.p_after,-1,99999), query=text(p.p_query ?? '',120).toLowerCase();
    await allowed(env,actor,owner,resource);
    const s=await first(env,`SELECT s.* FROM feeds f JOIN snapshots s ON s.id=f.snapshot WHERE f.owner=? AND f.kind=? AND s.status='sealed'`,owner,resource);
    if(!s) fail(404,'HDX_NOT_PUBLISHED'); if(p.p_snapshot!=null && p.p_snapshot!==s.id) fail(409,'HDX_SNAPSHOT_CHANGED');
    const result=[]; let cursor=after;
    // Bounded work even for searches with no matches. Cursor advances past examined non-matches.
    const firstPart=Math.floor((after+1)/250), end=Math.min(firstPart+4,Math.ceil(s.count/250));
    outer: for(let part=firstPart;part<end;part++) {
      const object=await env.FILES.get(key(owner,s.id,part)); if(!object) fail(503,'Snapshot temporarily unavailable');
      const list=await object.json();
      for(const row of list) {
        if(row.ordinal<=after) continue;
        if(result.length===80) break outer;
        cursor=row.ordinal;
        if(!query || [row.name,row.set_code,row.collector_number,row.artist].some(v=>v.toLowerCase().includes(query))) result.push(row);
      }
    }
    // Do not release data following a revocation or a publication change during file reads.
    await allowed(env,actor,owner,resource);
    const current=await first(env,'SELECT snapshot FROM feeds WHERE owner=? AND kind=?',owner,resource);
    if(current?.snapshot!==s.id) fail(409,'HDX_SNAPSHOT_CHANGED');
    return {snapshot_id:s.id,published_at:s.published,total:s.count,rows:result,has_more:cursor<s.count-1,next_after:cursor};
  }
  fail(404,'Unknown operation');
}
export async function cleanup(env) {
  // Retire before deleting objects so a concurrent publish can never point at deleted data.
  await run(env,`UPDATE snapshots SET status='discarded' WHERE created<? AND status='staging'`,Date.now()-86400000);
  await run(env,`UPDATE snapshots SET status='discarded' WHERE created<? AND status='sealed' AND NOT EXISTS(SELECT 1 FROM feeds WHERE snapshot=snapshots.id)`,Date.now()-86400000);
  const old=await rows(env,"SELECT id,owner FROM snapshots WHERE status='discarded' LIMIT 10");
  for(const s of old) {
    const parts=await rows(env,'SELECT part FROM chunks WHERE snapshot=?',s.id);
    for(let i=0;i<parts.length;i+=100) await env.FILES.delete(parts.slice(i,i+100).map(p=>key(s.owner,s.id,p.part)));
    await run(env,'DELETE FROM snapshots WHERE id=? AND status=\'discarded\'',s.id);
  }
  await run(env,'DELETE FROM limits WHERE minute<?',Math.floor(Date.now()/60000)-60);
}
export async function readiness(env) {
  let tables = new Set();
  try { tables = new Set((await rows(env, "SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name)); } catch {}
  const base = ['profiles','access','feeds','snapshots','chunks','limits'].every(name => tables.has(name));
  const recovery = ['primary_devices','recovery','recovery_parts','recovery_head'].every(name => tables.has(name));
  const account = !!env.SUPABASE_PUBLISHABLE_KEY && (() => {
    try { const url = new URL(env.SUPABASE_URL); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
  })();
  const storage = typeof env.FILES?.get === 'function' && typeof env.FILES?.put === 'function';
  const encryption = await backupEncryptionConfigured(env);
  return {service:'TapInDex readiness',database_bound:typeof env.DB?.prepare==='function',account_configured:account,sharing_schema_ready:base,recovery_schema_ready:recovery,
    storage_bound:storage,backup_encryption_configured:encryption,sharing_ready:account && base && storage,
    backup_ready:account && base && recovery && storage && encryption};
}
export default {
  async fetch(request, env) {
    let phase = 'route';
    try {
      const url=new URL(request.url);
      if(request.method==='GET' && url.pathname==='/health/ready') { const ready=await readiness(env); return response(ready,ready.sharing_ready&&ready.backup_ready?200:503); }
      if(request.method==='GET' && url.pathname==='/health') return response({service:'TapInDex sharing',version:1,identity_diagnostics:2});
      if(request.method!=='POST' || !/^\/v1\/(sharing\/(list|request|grant|revoke|begin|stage|publish|discard|page|unpublish)|cloud\/(status|claim|begin|stage|commit|chunk|discard))$/.test(url.pathname)) fail(404,'Not found');
      const p=await body(request); phase='identity'; const actor=await authenticate(request,env); phase='storage';
      // Authorization reads start at the primary, never an eventually-consistent permission cache.
      const session={...env,DB:env.DB.withSession('first-primary')};
      const op=url.pathname.split('/').pop();
      if(url.pathname.startsWith('/v1/cloud/')) { await register(session,actor,'cloud'); return response(await cloud(session,actor,op,p)); }
      return response(await dispatch(session,actor,op,p));
    } catch(e) {
      const known=e instanceof Failure || e instanceof CloudError;
      const identity=known&&phase==='identity'?e.identityDiagnostic:undefined;
      const code=known ? (e.status===503 && phase==='identity' ? 'HDX_IDENTITY_UNAVAILABLE' : identity?'HDX_IDENTITY_REJECTED':undefined) : 'HDX_STORAGE_UNAVAILABLE';
      if(identity) console.error(JSON.stringify({event:'tapindex-request-failed',phase,code,...identity}));
      else if(!known) {
        const detail=String(e?.cause?.message || e?.message || '');
        const reason=/no such table/i.test(detail)?'SCHEMA_MISSING':/D1_/i.test(detail)?'D1_ERROR':/R2/i.test(detail)?'R2_ERROR':'STORAGE_ERROR';
        console.error(JSON.stringify({event:'tapindex-request-failed',phase,code,reason}));
      }
      return response({message:known?e.message:'Service temporarily unavailable',...(code?{code}:{}),...(identity||{})},known?e.status:503);
    }
  },
  async scheduled(event,env,ctx) { ctx.waitUntil(Promise.all([cleanup(env),cleanupRecovery(env)])); }
};
