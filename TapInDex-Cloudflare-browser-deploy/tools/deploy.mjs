import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Kept pure at the boundary so provisioning order and failure paths can be tested without credentials.
export function deploy({read=()=>JSON.parse(readFileSync('wrangler.jsonc','utf8')),
 write=config=>writeFileSync('wrangler.jsonc',JSON.stringify(config,null,2)+'\n'),run=command}={}) {
 let config=read();
 if(config.name!=='tapindex-sharing') throw Error('Keep the Worker name tapindex-sharing, or review the deployment helper before renaming.');
 const db=config.d1_databases?.find(b=>b.binding==='DB');
 if(!db?.database_name || !config.r2_buckets?.some(b=>b.binding==='FILES'&&b.bucket_name)) throw Error('DB and FILES bindings need their configured names.');
 const valid=id=>typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id);
 const resolveId=()=>{
  const list=JSON.parse(run(['d1','list','--json'],true));
  if(!Array.isArray(list)) throw Error('Unexpected database listing. Setup stopped before migrations.');
  const matches=list.filter(d=>d.name===db.database_name);
  if(matches.length>1) throw Error('Ambiguous database name. Set database_id explicitly.');
  if(matches.length===1) {
   if(!valid(matches[0].uuid)) throw Error('Cloudflare did not return a valid database ID.');
   db.database_id=matches[0].uuid;write(config);return true;
  }
  return false;
 };
 if(!valid(db.database_id) && !resolveId()) {
  // A new Worker serves maintenance only until its database is ready. Never expose half-initialized app routes.
  run(['deploy','bootstrap.mjs']);
  const provisioned=read().d1_databases?.find(b=>b.binding==='DB');
  if(valid(provisioned?.database_id)){db.database_id=provisioned.database_id;write(config);}
  else if(!resolveId()) throw Error('Database provisioning is unfinished. Inspect DB in Cloudflare before retrying.');
 }
 // Migrations failing must stop deployment; existing databases keep their currently serving Worker.
 run(['d1','migrations','apply','DB','--remote']);
 run(['deploy']);
 return config;
}
function command(args,capture=false) {
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),...args],
  {encoding:'utf8',stdio:capture?['ignore','pipe','inherit']:'inherit',env:process.env});
 if(result.error) throw result.error;
 if(result.status!==0) throw Error('Cloudflare command failed; setup stopped. Read the Cloudflare build log above.');
 return result.stdout;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{deploy();}catch(e){console.error(e.message);process.exitCode=1;}
}
