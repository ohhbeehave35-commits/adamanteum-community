import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {reconcileVault} from '../vault-indexer.mjs';
import {queryVault} from '../queries.mjs';
import {BigAtlas} from '../dist/bigatlas.js';
import {Atlas} from '../dist/graph.js';
async function fixture(run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-switches-')),vault=path.join(root,'vault'),database=path.join(root,'index.sqlite');await fs.mkdir(vault);await fs.mkdir(path.join(vault,'media'));
 const db=new DatabaseSync(database);db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY,path TEXT UNIQUE,title TEXT,folder TEXT,category TEXT,mtime REAL,bytes INTEGER,body TEXT,degree INTEGER DEFAULT 0);CREATE TABLE edges(source INTEGER,target INTEGER,PRIMARY KEY(source,target));CREATE VIRTUAL TABLE search USING fts5(title,body,content='docs',content_rowid='id');CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
 const refresh=changedPaths=>reconcileVault({vault,database,changedPaths});
 try{await fs.writeFile(path.join(vault,'a.md'),'# Alpha\n![[image.png]] [[paper.pdf]] [[missing]] #shared');await fs.writeFile(path.join(vault,'b.md'),'# Beta\n[[missing]] #shared #second');await fs.writeFile(path.join(vault,'media/image.png'),Buffer.from([0,255,0,128]));await fs.writeFile(path.join(vault,'paper.pdf'),'%PDF-fixture');await fs.writeFile(path.join(vault,'unused.png'),'unused');await refresh();await run({vault,db,refresh});}
 finally{db.close();if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('atlas-switches-'))throw Error('Unexpected fixture path');await fs.rm(root,{recursive:true});}
}
test('attachments are indexed by reference and linked, with empty bodies and filename titles',()=>fixture(async({db})=>{
 const rows=db.prepare("SELECT path,title,body FROM docs WHERE path NOT LIKE '%.md' ORDER BY path").all().map(r=>({...r}));assert.deepEqual(rows,[{path:'media/image.png',title:'image.png',body:''},{path:'paper.pdf',title:'paper.pdf',body:''}]);assert.equal(db.prepare('SELECT count(*) n FROM edges').get().n,2);
}));
test('attachment refresh handles changed references, disappearing files and later arrival',()=>fixture(async({vault,db,refresh})=>{
 assert.equal(db.prepare("SELECT count(*) n FROM docs WHERE path='media/image.png'").get().n,1);
 await fs.writeFile(path.join(vault,'a.md'),'# Alpha updated\n[[paper.pdf]] [[later.png]]');await refresh(['a.md']);assert.equal(db.prepare("SELECT count(*) n FROM docs WHERE path='media/image.png'").get().n,0);
 await fs.unlink(path.join(vault,'paper.pdf'));await refresh([]);assert.equal(db.prepare("SELECT count(*) n FROM docs WHERE path='paper.pdf'").get().n,0);assert.ok(db.prepare("SELECT 1 FROM unresolved WHERE name='paper.pdf'").get());
 await fs.writeFile(path.join(vault,'later.png'),'fixture');await refresh([]);assert.equal(db.prepare('SELECT count(*) n FROM edges').get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM unresolved WHERE name='later.png'").get().n,0);
}));
test('unresolved names are stored per source and removed on edit and deletion',()=>fixture(async({vault,db,refresh})=>{
 assert.equal(db.prepare("SELECT count(*) n FROM unresolved WHERE name='missing'").get().n,2);await fs.writeFile(path.join(vault,'a.md'),'# Clean');await refresh(['a.md']);assert.equal(db.prepare("SELECT count(*) n FROM unresolved WHERE name='missing'").get().n,1);await fs.unlink(path.join(vault,'b.md'));await refresh(['b.md']);assert.equal(db.prepare('SELECT count(*) n FROM unresolved').get().n,0);
}));
test('whole-vault and atlas phantom switches share one node per missing name',()=>fixture(async({db})=>{
 const full=queryVault(db,'graphfull',{scope:'all',existing:'0'}),titles=queryVault(db,'graphtitles',{scope:'all',existing:'0'}),i=titles.indexOf('missing');assert.ok(i>=0);assert.equal(full.phantom[i],1);assert.equal(full.degree[i],2);assert.equal(full.phantom.filter(Boolean).length,1);assert.equal(queryVault(db,'graphfull',{existing:'1'}).phantom.filter(Boolean).length,0);
 const small=queryVault(db,'graph',{existing:'0',tags:'1'});assert.equal(small.nodes.filter(n=>n.phantom).length,1);assert.equal(new Set(small.nodes.map(n=>n.id)).size,small.nodes.length);assert.equal(queryVault(db,'graph',{existing:'1'}).nodes.filter(n=>n.phantom).length,0);
}));
test('whole-vault tag nodes and titles align with every tagged document',()=>fixture(async({db})=>{
 const input={scope:'all',tags:'1',existing:'1'},full=queryVault(db,'graphfull',input),titles=queryVault(db,'graphtitles',input),i=titles.indexOf('#shared');assert.ok(i>=0);assert.equal(full.kind[i],2);assert.equal(full.degree[i],2);assert.equal(full.kind.filter(k=>k===2).length,2);assert.equal(full.n,titles.length);assert.ok(queryVault(db,'graphfull',{tags:'0',existing:'1'}).kind.every(k=>k!==2));
}));
test('attachments filter removes attachment nodes and incident links from both query shapes',()=>fixture(async({db})=>{
 const input={attachments:'0',existing:'1',tags:'1'},full=queryVault(db,'graphfull',input),small=queryVault(db,'graph',input);assert.ok(full.kind.every(k=>k!==1));assert.equal(full.n,4);assert.equal(full.links,3);assert.equal(queryVault(db,'graphtitles',input).length,full.n);assert.ok(small.nodes.every(n=>!n.attachment));assert.equal(small.edges.length,3);
}));
test('panel exposes Tags, Attachments, Existing files only, then unlinked documents with hints',async()=>{
 const source=await fs.readFile(new URL('../dist/graph-panel.js',import.meta.url),'utf8'),labels=['Tags','Attachments','Existing files only','Show unlinked documents'];let previous=-1;for(const label of labels){const at=source.indexOf("toggle('"+label+"'");assert.ok(at>previous,label);previous=at;assert.match(source.slice(at,source.indexOf('\n',at)),/},'[^']+'\)\)/);}assert.match(source,/v:SETTINGS_VERSION/);assert.match(source,/existing:saved.existing!==false/);
});
test('attachment display filtering retains whole-vault layout and hides ordinary atlas edges',()=>{
 const big=Object.create(BigAtlas.prototype);big.display={orphans:true,attachments:false};big.degree=[1,1];big.kind=[0,1];assert.equal(big.visible(0),true);assert.equal(big.visible(1),false);
 const a={id:1,kind:0},b={id:2,kind:1},graph=Object.create(Atlas.prototype);Object.assign(graph,{nodes:[a,b],edges:[{a,b}],display:{orphans:true,attachments:false},cellular:true,drawSoon(){}});graph.rebuildLive();assert.deepEqual(graph.live,[a]);assert.equal(graph.liveEdges.length,0);
});
test('whole-vault tag clicks search by tag and phantom clicks never open a document',()=>{
 const big=Object.create(BigAtlas.prototype),calls=[];Object.assign(big,{kind:[2,0],phantom:[0,1],titles:['#shared','missing'],callbacks:{tag:t=>calls.push(t),select:()=>assert.fail('synthetic document opened')}});big.click(0,{});big.click(1,{});assert.deepEqual(calls,['shared']);
});
test('whole-vault attachment switch zeros sizes and hides GPU links without relayout',()=>{
 const uploads=new Map(),big=Object.create(BigAtlas.prototype);let bound;
 const gl={ARRAY_BUFFER:1,DYNAMIC_DRAW:2,bindBuffer:(type,buffer)=>{bound=buffer;},bufferData:(type,data)=>uploads.set(bound,Array.from(data))};
 Object.assign(big,{ctx:gl,loaded:true,n:3,m:2,display:{orphans:true,attachments:false,colorBy:'none'},kind:[0,1,0],phantom:[0,0,1],degree:[2,1,1],edges:[0,1,0,2],rank:[.3,.6,1],palette:['#ffffff'],sizeBuf:'size',colorBuf:'color',edgeTimeBuf:'time',hover:1,drawSoon(){},worker:{postMessage(){assert.fail('filter restarted layout');}}});
 big.paintNodes();assert.equal(uploads.get('size')[1],0);assert.ok(uploads.get('size')[0]>0);assert.deepEqual(uploads.get('time'),[3,3,1,1]);assert.equal(uploads.get('color')[11],140);assert.equal(big.hover,-1);
 big.settings({display:{attachments:true}});assert.ok(uploads.get('size')[1]>0);assert.deepEqual(uploads.get('time'),[.6,.6,1,1].map(Math.fround));
});
