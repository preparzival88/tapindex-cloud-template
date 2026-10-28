// Owner-only recovery files. Keys stay with the operator, never with friends or in the APK.
export class CloudError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail=(s,m)=>{throw new CloudError(s,m);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)?v.toLowerCase():fail(400,'Invalid ID');
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max?v:fail(400,'Invalid size');
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)?v:fail(400,'Invalid checksum');
const st=(e,q,...a)=>e.DB.prepare(q).bind(...a), one=(e,q,...a)=>st(e,q,...a).first(), run=(e,q,...a)=>st(e,q,...a).run();
const all=async(e,q,...a)=>(await st(e,q,...a).all()).results;
const CHUNK=256*1024, MAX=10*1024*1024;
const path=(s,i)=>`backups/${s.owner}/${s.id}/${i}.json`;
const b64=b=>{let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s);};
const decode=s=>{if(typeof s!=='string'||s.length>350000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail(400,'Invalid chunk encoding');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));};
const sha=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function encryptionKey(env,id) {
 let keys;try{keys=JSON.parse(env.BACKUP_KEYS_JSON||'{}');}catch{fail(503,'Backup encryption is not configured');}
 const encoded=keys[id];if(typeof encoded!=='string')fail(503,'Backup encryption key unavailable');
 const raw=decode(encoded);if(raw.length!==32)fail(503,'Backup encryption key invalid');
 return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
async function encrypt(env,s,i,bytes){const id=env.BACKUP_KEY_ID;if(!id)fail(503,'Backup encryption is not configured');const k=await encryptionKey(env,id),iv=crypto.getRandomValues(new Uint8Array(12));const aad=new TextEncoder().encode(`${s.owner}:${s.id}:${i}`);return JSON.stringify({key:id,iv:b64(iv),data:b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},k,bytes)))});}
async function decrypt(env,s,i){const obj=await env.FILES.get(path(s,i));if(!obj)fail(503,'Backup file unavailable');const j=await obj.json(),k=await encryptionKey(env,j.key);try{return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(j.iv),additionalData:new TextEncoder().encode(`${s.owner}:${s.id}:${i}`)},k,decode(j.data)));}catch{fail(503,'Backup verification failed');}}
export async function requirePrimary(env,owner,device) {const row=await one(env,'SELECT device FROM primary_devices WHERE owner=?',owner);if(row?.device!==uuid(device))fail(409,'PRIMARY_DEVICE_REQUIRED');}
async function owned(env,owner,id){const row=await one(env,'SELECT * FROM recovery WHERE owner=? AND id=?',owner,uuid(id));if(!row)fail(404,'Backup unavailable');return row;}
function info(s){return s?{id:s.id,size:s.size,sha256:s.hash,parts:Math.ceil(s.size/CHUNK),published_at:s.published}:null;}
export async function cloud(env,actor,op,p){
 const owner=actor.id;
 if(op==='status'){const device=await one(env,'SELECT device FROM primary_devices WHERE owner=?',owner);const backup=await one(env,'SELECT r.* FROM recovery_head h JOIN recovery r ON r.id=h.backup WHERE h.owner=? AND r.status=\'sealed\'',owner);return {primary_device:device?.device??null,backup:info(backup)};}
 if(op==='claim'){
  const device=uuid(p.device);if(typeof p.take_over!=='boolean')fail(400,'Explicit device choice required');
  if(p.take_over)await run(env,'INSERT INTO primary_devices VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET device=excluded.device,changed=excluded.changed',owner,device,Date.now());
  else await run(env,'INSERT INTO primary_devices VALUES(?,?,?) ON CONFLICT(owner) DO NOTHING',owner,device,Date.now());
  await requirePrimary(env,owner,device);return {ok:true};
 }
 if(op==='begin'){
  await requirePrimary(env,owner,p.device);await encryptionKey(env,env.BACKUP_KEY_ID);
  const size=integer(p.size,1,MAX),hash=digest(p.sha256),id=crypto.randomUUID();
  const result=await run(env,`INSERT INTO recovery(id,owner,device,size,hash,created) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM recovery WHERE owner=? AND status='staging')<2 AND (SELECT count(*) FROM recovery WHERE owner=?)<6`,id,owner,p.device,size,hash,Date.now(),owner,owner);
  if(!result.meta.changes)fail(429,'Backup slots are busy; retry after cleanup');return {id};
 }
 if(op==='stage'){
  await requirePrimary(env,owner,p.device);const s=await owned(env,owner,p.id);if(s.device!==p.device||s.status!=='staging')fail(409,'Backup upload is closed');
  const i=integer(p.part,0,Math.ceil(s.size/CHUNK)-1),bytes=decode(p.data);
  if(bytes.length!==Math.min(CHUNK,s.size-i*CHUNK))fail(400,'Incorrect chunk size');
  const hash=await sha(bytes);
  await run(env,'INSERT INTO recovery_parts(backup,part,hash,size) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM recovery WHERE id=? AND status=\'staging\') ON CONFLICT(backup,part) DO NOTHING',s.id,i,hash,bytes.length,s.id);
  const c=await one(env,'SELECT * FROM recovery_parts WHERE backup=? AND part=?',s.id,i);
  if(!c||c.hash!==hash)fail(409,'Backup chunk changed; restart upload');
  if(!c.ready){await env.FILES.put(path(s,i),await encrypt(env,s,i,bytes));const result=await run(env,'UPDATE recovery_parts SET ready=1 WHERE backup=? AND part=?',s.id,i);if(!result.meta.changes){await env.FILES.delete(path(s,i));fail(409,'Backup expired');}}
  return {ok:true};
 }
 if(op==='commit'){
  await requirePrimary(env,owner,p.device);const s=await owned(env,owner,p.id);if(s.device!==p.device||!['staging','sealed'].includes(s.status))fail(409,'Backup upload is closed');
  const parts=await all(env,'SELECT * FROM recovery_parts WHERE backup=? ORDER BY part',s.id);
  if(parts.length!==Math.ceil(s.size/CHUNK)||parts.some((c,i)=>!c.ready||c.part!==i))fail(409,'Backup upload incomplete');
  const bytes=new Uint8Array(s.size);let offset=0;
  for(const c of parts){const part=await decrypt(env,s,c.part);if(await sha(part)!==c.hash||part.length!==c.size)fail(503,'Backup verification failed');bytes.set(part,offset);offset+=part.length;}
  if(offset!==s.size||await sha(bytes)!==s.hash)fail(400,'Backup checksum mismatch');
  await env.DB.batch([
   st(env,`UPDATE recovery SET status='sealed',published=COALESCE(published,?) WHERE id=? AND status IN ('staging','sealed') AND EXISTS(SELECT 1 FROM primary_devices WHERE owner=? AND device=?)`,new Date().toISOString(),s.id,owner,p.device),
   st(env,`INSERT INTO recovery_head(owner,backup,sequence) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM recovery WHERE id=? AND status='sealed') AND EXISTS(SELECT 1 FROM primary_devices WHERE owner=? AND device=?) ON CONFLICT(owner) DO UPDATE SET backup=excluded.backup,sequence=excluded.sequence WHERE recovery_head.sequence<=excluded.sequence`,owner,s.id,s.sequence,s.id,owner,p.device)
  ]);
  await requirePrimary(env,owner,p.device);const head=await one(env,'SELECT backup FROM recovery_head WHERE owner=?',owner);if(head?.backup!==s.id)fail(409,'A newer backup is already saved');return {ok:true};
 }
 if(op==='chunk'){
  const s=await owned(env,owner,p.id);if(s.status!=='sealed')fail(404,'Backup unavailable');const i=integer(p.part,0,Math.ceil(s.size/CHUNK)-1);const bytes=await decrypt(env,s,i);const c=await one(env,'SELECT hash FROM recovery_parts WHERE backup=? AND part=?',s.id,i);if(!c||await sha(bytes)!==c.hash)fail(503,'Backup verification failed');return {data:b64(bytes)};
 }
 if(op==='discard'){const s=await owned(env,owner,p.id);await run(env,"UPDATE recovery SET status='discarded' WHERE id=? AND status='staging'",s.id);return {ok:true};}
 fail(404,'Unknown cloud operation');
}
export async function cleanupRecovery(env){
 await run(env,"UPDATE recovery SET status='discarded' WHERE status='staging' AND created<?",Date.now()-86400000);
 // Keep the newest three completed backups and all currently downloadable head data.
 await run(env,`UPDATE recovery SET status='discarded' WHERE status='sealed' AND id NOT IN (SELECT backup FROM recovery_head) AND created<? AND (SELECT count(*) FROM recovery newer WHERE newer.owner=recovery.owner AND newer.status='sealed' AND newer.sequence>recovery.sequence)>=3`,Date.now()-86400000);
 const old=await all(env,"SELECT * FROM recovery WHERE status='discarded' LIMIT 10");for(const s of old){await env.FILES.delete(Array.from({length:Math.ceil(s.size/CHUNK)},(_,i)=>path(s,i)));await run(env,"DELETE FROM recovery WHERE id=? AND status='discarded'",s.id);}
}
