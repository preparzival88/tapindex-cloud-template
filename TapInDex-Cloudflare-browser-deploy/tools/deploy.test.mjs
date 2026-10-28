import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deploy} from './deploy.mjs';
import bootstrap from '../bootstrap.mjs';
const id='5d2f0402-2d28-4c46-92c2-238a3e256c24';
function fixture(known=false){
 let config={name:'tapindex-sharing',d1_databases:[{binding:'DB',database_name:'tapindex-sharing',...(known?{database_id:id}:{})}],r2_buckets:[{binding:'FILES',bucket_name:'tapindex-private-sharing'}]},calls=[],saved=[];
 const f={calls,saved,get config(){return config;},read:()=>structuredClone(config),write:c=>{config=structuredClone(c);saved.push(config);},run:(a,capture)=>{calls.push(a);return capture?'[]':'';}};
 return f;
}
test('existing database migrates before app deployment and never publishes bootstrap',()=>{
 const f=fixture(true);deploy(f);assert.deepEqual(f.calls,[['d1','migrations','apply','DB','--remote'],['deploy']]);
});
test('a repeated browser build resolves the same named DB without bootstrap or data recreation',()=>{
 const f=fixture();f.run=(a,capture)=>{f.calls.push(a);return capture?JSON.stringify([{name:'tapindex-sharing',uuid:id}]):'';};
 deploy(f);assert.equal(f.config.d1_databases[0].database_id,id);assert.deepEqual(f.calls.map(a=>a.join(' ')),['d1 list --json','d1 migrations apply DB --remote','deploy']);
});
test('new resources bootstrap, resolve ID, migrate, then publish application',()=>{
 const f=fixture();let listed=0;f.run=(a,capture)=>{f.calls.push(a);return capture?JSON.stringify(++listed===1?[]:[{name:'tapindex-sharing',uuid:id}]):'';};
 deploy(f);assert.deepEqual(f.calls.map(a=>a.join(' ')),['d1 list --json','deploy bootstrap.mjs','d1 list --json','d1 migrations apply DB --remote','deploy']);
});
test('provisioned config ID is consumed without depending on a second listing',()=>{
 const f=fixture();f.run=(a,capture)=>{f.calls.push(a);if(a[0]==='deploy'&&a[1]==='bootstrap.mjs'){const c=f.read();c.d1_databases[0].database_id=id;f.write(c);}return capture?'[]':'';};
 deploy(f);assert.equal(f.config.d1_databases[0].database_id,id);assert.equal(f.calls.filter(a=>a[1]==='list').length,1);
});
test('failed migrations stop publication and do not silently wipe or recreate data',()=>{
 const f=fixture(true);f.run=a=>{f.calls.push(a);throw Error('migration failed');};assert.throws(()=>deploy(f),/migration failed/);assert.equal(f.calls.length,1);
});
test('lookup errors, malformed IDs and unfinished provisioning fail closed',()=>{
 for(const listing of ['{}','not-json',JSON.stringify([{name:'tapindex-sharing',uuid:'invalid'}]),JSON.stringify([{name:'tapindex-sharing',uuid:id},{name:'tapindex-sharing',uuid:id}])]){
  const f=fixture();f.run=(a,c)=>{f.calls.push(a);return c?listing:'';};assert.throws(()=>deploy(f));assert.equal(f.calls.some(a=>a[0]==='deploy'),false);
 }
 const f=fixture();assert.throws(()=>deploy(f),/provisioning is unfinished/);assert.equal(f.calls.some(a=>a[1]==='migrations'),false);
});
test('bootstrap has no usable account or data routes and template declares private secret prompts',async()=>{
 const response=bootstrap.fetch();assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
 const root=new URL('../',import.meta.url),pkg=JSON.parse(readFileSync(new URL('package.json',root),'utf8')),config=JSON.parse(readFileSync(new URL('wrangler.jsonc',root),'utf8'));
 assert.equal(pkg.scripts.deploy,'node tools/deploy.mjs');assert.equal(pkg.scripts.build,'npm test');
 assert.equal(config.d1_databases[0].database_id,undefined);assert.equal(config.triggers.crons.length,1);
 const example=readFileSync(new URL('.env.example',root),'utf8');
 for(const k of ['SUPABASE_PUBLISHABLE_KEY','BACKUP_KEYS_JSON','BACKUP_KEY_ID']){assert.ok(pkg.cloudflare.bindings[k].description);assert.ok(example.includes(k+'='));assert.equal(config.vars[k],undefined);}
});
test('offline launcher validates repository links and creates 256-bit keys without network or persistence',async()=>{
 const {runInNewContext}=await import('node:vm');
 const page=readFileSync(new URL('../START_HERE.html',import.meta.url),'utf8'),script=page.match(/<script>([\s\S]*?)<\/script>/)[1];
 const elements=new Map(),context={crypto,btoa,URL,Uint8Array,document:{getElementById(id){if(!elements.has(id))elements.set(id,{value:'',checked:false,addEventListener(event,fn){this[event]=fn;}});return elements.get(id);}}};
 runInNewContext(script,context);
 for(const value of ['https://evil.test/user/repo','http://github.com/user/repo','https://name:password@github.com/user/repo','https://github.com/user/repo?secret=test','https://github.com/user/repo/tree/main','https://gitlab.com/user/repo#key','https://github.com:8443/u/r','javascript:alert(1)'])assert.throws(()=>context.deploymentURL(value));
 assert.equal(new URL(context.deploymentURL('https://github.com/test-user/cloud-template.git')).searchParams.get('url'),'https://github.com/test-user/cloud-template');
 assert.equal(new URL(context.deploymentURL('https://gitlab.com/test/cloud/')).searchParams.get('url'),'https://gitlab.com/test/cloud');
 const keys=Array.from({length:20},()=>context.newKeyJSON());assert.equal(new Set(keys).size,20);for(const k of keys)assert.equal(Buffer.from(JSON.parse(k).v1,'base64').length,32);
 context.document.getElementById('keys');elements.get('generate').click();assert.equal(elements.get('keys').value,'');elements.get('new-service').checked=true;elements.get('generate').click();const original=elements.get('keys').value;elements.get('generate').click();assert.equal(elements.get('keys').value,original);
 assert.equal(/\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b/.test(script),false);
});
