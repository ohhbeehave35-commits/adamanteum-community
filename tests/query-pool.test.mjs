import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {QueryPool} from '../query-pool.mjs';
test('isolated query workers preserve directed edges, sources and bounded search',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'adamanteum-query-test-')),file=path.join(directory,'test.sqlite');
 const db=new DatabaseSync(file);db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY,path TEXT,title TEXT,folder TEXT,category TEXT,degree INTEGER,mtime REAL,bytes INTEGER,body TEXT);
 CREATE VIRTUAL TABLE search USING fts5(title,body,content='docs',content_rowid='id');
 CREATE TABLE edges(source INTEGER,target INTEGER);
 INSERT INTO docs VALUES(1,'a.md','Alpha','Home','records',1,0,5,'Alpha'),(2,'b.md','Beta','Home','records',1,0,4,'Beta');
 INSERT INTO search(rowid,title,body) SELECT id,title,body FROM docs;
 INSERT INTO edges VALUES(1,2);`);db.close();
 const pool=new QueryPool(file);
 try{
  const [search,graph,doc]=await Promise.all([pool.run('search',{q:'Alpha'}),pool.run('graph',{limit:900}),pool.run('doc',{id:1})]);
  assert.equal(search.result[0].id,1);assert.deepEqual(graph.result.edges,[{source:1,target:2}]);assert.equal(doc.result.body,'Alpha');assert.equal(doc.result.connections[0].outgoing,1);
  assert.ok(search.queryMs>=0);
 }finally{await pool.close();if(path.dirname(directory)!==os.tmpdir()||!path.basename(directory).startsWith('adamanteum-query-test-'))throw Error('Unexpected temporary path');await rm(directory,{recursive:true});}
});
test('FIVE1: the first worker never takes a slow job, so a search is not queued behind the whole map',()=>{
 const sent=[],fake=n=>({worker:{postMessage:m=>sent.push([n,m.kind])},job:null});
 const pool=Object.create(QueryPool.prototype);
 pool.queue=[];pool.sequence=0;pool.slots=[fake(0),fake(1)];
 const job=kind=>({id:++pool.sequence,kind,input:{},resolve(){},reject(){}});
 pool.queue.push(job('graphfull'),job('graphtitles'),job('search'));
 pool.drain();
 assert.deepEqual(sent,[[0,'search'],[1,'graphfull']]);
 assert.deepEqual(pool.queue.map(j=>j.kind),['graphtitles']);
 for(const s of pool.slots)clearTimeout(s.job.timer);
});
