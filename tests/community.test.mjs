import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('fresh community startup opens sample atlas; search and notebook work; private routes are absent',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'community-http-'));
 const port=4191,url='http://127.0.0.1:'+port;
 const env={...process.env,PORT:String(port),ADAMANTEUM_DATA_DIR:data,ADAMANTEUM_VAULT_WRITE:'0'};
 delete env.ADAMANTEUM_CAPTURE;delete env.ADAMANTEUM_VAULT;delete env.ADAMANTEUM_ACCEPTANCE;delete env.ADAMANTEUM_REUSE_INDEX;
 const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env,stdio:'ignore',windowsHide:true});
 let spawnError;child.on('error',e=>{spawnError=e;});
 try{
  let status;
  for(let i=0;i<100;i++){
   if(spawnError)throw spawnError;
   try{status=await fetch(url+'/api/status').then(r=>r.json());if(status.phase==='ready'&&status.documents===18)break;}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(status?.phase,'ready');assert.equal(status.documents,18);
  const html=await fetch(url).then(r=>r.text());assert.match(html,/data-theme="nebula"/);assert.match(html,/Community Edition/);
  const graph=await fetch(url+'/api/graphfull?scope=all&tags=&existing=1&attachments=1').then(r=>r.json());
  assert.equal(graph.n,20);assert.equal(graph.links,44);
  assert.deepEqual(graph.programs.map(p=>p.name),['Garden','Studio']);
  const hits=await fetch(url+'/api/search?q=compost&scope=all').then(r=>r.json());assert.ok(hits.some(n=>n.path==='Garden/Soil.md'));
  const saved=await fetch(url+'/api/notebook/save',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({title:'Community check',body:'A local notebook revision.'})}).then(r=>r.json());
  assert.ok(saved.id,saved.error);assert.equal(saved.revision,1);
  const privateRoutes=['/api/'+'anna'+'belle/status','/api/'+'anna'+'belle/tool','/'+'anna'+'belle/callback','/cc/handoff'];
  for(const route of privateRoutes)assert.equal((await fetch(url+route)).status,404,route);
  assert.equal((await fetch(url+'/api/notebook/save',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'})).status,403);
 }finally{
  const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;
  await fs.rm(data,{recursive:true,force:true,maxRetries:8,retryDelay:150});
 }
});
