import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {syncCapabilities,loadCapabilities,readSources} from './capability-sync.mjs';
import {syncOrbs,loadOrbs,readOrbSources,FAMILIES} from './orb-sync.mjs';

// Program nodes: every configured program is one island outside the main vault blob, with three append-only Markdown ledgers
// (CODE.md, WORK.md, CAPABILITIES.md). A watcher inside Adamanteum records activity into them without any seat having to remember.
// Nothing here ever opens a ledger for writing except to append, and a full ledger is renamed to a dated archive, never truncated.

export const MiB=1024*1024,GiB=1024*MiB;
export const LIMITS=Object.freeze({
 ledgerBytes:50*MiB,        // per ledger; the next block rolls the file into <LEDGER>-<year>-<month>.md
 dailyBytes:100*MiB,        // total capture writes per day, all programs together
 eventBytes:4096,           // one captured event, text only
 minFreeBytes:20*GiB,       // capture pauses below this much free disk
 excerptChars:600,
 readBytes:64*1024,         // the most of one record file the watcher reads
 capabilityBytes:200*1024,  // the most of one capabilities list copied into one dated block
 commitsPerRef:50,
 pageBytes:64*1024
});
export const LEDGERS=['CODE','WORK','CAPABILITIES'];
export const MAX_CAPABILITY_NODES=400;
export const MAX_ORB_MEMBERS=60;
const NEGATIVE=/(cannot|can't|can not|not yet|does not|doesn't|is not|isn't|no longer|never|not live|not connected|not landed|unable)/i;
const NOW=()=>new Date();
export const etStamp=(when=NOW())=>{
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZoneName:'short'}).formatToParts(when).map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day} ${p.hour==='24'?'00':p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
};
export const etDay=(when=NOW())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(when);
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
export const slugOf=name=>String(name).trim().replace(/[\\/:*?"<>|\x00-\x1f]/g,'-').replace(/\s+/g,'-').replace(/^\.+/,'').slice(0,80);

// ---------- text safety
const SECRET=[/adm1\.[0-9a-f]{12}\.[A-Za-z0-9_-]{20,64}/g,/\bsk-[A-Za-z0-9_-]{16,}/g,/\bgh[pousr]_[A-Za-z0-9]{20,}/g,/\bAKIA[0-9A-Z]{16}\b/g,/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,/(bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,/((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi];
export function clean(text,max=LIMITS.eventBytes){
 let t=String(text??'');
 if(t.includes('\u0000'))return null;                                   // binary bytes are never captured
 t=t.replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
 for(const rule of SECRET)t=t.replace(rule,(m,p1)=>(typeof p1==='string'&&p1?p1:'')+'[redacted]');
 if(Buffer.byteLength(t)>max){let cut=t.slice(0,max);while(Buffer.byteLength(cut)>max-12)cut=cut.slice(0,-16);t=cut+'\n[trimmed]';}
 return t;
}
const escapeRegExp=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

// ---------- manifest
export function parseManifest(raw,{source='programs.json'}={}){
 let data;try{data=typeof raw==='string'?JSON.parse(raw.replace(/^﻿/,'')):raw;}catch(e){throw Error(`${source} is not valid JSON: ${e.message}`);}
 if(!data||data.schema!=='adamanteum.programs/v1'||!Array.isArray(data.programs))throw Error(`${source} must have schema "adamanteum.programs/v1" and a programs list.`);
 const seen=new Set(),programs=[],problems=[];
 for(const [i,p] of data.programs.entries()){
  if(!p||typeof p.name!=='string'||!p.name.trim()){problems.push(`program ${i+1}: name is required`);continue;}
  const slug=slugOf(p.name);if(!slug||seen.has(slug.toLowerCase())){problems.push(`program "${p.name}": duplicate or unusable name`);continue;}
  seen.add(slug.toLowerCase());
  const list=v=>(Array.isArray(v)?v:v==null?[]:[v]).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim());
  programs.push({name:p.name.trim(),slug,repo:typeof p.repo==='string'?p.repo.trim():'',mainBranch:typeof p.mainBranch==='string'?p.mainBranch.trim():'main',aliases:list(p.aliases),matchName:p.matchName!==false,minMentions:Math.max(1,Number(p.minMentions)||2),capabilities:list(p.capabilities),records:list(p.records),checkouts:list(p.checkouts),codeRoot:typeof p.codeRoot==='string'?p.codeRoot.trim():''});
 }
 return {schema:data.schema,programs,problems,checkoutRoots:(Array.isArray(data.checkoutRoots)?data.checkoutRoots:[]).filter(x=>typeof x==='string'),recordRoots:(Array.isArray(data.recordRoots)?data.recordRoots:['Daily-Log','Handoffs','Approvals']).filter(x=>typeof x==='string'),sessionRoots:(Array.isArray(data.sessionRoots)?data.sessionRoots:[]).filter(x=>typeof x==='string')};
}
export function loadManifest(file){return parseManifest(fs.readFileSync(file,'utf8'),{source:path.basename(file)});}

// A program is "named" by a text when its repo name appears, or an alias/name appears in the path or title, or (body) at least minMentions times.
export function matcherFor(program){
 // matchName:false is for programs whose name is also an ordinary word (Line, Still, Firm, Practice): they are found by repo and alias only.
 const words=[...new Set([...(program.matchName===false?[]:[program.name]),...program.aliases])].filter(Boolean);
 const rx=words.map(w=>new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(w)}(?![\\p{L}\\p{N}])`,'giu'));
 const repo=program.repo?new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(program.repo)}($|[^\\p{L}\\p{N}_-])`,'i'):null;
 const folders=program.records.map(r=>r.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase());
 return {
  test(text,{location='',title=''}={}){
   const where=(location+'\n'+title);
   if(repo&&(repo.test(where)||repo.test(text)))return true;
   const norm=location.replace(/\\/g,'/').toLowerCase();
   if(folders.some(f=>norm===f||norm.startsWith(f+'/')))return true;
   let count=0;
   for(const r of rx){r.lastIndex=0;if(r.test(where))return true;r.lastIndex=0;const m=text.match(r);if(m)count+=m.length;}
   return count>=program.minMentions;
  }
 };
}

// ---------- state (SQLite, in the data folder, never in the vault)
export class CaptureState{
 constructor(file){
  this.db=new DatabaseSync(file);
  this.db.exec(`PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS captured(key TEXT PRIMARY KEY,at INTEGER);CREATE TABLE IF NOT EXISTS offsets(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS daily(day TEXT PRIMARY KEY,bytes INTEGER DEFAULT 0,events INTEGER DEFAULT 0,deduped INTEGER DEFAULT 0,dropped INTEGER DEFAULT 0,skipped INTEGER DEFAULT 0);`);
  this.stmt={has:this.db.prepare('SELECT 1 FROM captured WHERE key=?'),add:this.db.prepare('INSERT OR IGNORE INTO captured VALUES(?,?)'),getOff:this.db.prepare('SELECT value FROM offsets WHERE key=?'),setOff:this.db.prepare('INSERT OR REPLACE INTO offsets VALUES(?,?)'),day:this.db.prepare('SELECT * FROM daily WHERE day=?'),ensure:this.db.prepare('INSERT OR IGNORE INTO daily(day) VALUES(?)')};
 }
 seen(key){return !!this.stmt.has.get(key);}
 remember(key){this.stmt.add.run(key,Date.now());}
 offset(key){const r=this.stmt.getOff.get(key);return r?r.value:null;}
 setOffset(key,value){this.stmt.setOff.run(key,String(value));}
 today(day){this.stmt.ensure.run(day);return {...this.stmt.day.get(day)};}
 bump(day,field,by=1){this.stmt.ensure.run(day);this.db.prepare(`UPDATE daily SET ${field}=${field}+? WHERE day=?`).run(by,day);}
 prune(days=400){this.db.prepare('DELETE FROM captured WHERE at<?').run(Date.now()-days*86400000);this.db.prepare('DELETE FROM daily WHERE day<?').run(etDay(new Date(Date.now()-days*86400000)));}
 close(){try{this.db.close();}catch{}}
}

// ---------- the ledgers
export class Ledgers{
 constructor({root,state,limits={},freeBytes=null,now=NOW}){
  this.root=root;this.state=state;this.limits={...LIMITS,...limits};this.now=now;
  this.freeBytes=freeBytes||(()=>{try{const s=fs.statfsSync(this.root);return s.bavail*s.bsize;}catch{try{const s=fs.statfsSync(path.parse(path.resolve(this.root)).root);return s.bavail*s.bsize;}catch{return Infinity;}}});
  this.pause=null;
 }
 dir(program){return path.join(this.root,program.slug);}
 file(program,ledger){return path.join(this.dir(program),ledger+'.md');}
 header(program,ledger){
  const blurb={CODE:'What the code graph scan found: files, symbols, entry points, last scan sha and time. Each scan is a new dated block; the latest block is current.',WORK:'Every order, result, handoff, approval, branch, commit and door call that names this program, appended at the end with a timestamp.',CAPABILITIES:'The capabilities list. Each version is appended with its date; the latest block is current.'}[ledger];
  return `---\nprogram: ${program.name}\nledger: ${ledger}\nrepo: ${program.repo||''}\nappend_only: true\n---\n# ${program.name} · ${ledger}\n\n${blurb}\nNothing in this file is overwritten or deleted. A change is a new dated block at the end.\n`;
 }
 checkPause(){
  const free=this.freeBytes();
  if(free<this.limits.minFreeBytes){this.pause={reason:`capture paused: disk under ${Math.round(this.limits.minFreeBytes/GiB)} GB free`,free};return this.pause;}
  const day=etDay(this.now()),t=this.state.today(day);
  if(t.bytes>=this.limits.dailyBytes){this.pause={reason:`capture paused: today's write budget of ${Math.round(this.limits.dailyBytes/MiB)} MB is used`,free};return this.pause;}
  this.pause=null;return null;
 }
 // Append one block. Returns {written, reason}. Never opens for truncation; rolls a full file to a free dated name first.
 append(program,ledger,block,{dedupeKey=null,count=true}={}){
  if(!LEDGERS.includes(ledger))throw Error('Unknown ledger.');
  const day=etDay(this.now());
  if(dedupeKey){const key=sha(program.slug+'|'+ledger+'|'+dedupeKey);if(this.state.seen(key)){this.state.bump(day,'deduped');return {written:false,reason:'duplicate'};}dedupeKey=key;}
  const text=clean(block,Math.max(this.limits.eventBytes,this.limits.capabilityBytes+4096));
  if(text===null){this.state.bump(day,'skipped');return {written:false,reason:'binary'};}
  if(this.checkPause()){this.state.bump(day,'dropped');return {written:false,reason:this.pause.reason};}
  const body='\n'+text.replace(/\s+$/,'')+'\n',bytes=Buffer.byteLength(body);
  const dir=this.dir(program),file=this.file(program,ledger);
  fs.mkdirSync(dir,{recursive:true});
  let size=0;try{size=fs.statSync(file).size;}catch{}
  if(size&&size+bytes>this.limits.ledgerBytes)this.roll(program,ledger);
  let fd;
  try{
   try{fd=fs.openSync(file,'ax');fs.writeSync(fd,this.header(program,ledger));fs.closeSync(fd);}catch(e){if(e.code!=='EEXIST')throw e;}
   fd=fs.openSync(file,'a');fs.writeSync(fd,body);fs.closeSync(fd);fd=null;
  }finally{if(fd)try{fs.closeSync(fd);}catch{}}
  if(dedupeKey)this.state.remember(dedupeKey);
  if(count){this.state.bump(day,'bytes',bytes);this.state.bump(day,'events');}
  return {written:true,bytes};
 }
 roll(program,ledger){
  const file=this.file(program,ledger),d=this.now();
  const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit'}).format(d).replace('/','-');
  let target,n=1;do{target=path.join(this.dir(program),`${ledger}-${stamp}${n>1?'-'+n:''}.md`);n++;}while(fs.existsSync(target));
  fs.renameSync(file,target);
  fs.writeFileSync(file,this.header(program,ledger)+`\nThis ledger continues from [[${path.basename(target,'.md')}]] (rolled at ${etStamp(d)} because the file reached its size cap).\n`,{flag:'wx'});
  return target;
 }
 archives(program,ledger){try{return fs.readdirSync(this.dir(program)).filter(f=>new RegExp(`^${ledger}-\\d{4}-\\d{2}(-\\d+)?\\.md$`).test(f)).sort();}catch{return [];}}
 info(program,ledger){
  try{const s=fs.statSync(this.file(program,ledger));return {bytes:s.size,updated:s.mtime.toISOString(),archives:this.archives(program,ledger)};}catch{return {bytes:0,updated:null,archives:this.archives(program,ledger)};}
 }
 // A window of a ledger, ending at `before` (default: the end), at most pageBytes long, starting on a line.
 read(program,ledger,{before=null,bytes=this.limits.pageBytes,archive=null}={}){
  if(!LEDGERS.includes(ledger))throw Error('Unknown ledger.');
  let name=ledger+'.md';
  if(archive){if(!this.archives(program,ledger).includes(archive))throw Error('Unknown archive.');name=archive;}
  const file=path.join(this.dir(program),name);
  let stat;try{stat=fs.statSync(file);}catch{return {ledger,file:name,size:0,start:0,end:0,text:'',hasEarlier:false,archives:this.archives(program,ledger)};}
  const end=before==null?stat.size:Math.max(0,Math.min(stat.size,Number(before)||0)),want=Math.max(1024,Math.min(256*1024,Number(bytes)||this.limits.pageBytes));
  let start=Math.max(0,end-want);
  const fd=fs.openSync(file,'r');
  try{
   const buf=Buffer.alloc(end-start);fs.readSync(fd,buf,0,buf.length,start);
   let text=buf.toString('utf8');
   if(start>0){const nl=text.indexOf('\n');if(nl>=0){start+=Buffer.byteLength(text.slice(0,nl+1));text=text.slice(nl+1);}}
   return {ledger,file:name,size:stat.size,start,end,text,hasEarlier:start>0,archives:this.archives(program,ledger)};
  }finally{fs.closeSync(fd);}
 }
 latestBlock(program,ledger){
  const {text}=this.read(program,ledger,{bytes:this.limits.capabilityBytes+8192});
  const i=text.lastIndexOf('\n## ');return i>=0?text.slice(i+1):text;
 }
}

// ---------- events -> WORK.md blocks
export function workBlock({when,source,kind,lines=[],key}){
 const stamp=etStamp(when instanceof Date?when:new Date(when||Date.now()));
 const body=lines.filter(Boolean).map(l=>'- '+String(l).replace(/\r?\n/g,' ').slice(0,900)).join('\n');
 return `## ${stamp} · ${source} · ${kind}\n${body}${key?`\n<!-- evt:${key.slice(0,12)} -->`:''}`;
}
const run=(cmd,args,{cwd,timeout=20000}={})=>new Promise(resolve=>execFile(cmd,args,{cwd,timeout,windowsHide:true,maxBuffer:4*MiB},(error,stdout)=>resolve(error?null:String(stdout))));

// ---------- the watcher
export class ProgramCapture{
 constructor({vault,dataRoot,programsRoot,manifestFile,activity=null,limits={},freeBytes=null,backfillDays=2,homeDir=os.homedir(),scan=null,gitCommand='git',now=NOW}={}){
  this.vault=vault;this.dataRoot=dataRoot;this.programsRoot=programsRoot;this.manifestFile=manifestFile;this.activity=activity;this.backfillDays=backfillDays;this.gitCommand=gitCommand;this.now=now;this.homeDir=homeDir;
  this.manifest=null;this.matchers=new Map();this.timer=null;this.busy=false;this.lastRun=null;this.lastEvent=null;this.errors=[];this.codeBusy=false;this.scan=scan;
  fs.mkdirSync(dataRoot,{recursive:true});
  this.state=new CaptureState(path.join(dataRoot,'programs.sqlite'));
  this.ledgers=new Ledgers({root:programsRoot,state:this.state,limits,freeBytes,now});
  this.limits=this.ledgers.limits;
  this.last={receipts:null,records:null,git:null,sessions:null,capabilities:null,capmap:null,code:null};this.capSignature=null;this.capSummary=null;this.capCache=new Map();this.orbSignature=null;this.orbSummary=null;this.orbCache=null;
  this.perPass=0;
 }
 get enabled(){return !!this.manifest;}
 reload(){
  try{if(!this.manifestFile||!fs.existsSync(this.manifestFile)){this.manifest=null;this.manifestError=this.manifestFile?'No programs.json at '+this.manifestFile:'No manifest';return false;}
   const m=loadManifest(this.manifestFile);this.manifest=m;this.manifestError=null;this.matchers=new Map(m.programs.map(p=>[p.slug,matcherFor(p)]));return true;}
  catch(e){this.manifest=null;this.manifestError=e.message;return false;}
 }
 programs(){return this.manifest?.programs||[];}
 program(slug){return this.programs().find(p=>p.slug.toLowerCase()===String(slug).toLowerCase())||null;}
 // one captured event for one program
 record(program,{when,source,kind,lines,identity}){
  const key=sha(identity||[source,kind,...(lines||[])].join('|'));
  const r=this.ledgers.append(program,'WORK',workBlock({when,source,kind,lines,key}),{dedupeKey:identity||key});
  if(r.written){this.perPass++;this.lastEvent={at:new Date().toISOString(),program:program.name,source,kind};}
  return r;
 }
 recordFor(text,context,event){
  let n=0;
  for(const p of this.programs()){if(this.matchers.get(p.slug).test(text,context)){if(this.record(p,event).written)n++;}}
  return n;
 }
 async tick({force=false}={}){
  if(!this.enabled||this.busy)return null;
  this.busy=true;this.perPass=0;const started=Date.now();
  try{
   for(const [name,fn,every] of [['receipts',()=>this.pollReceipts(),4000],['records',()=>this.pollRecords(),20000],['capabilities',()=>this.pollCapabilities(),60000],['capmap',()=>this.capabilityTick(),60000],['git',()=>this.pollGit(),120000],['sessions',()=>this.pollSessions(),60000]]){
    if(!force&&this.last[name]&&Date.now()-this.last[name]<every)continue;
    this.last[name]=Date.now();
    try{await fn();}catch(e){this.errors.push({at:new Date().toISOString(),source:name,error:String(e.message||e).slice(0,200)});this.errors=this.errors.slice(-20);}
   }
   if(this.scan&&!this.codeBusy&&(force||!this.last.code||Date.now()-this.last.code>600000)){this.last.code=Date.now();this.pollCode().catch(e=>{this.errors.push({at:new Date().toISOString(),source:'code',error:String(e.message||e).slice(0,200)});});}
   this.lastRun=new Date().toISOString();
   if(this.perPass&&this.activity)this.activity.emit('capture.written',`Captured ${this.perPass} event${this.perPass===1?'':'s'} into program work ledgers`,[],{count:this.perPass});
   return {written:this.perPass,ms:Date.now()-started};
  }finally{this.busy=false;}
 }
 start({every=5000}={}){
  if(this.timer)return;this.reload();
  this.timer=setInterval(()=>{this.tick().catch(()=>{});},every);this.timer.unref?.();
  this.pruneTimer=setInterval(()=>{try{this.state.prune();}catch{}},6*3600*1000);this.pruneTimer.unref?.();
  setTimeout(()=>this.tick({force:true}).catch(()=>{}),1500).unref?.();
 }
 stop(){clearInterval(this.timer);clearInterval(this.pruneTimer);this.timer=null;}

 // door receipts and write-backs
 async pollReceipts(){
  const file=path.join(this.dataRoot,'door-receipts.jsonl');
  let stat;try{stat=await fsp.stat(file);}catch{return;}
  let offset=Number(this.state.offset('receipts'));
  if(!Number.isFinite(offset)||this.state.offset('receipts')===null){offset=Math.max(0,stat.size-256*1024);} // first run: recent tail only
  if(stat.size<offset)offset=0;
  if(stat.size===offset)return;
  const length=Math.min(stat.size-offset,2*MiB),fh=await fsp.open(file,'r');let text;
  try{const buf=Buffer.alloc(length);await fh.read(buf,0,length,offset);text=buf.toString('utf8');}finally{await fh.close();}
  const lastNl=text.lastIndexOf('\n');if(lastNl<0){return;}
  const complete=text.slice(0,lastNl+1);this.state.setOffset('receipts',offset+Buffer.byteLength(complete));
  for(const line of complete.split('\n')){
   if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{continue;}
   if(r.kind==='refused')continue;
   const blob=[r.path,r.query,r.focus,r.directory,r.from,r.to,...(r.paths||[]),...(r.top||[]),r.title].filter(Boolean).join('\n');
   if(!blob)continue;
   const lines=[`actor: ${r.actor||'unknown'}`,r.path&&`path: [[${r.path}]]`,r.query&&`query: ${String(r.query).slice(0,200)}`,r.directory&&`directory: ${String(r.directory).slice(0,200)}`,r.sha256&&`sha256: ${String(r.sha256).slice(0,12)}`,r.revision!=null&&`revision: ${r.revision}`,r.created!=null&&`created: ${r.created}`,r.count!=null&&`results: ${r.count}`,`receipt: ${r.receiptId||''}`];
   this.recordFor(blob,{location:blob},{when:r.at,source:'door',kind:r.kind||'call',lines,identity:'receipt|'+(r.receiptId||sha(line))});
  }
 }

 // new or changed records under Daily-Log / Handoffs / Approvals (and any manifest record folders)
 async pollRecords(){
  const cutoffKey='records.first';let first=this.state.offset(cutoffKey);
  if(first===null){first=String(Date.now());this.state.setOffset(cutoffKey,first);}
  const floor=Number(first)-this.backfillDays*86400000;
  const roots=new Set(this.manifest.recordRoots);for(const p of this.programs())for(const r of p.records)roots.add(r);
  const seenState=new Map();
  for(const root of roots){
   const base=path.join(this.vault,root);
   const stack=[''];
   while(stack.length){
    const rel=stack.pop();let entries;
    try{entries=await fsp.readdir(path.join(base,rel),{withFileTypes:true});}catch{continue;}
    for(const e of entries){
     if(e.isSymbolicLink()||e.name.startsWith('.'))continue;
     const r=rel?rel+'/'+e.name:e.name;
     if(e.isDirectory()){
      // a dated folder older than the window cannot hold anything new: skip it by its directory mtime
      let m=0;try{m=(await fsp.stat(path.join(base,r))).mtimeMs;}catch{}
      if(m>=floor)stack.push(r);continue;
     }
     if(!/\.(md|txt)$/i.test(e.name))continue;
     let st;try{st=await fsp.stat(path.join(base,r));}catch{continue;}
     if(st.mtimeMs<floor||st.size>8*MiB)continue;
     const vaultPath=(root+'/'+r).replace(/\\/g,'/'),stateKey='file|'+vaultPath,signature=`${Math.floor(st.mtimeMs)}:${st.size}`;
     if(this.state.offset(stateKey)===signature)continue;
     await this.captureFile(vaultPath,path.join(base,r),st,signature,stateKey);
    }
   }
  }
 }
 async captureFile(vaultPath,absolute,st,signature,stateKey){
  let text;
  try{const fh=await fsp.open(absolute,'r');try{const len=Math.min(st.size,this.limits.readBytes),buf=Buffer.alloc(len);await fh.read(buf,0,len,0);text=buf.toString('utf8');}finally{await fh.close();}}catch{return;}
  if(text.includes('\u0000')){this.state.bump(etDay(this.now()),'skipped');this.state.setOffset(stateKey,signature);return;}
  const title=(/^#\s+(.+)$/m.exec(text)?.[1]||path.posix.basename(vaultPath)).trim().slice(0,160);
  const body=text.replace(/^---[\s\S]*?\n---\s*\n/,'');
  const excerpt=body.replace(/^#.*\n/,'').replace(/\s+/g,' ').trim().slice(0,this.limits.excerptChars);
  const hash=sha(text).slice(0,16);
  let any=false;
  for(const p of this.programs()){
   if(!this.matchers.get(p.slug).test(text,{location:vaultPath,title}))continue;
   const r=this.record(p,{when:new Date(st.mtimeMs),source:'record',kind:this.kindOf(vaultPath),lines:[`file: [[${vaultPath.replace(/\.md$/i,'')}]]`,`title: ${title}`,`size: ${st.size} bytes · sha ${hash}`,excerpt&&`excerpt: ${excerpt}`],identity:`file|${vaultPath}|${hash}`});
   any=any||r.written;
  }
  this.state.setOffset(stateKey,signature);
  return any;
 }
 kindOf(p){const t=p.toLowerCase();return t.startsWith('approvals')?'approval':t.startsWith('handoffs')?'handoff':/order/.test(t)?'order':/result/.test(t)?'result':t.startsWith('director-log')?'log':'record';}

 // capabilities lists: each new version is a new dated block
 async pollCapabilities(){
  for(const p of this.programs()){
   for(const rel of p.capabilities){
    const absolute=path.isAbsolute(rel)?rel:path.join(this.vault,rel);let text;
    try{const st=await fsp.stat(absolute);if(st.size>8*MiB)continue;text=await fsp.readFile(absolute,'utf8');}catch{continue;}
    if(text.includes('\u0000'))continue;
    const hash=sha(text).slice(0,16);
    const body=Buffer.byteLength(text)>this.limits.capabilityBytes?text.slice(0,this.limits.capabilityBytes)+`\n\n[trimmed: the full list is ${Buffer.byteLength(text)} bytes at ${rel}]`:text;
    const block=`## ${etStamp(this.now())} · capabilities version ${hash.slice(0,8)}\nSource: [[${String(rel).replace(/\\/g,'/').replace(/\.md$/i,'')}]] · ${Buffer.byteLength(text)} bytes\n\n${body.replace(/^(#{1,6})\s/gm,(m,h)=>'#'.repeat(Math.min(6,h.length+2))+' ')}`;
    const r=this.ledgers.append(p,'CAPABILITIES',block,{dedupeKey:'cap|'+rel+'|'+hash});
    if(r.written){this.perPass++;this.lastEvent={at:new Date().toISOString(),program:p.name,source:'capabilities',kind:'version'};}
   }
  }
 }

 // ADAMCAP1: the capability map. The vault's capability lists are re-read when their files change; the ring nodes come from the derived cache.
 async capabilityTick(){
  const sig=readSources(this.vault).signature+'|'+readOrbSources(this.vault).signature;
  if(this.capSignature===sig&&this.capSummary)return;
  this.capabilitySync();this.capSignature=sig;
 }
 capabilitySync(){
  const r=syncCapabilities({vault:this.vault,dataRoot:this.dataRoot,programs:this.programs(),ledgers:this.ledgers,stamp:etStamp(this.now())});
  if(r.ok){this.capSignature=r.signature;this.perPass+=r.written;}
  this.orbSync();
  this.capSummary={at:new Date().toISOString(),ok:r.ok,reason:r.reason||null,total:r.total,dupes:r.dupes,written:r.written,unchanged:r.unchanged,unmapped:r.unmapped,excused:r.excused||[],programs:r.programs};
  this.capCache=new Map();
  return this.capSummary;
 }
 // ADAMCAP4: orbs for adapters, connectors and extensions. Rebuilt whenever the capability map is, because the programs an orb serves come partly from it.
 orbSync(){
  const capabilityTexts={};for(const p of this.programs())capabilityTexts[p.slug]=this.capabilitiesOf(p).map(c=>c.text);
  const r=syncOrbs({vault:this.vault,dataRoot:this.dataRoot,programs:this.programs(),capabilityTexts});
  this.orbSignature=r.signature||null;this.orbCache=null;this.orbSummary={at:new Date().toISOString(),ok:r.ok,reason:r.reason||null,counts:r.counts,total:r.total,missingNotes:r.missingNotes||[],trades:r.trades};
  return this.orbSummary;
 }
 // What a program can and cannot do, what is open and what is done, counted from its capability lines and its WORK ledger. No judgement is added:
 // "cannot" is a line the vault itself words as a negative; "open" is a line still coming, required, partial or unproven.
 ledgerOf(p){
  const items=this.capabilitiesOf(p),out={notes:items.length,can:0,cannot:0,open:0,done:0,lines:{can:[],cannot:[],open:[],done:[]}};
  const add=(k,c)=>{out[k]++;if(out.lines[k].length<5)out.lines[k].push({text:c.text.slice(0,160),note:c.source});};
  for(const c of items){const neg=NEGATIVE.test(c.text);if(neg)add('cannot',c);if(/^(live|built|proven)$/.test(c.status)&&!neg)add('can',c);else if(/^(coming|required|partial|unverified|missing)$/.test(c.status))add('open',c);}
  try{const w=this.ledgers.read(p,'WORK',{bytes:256*1024}).text;for(const m of w.matchAll(/^## .*·\s*(result|approval|handoff).*$/gim))out.done++;}catch{}
  return out;
 }
 orbData(){if(!this.orbCache)this.orbCache=loadOrbs(this.dataRoot);return this.orbCache;}
 capabilitiesOf(p){
  if(!this.capCache.has(p.slug))this.capCache.set(p.slug,loadCapabilities(this.dataRoot,p.slug));
  return this.capCache.get(p.slug);
 }

 // git: branches and commits of every checkout of every program
 checkoutsOf(p){
  const found=new Set(p.checkouts.filter(c=>fs.existsSync(path.join(c,'.git'))));
  return [...found];
 }
 async discoverCheckouts(){
  if(this._disc&&Date.now()-this._disc.at<600000)return this._disc.map;
  const map=new Map();
  for(const root of this.manifest.checkoutRoots){
   let entries;try{entries=await fsp.readdir(root,{withFileTypes:true});}catch{continue;}
   for(const e of entries){
    if(!e.isDirectory()||e.name.startsWith('.'))continue;
    for(const dir of [path.join(root,e.name),path.join(root,e.name,'desktop'),path.join(root,e.name,'repo')]){
     if(!fs.existsSync(path.join(dir,'.git')))continue;
     const url=(await run(this.gitCommand,['config','--get','remote.origin.url'],{cwd:dir,timeout:8000}))?.trim()||'';
     const repo=url.replace(/\.git$/,'').split(/[/:]/).pop();
     if(!repo)continue;if(!map.has(repo.toLowerCase()))map.set(repo.toLowerCase(),[]);map.get(repo.toLowerCase()).push(dir);
    }
   }
  }
  this._disc={at:Date.now(),map};return map;
 }
 async checkoutsFor(p){
  const set=new Set(this.checkoutsOf(p));
  if(p.repo){for(const d of (await this.discoverCheckouts()).get(p.repo.toLowerCase())||[])set.add(d);}
  return [...set];
 }
 async pollGit(){
  const floor=Date.now()-this.backfillDays*86400000;
  for(const p of this.programs()){
   const dirs=await this.checkoutsFor(p);
   for(const dir of dirs){
    const refs=await run(this.gitCommand,['for-each-ref','--format=%(refname)\t%(objectname)\t%(committerdate:iso-strict)','refs/heads','refs/remotes'],{cwd:dir});
    if(refs===null)continue;
    for(const line of refs.split('\n')){
     const [ref,sha1,date]=line.split('\t');if(!ref||!sha1||ref.endsWith('/HEAD'))continue;
     const key=`ref|${p.slug}|${dir}|${ref}`,last=this.state.offset(key);
     if(last===sha1)continue;
     const tipTime=Date.parse(date)||0;
     if(last===null&&tipTime<floor){this.state.setOffset(key,sha1);continue;}   // old branch seen for the first time: remember, do not backfill history
     const range=last?`${last}..${sha1}`:sha1;
     const log=await run(this.gitCommand,['log',range,`--max-count=${this.limits.commitsPerRef}`,'--format=%H%x1f%an%x1f%aI%x1f%s'].concat(last?[]:[`--since=${new Date(floor).toISOString()}`]),{cwd:dir});
     const name=ref.replace(/^refs\/(heads|remotes)\//,'');
     if(log){
      for(const row of log.split('\n')){
       const [h,author,when,subject]=row.split('\x1f');if(!h)continue;
       this.record(p,{when:new Date(when),source:'git',kind:'commit',lines:[`commit: ${h.slice(0,10)} on ${name}`,`subject: ${subject}`,`author: ${author}`,`checkout: ${dir}`],identity:`commit|${h}`});
      }
     }
     this.record(p,{when:new Date(tipTime||Date.now()),source:'git',kind:last===null?'branch seen':'branch moved',lines:[`branch: ${name} at ${sha1.slice(0,10)}`,`checkout: ${dir}`],identity:`tip|${name}|${sha1}`});
     this.state.setOffset(key,sha1);
    }
   }
  }
 }

 // seat session notes: metadata only (never transcript bodies), once per session file per day
 async pollSessions(){
  const roots=this.manifest.sessionRoots.length?this.manifest.sessionRoots:[];
  const floor=Date.now()-86400000;
  for(const root of roots){
   const stack=[root];let visited=0;
   while(stack.length&&visited<4000){
    const dir=stack.pop();let entries;try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch{continue;}
    for(const e of entries){
     const full=path.join(dir,e.name);visited++;
     if(e.isDirectory()){stack.push(full);continue;}
     if(!/\.jsonl$/i.test(e.name))continue;
     let st;try{st=await fsp.stat(full);}catch{continue;}
     if(st.mtimeMs<floor)continue;
     const day=etDay(new Date(st.mtimeMs)),stateKey='session|'+full+'|'+day;
     if(this.state.offset(stateKey)!==null)continue;
     const head=await this.sessionHead(full);
     if(!head)continue;
     this.state.setOffset(stateKey,String(st.size));
     for(const p of this.programs()){
      if(!this.matchers.get(p.slug).test(head.text,{location:head.first,title:''}))continue;
      this.record(p,{when:new Date(st.mtimeMs),source:'session',kind:'seat session active',lines:[`session: ${e.name.replace(/\.jsonl$/i,'')}`,head.first&&`first request: ${head.first}`,`size: ${st.size} bytes (transcript not copied)`],identity:`session|${e.name}|${day}`});
     }
    }
   }
  }
 }
 async sessionHead(file){
  try{const fh=await fsp.open(file,'r');try{const buf=Buffer.alloc(16*1024),{bytesRead}=await fh.read(buf,0,buf.length,0);const text=buf.toString('utf8',0,bytesRead);
   let first='';for(const line of text.split('\n')){try{const j=JSON.parse(line);const c=j?.message?.content??j?.payload?.content??j?.content??j?.text;const t=typeof c==='string'?c:Array.isArray(c)?c.map(x=>x?.text||'').join(' '):'';if(t&&(j.type==='user'||j.role==='user'||j?.message?.role==='user'||j?.payload?.role==='user')){first=t;break;}}catch{}}
   return {text:text.slice(0,8192),first:clean(first.replace(/\s+/g,' ').slice(0,200),400)||''};}finally{await fh.close();}}catch{return null;}
 }

 // the code graph: reuse project-worker (the same scan adamanteum-cli uses), one program at a time
 async pollCode({force=false}={}){
  if(!this.scan||this.codeBusy)return;this.codeBusy=true;
  try{
   for(const p of this.programs()){
    const dirs=p.codeRoot?[p.codeRoot]:await this.checkoutsFor(p);const dir=dirs.find(d=>fs.existsSync(d));
    if(!dir)continue;
    const head=(await run(this.gitCommand,['rev-parse','HEAD'],{cwd:dir}))?.trim()||'';
    const keyHead=`code|${p.slug}`,last=this.state.offset(keyHead);
    const tag=head||'nogit:'+(()=>{try{return Math.floor(fs.statSync(dir).mtimeMs);}catch{return 0;}})();
    if(!force&&last===tag)continue;
    if(os.freemem()<12*GiB&&!force)return;     // the laptop stays light: no scan under 12 GB free
    await this.scanProgram(p,dir,head,tag);
   }
  }finally{this.codeBusy=false;}
 }
 async scanProgram(p,dir,head,tag){
  const result=await this.scan(dir);
  const summary=summarizeScan(result,{program:p,dir,sha:head,at:this.now()});
  const sumDir=path.join(this.dataRoot,'programs',p.slug);fs.mkdirSync(sumDir,{recursive:true});
  const tmp=path.join(sumDir,'code-summary.json.next');fs.writeFileSync(tmp,JSON.stringify(summary));fs.renameSync(tmp,path.join(sumDir,'code-summary.json')); // derived cache; the ledger is the record
  const r=this.ledgers.append(p,'CODE',codeBlock(summary),{dedupeKey:'scan|'+tag});
  this.state.setOffset(`code|${p.slug}`,tag);
  if(r.written){this.perPass++;this.lastEvent={at:new Date().toISOString(),program:p.name,source:'code',kind:'scan'};}
  return summary;
 }
 async scanNow(p){
  if(!this.scan)throw Error('Code scanning is switched off');
  const dirs=p.codeRoot?[p.codeRoot]:await this.checkoutsFor(p),dir=dirs.find(d=>fs.existsSync(d));
  if(!dir)throw Error('No checkout found');
  const head=(await run(this.gitCommand,['rev-parse','HEAD'],{cwd:dir}))?.trim()||'';
  return this.scanProgram(p,dir,head,head||'manual-'+Date.now());
 }
 codeSummary(p){try{return JSON.parse(fs.readFileSync(path.join(this.dataRoot,'programs',p.slug,'code-summary.json'),'utf8'));}catch{return null;}}

 // ---------- read side
 status(){
  const day=etDay(this.now()),t=this.state.today(day),pause=this.enabled?this.ledgers.checkPause():null,free=this.ledgers.freeBytes();
  return {schema:'adamanteum.capture.status/v1',enabled:this.enabled,reason:this.enabled?null:this.manifestError,watching:!!this.timer,paused:pause?pause.reason:null,
   today:{day,bytes:t.bytes,events:t.events,deduped:t.deduped,dropped:t.dropped,skippedBinary:t.skipped,budgetBytes:this.limits.dailyBytes},
   limits:{ledgerBytes:this.limits.ledgerBytes,dailyBytes:this.limits.dailyBytes,eventBytes:this.limits.eventBytes,minFreeGB:Math.round(this.limits.minFreeBytes/GiB)},
   diskFreeGB:Number.isFinite(free)?Math.round(free/GiB*10)/10:null,programs:this.programs().length,lastRun:this.lastRun,lastEvent:this.lastEvent,errors:this.errors.slice(-5),codeScanning:this.codeBusy};
 }
 list(){
  return this.programs().map(p=>{
   const info=Object.fromEntries(LEDGERS.map(l=>[l,this.ledgers.info(p,l)])),code=this.codeSummary(p);
   return {name:p.name,slug:p.slug,repo:p.repo,mainBranch:p.mainBranch,ledgers:info,ledger:this.ledgerOf(p),code:code?{sha:code.sha,at:code.at,files:code.files,symbols:code.symbols}:null};
  });
 }
 // The island of every program for the whole-vault map: a hub, three ledger nodes, and the program's top code symbols.
 graph({maxSymbols=12}={}){
  const out={schema:'adamanteum.programs.graph/v1',n:0,ids:[],titles:[],kind:[],island:[],degree:[],edges:[],programs:[]};
  const add=(id,title,kind,island)=>{out.ids.push(id);out.titles.push(title);out.kind.push(kind);out.island.push(island);out.degree.push(0);return out.n++;};
  const link=(a,b)=>{out.edges.push(a,b);out.degree[a]++;out.degree[b]++;};
  let id=-1000;
  this.programs().forEach((p,k)=>{
   const hub=add(id--,p.name,3,k+1),entry={index:k+1,name:p.name,slug:p.slug,hub,ledgers:{},symbols:[]};
   for(const l of LEDGERS){const node=add(id--,`${p.name} · ${l}`,4,k+1);entry.ledgers[l]=node;link(hub,node);}
   const code=this.codeSummary(p);
   for(const s of (code?.top||[]).slice(0,maxSymbols)){const node=add(id--,s.name,5,k+1);entry.symbols.push(node);link(entry.ledgers.CODE,node);}
   const caps=this.capabilitiesOf(p);entry.ledger=this.ledgerOf(p);entry.capabilityCount=caps.length;entry.capabilities=[];entry.capabilityMeta=[];
   for(const c of caps.slice(0,MAX_CAPABILITY_NODES)){const node=add(id--,c.text.length>60?c.text.slice(0,59).replace(/\s+\S*$/,'')+'…':c.text,6,k+1);entry.capabilities.push(node);entry.capabilityMeta.push({text:c.text,status:c.status,source:c.source,line:c.line});link(entry.ledgers.CAPABILITIES,node);}
   out.programs.push(entry);
  });
  // Orbs go on the outer ring, one island each, in family order. Members (skills, trades, what a tool exports) are small notes around the hub;
  // the full count is on the orb. The orb carries its note, category, trades and programs for the click card and the index.
  const base=this.programs().length;
  this.orbData().orbs.forEach((o,j)=>{
   const k=base+j+1,hub=add(id--,o.name,3,k),entry={index:k,name:o.name,slug:'orb-'+o.id.replace(/[^a-z0-9]+/gi,'-'),family:o.family,hub,ledgers:{},symbols:[],capabilities:[],capabilityMeta:[],capabilityCount:o.count,
    orb:{id:o.id,family:o.family,category:o.category,trades:o.trades,programs:o.programs,evidence:o.evidence||{},note:o.note,noteMissing:o.noteMissing,source:o.source}};
   for(const m of o.members.slice(0,MAX_ORB_MEMBERS)){const node=add(id--,m.text.length>60?m.text.slice(0,59).replace(/\s+\S*$/,'')+'…':m.text,6,k);entry.capabilities.push(node);entry.capabilityMeta.push({text:m.text,status:o.family,source:o.note});link(hub,node);}
   out.programs.push(entry);
  });
  out.ringSplit=base;
  return out;
 }
}

export function summarizeScan(graph,{program,dir,sha:head,at}){
 const kinds={},nodes=graph.nodes||[],byId=new Map(nodes.map(n=>[n.id,n])),incoming=new Map(),outgoing=new Map();
 for(const e of graph.edges||[]){if(e.type!=='invokes'&&e.type!=='imports')continue;if(e.type==='invokes'){incoming.set(e.target,(incoming.get(e.target)||0)+1);}outgoing.set(e.source,(outgoing.get(e.source)||0)+1);}
 const symbols=nodes.filter(n=>!['file','call'].includes(n.kind));
 for(const n of symbols)kinds[n.kind]=(kinds[n.kind]||0)+1;
 const entryName=/(^|\/)(server|index|main|app|cli|worker|handler|route|routes|api)[^/]*\.[cm]?[jt]sx?$|(^|\/)(__main__|manage|wsgi|asgi)\.py$|(^|\/)package\.json$/i;
 const entryFiles=nodes.filter(n=>n.kind==='file'&&entryName.test(n.path||n.title||'')).map(n=>n.path||n.title).slice(0,25);
 const called=symbols.filter(n=>(outgoing.get(n.id)||0)>0&&!(incoming.get(n.id)||0)).sort((a,b)=>(outgoing.get(b.id)||0)-(outgoing.get(a.id)||0)).slice(0,15).map(n=>({name:n.title,path:n.path,line:n.line||null,calls:outgoing.get(n.id)||0}));
 const top=symbols.map(n=>({name:n.title,kind:n.kind,path:n.path,line:n.line||null,degree:(incoming.get(n.id)||0)+(outgoing.get(n.id)||0)})).filter(s=>s.degree>0).sort((a,b)=>b.degree-a.degree||String(a.name).localeCompare(b.name)).slice(0,40);
 return {program:program.name,dir,sha:head||null,at:etStamp(at),files:graph.files??nodes.filter(n=>n.kind==='file').length,symbols:symbols.length,edges:(graph.edges||[]).length,issues:(graph.issues||[]).length,kinds,entryFiles,entrySymbols:called,top};
}
export function codeBlock(s){
 const kinds=Object.entries(s.kinds).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(', ');
 return `## ${s.at} · scan of ${s.sha?s.sha.slice(0,10):'(not a git checkout)'}\n- checkout: ${s.dir}\n- last scan sha: ${s.sha||'none'} · time: ${s.at}\n- files: ${s.files} · symbols: ${s.symbols} (${kinds||'none'}) · links: ${s.edges} · issues: ${s.issues}\n- entry files: ${s.entryFiles.length?s.entryFiles.join(', '):'none found'}\n- entry points (called by nothing, call the most): ${s.entrySymbols.length?s.entrySymbols.map(e=>`${e.name} (${e.path}${e.line?':'+e.line:''})`).join('; '):'none found'}\n- most connected symbols: ${s.top.slice(0,15).map(e=>`${e.name} (${e.path}${e.line?':'+e.line:''})`).join('; ')||'none'}`;
}

// The scan the watcher uses: the same project-worker adamanteum-cli uses, in a worker with a memory ceiling.
export function workerScan(directory,{cacheDir}){
 return new Promise((resolve,reject)=>{
  fs.mkdirSync(cacheDir,{recursive:true});
  const cacheFile=path.join(cacheDir,'cache-'+sha(directory).slice(0,12)+'.json');
  const worker=new Worker(new URL('./project-worker.mjs',import.meta.url),{workerData:{directory,cacheFile},resourceLimits:{maxOldGenerationSizeMb:512}});
  let result,error;
  worker.on('message',m=>{if(m.phase==='complete')result=m.result;if(m.phase==='error')error=Error(m.error);});
  worker.on('error',reject);
  worker.on('exit',()=>error?reject(error):result?resolve(result):reject(Error('Scan stopped before completion.')));
 });
}
