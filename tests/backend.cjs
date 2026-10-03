const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {PGlite} = require('@electric-sql/pglite');

const hash = token => crypto.createHash('sha256').update(token).digest('hex');
async function createBackend(){
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql as 'select string_to_array(name,''/'')';
    create publication supabase_realtime;
  `);
  // Partir de los archivos existentes detecta incompatibilidades con la versión previa.
  for(const file of ['supabase.sql','supabase_owner.sql','supabase_v2.sql','supabase_nombres.sql','supabase_bloquear_borrado.sql']){
    await db.exec(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
  }
  const migration=fs.readFileSync(path.join(__dirname,'..','supabase_reparacion.sql'),'utf8');
  await db.exec(migration);
  let queue=Promise.resolve();
  const run=(operation)=>{
    const result=queue.then(operation);
    queue=result.catch(()=>{});
    return result;
  };
  const asOwner=(token,operation)=>run(async()=>{
    await db.exec('begin');
    try{
      await db.query("select set_config('request.headers',$1,true)",[JSON.stringify({'x-owner':token})]);
      await db.exec('set local role anon');
      const result=await operation(db);
      await db.exec('commit');return result;
    }catch(error){await db.exec('rollback');throw error}
  });
  const rpc=(name,args,token)=>asOwner(token,async db=>{
    const params=name==='save_centenario_player'?
      [args.source_team,args.source_pos,args.target_team,args.target_pos,args.player_name,args.player_photo,args.captain]:
      [args.bet_id,args.user_label,args.prediction,args.goals,args.scorer_name,args.yellow_name,args.chips];
    if(!['save_centenario_player','save_centenario_bet'].includes(name))throw new Error('Unexpected RPC');
    return (await db.query(`select * from public.${name}(${params.map((_,i)=>'$'+(i+1)).join(',')})`,params)).rows;
  });
  return {db,run,asOwner,rpc,migration,hash,failRpc:false,failStorage:false,emptyRpc:false,reads:0};
}
module.exports={createBackend,hash};
