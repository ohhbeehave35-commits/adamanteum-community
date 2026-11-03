import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ADAMCAP1: the vault is the source, the ring shows it. This reads the capability lists already written in Obsidian and turns them
// into one capability per program, each with the vault note it came from. Nothing here writes into the vault; the derived cache
// (capabilities.json per program) is rebuilt on every run, and the append-only CAPABILITIES ledger gets a new dated block only
// when the list for that program has actually changed.

export const LIST_SOURCE='Capabilities/Index.md';
// Tables with a "Capability" column: [source note, program name]. Each row is one capability and keeps the status word the table gives it.
export const TABLE_SOURCES=Object.freeze([]);
export const MAX_TEXT=220;
// Planet notes: an optional note lists one planet's capabilities as lines "- [status] text || source-file:line"; sections that are not "Agent:" are the planet's capabilities; each "Agent:" section is one moon (see orb-sync).
// Each program planet is one note under Manual/. heading = the planet's "
export const PLANET_SOURCES=Object.freeze([]);
export const PLANET_SOURCE={path:'Capabilities/Agents.md',slug:'assistant',heading:'Assistant'};
export function parsePlanet(text,heading='Assistant'){
 const planet=[],agents=[];let cur=null;
 for(const [i,l] of String(text).split(/\r?\n/).entries()){
  const h=/^##\s+(.+?)\s*$/.exec(l);
  if(h&&!l.startsWith('###')){const a=/^Agent:\s*(.+?)\s*(?:\(([^)]+)\))?$/.exec(h[1]);if(a){cur={name:a[1],key:a[2]||a[1],items:[]};agents.push(cur);}else cur=h[1].toLowerCase()===String(heading).toLowerCase()?{planet:true}:null;continue;}
  const m=/^- \[([a-z-]+)\] (.+?) \|\| (.+?):(\d+)\s*$/.exec(l);if(!m||!cur)continue;
  const item={status:m[1],text:m[2].length>MAX_TEXT?m[2].slice(0,MAX_TEXT-1).replace(/\s+\S*$/,'')+'…':m[2],source:m[3],line:Number(m[4]),note:i+1};
  if(cur.planet)planet.push(item);else cur.items.push(item);
 }
 return {planet,agents};
}
export const MAX_NODES_PER_PROGRAM=400;

// Headings in the list that do not read like the program's own name. Anything not found here or by name goes to `unmapped`, never guessed.
export const HEADING_ALIASES=Object.freeze({});

export const sha=text=>crypto.createHash('sha256').update(String(text)).digest('hex');
export const normalText=t=>String(t).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const slashes=p=>String(p).replace(/\\/g,'/');
export const noteName=p=>slashes(p).replace(/\.md$/i,'');

function headingKey(h){
 let s=String(h).toLowerCase().replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
 if(HEADING_ALIASES[s])return HEADING_ALIASES[s];
 const colon=s.indexOf(':');if(colon>0){const head=s.slice(0,colon).trim();if(HEADING_ALIASES[head])return HEADING_ALIASES[head];s=head;}
 return s;
}

export function programIndex(programs){
 const byName=new Map();
 for(const p of programs){byName.set(p.name.toLowerCase(),p);for(const a of p.aliases||[])if(!byName.has(String(a).toLowerCase()))byName.set(String(a).toLowerCase(),p);}
 return byName;
}
export function programFor(heading,programs,index=programIndex(programs)){
 const key=headingKey(heading);
 const direct=index.get(key.toLowerCase());if(direct)return direct;
 const named=programs.find(p=>p.name.toLowerCase()===key.toLowerCase());
 return named||null;
}

export function cleanBullet(raw){
 let text=String(raw).replace(/<!--[\s\S]*?-->/g,' ').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/`([^`]+)`/g,'$1').replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g,(m,a,b)=>b||a).replace(/\s+/g,' ').trim();
 if(text.length>MAX_TEXT)text=text.slice(0,MAX_TEXT-1).replace(/\s+\S*$/,'')+'…';
 return text;
}

// The master list: "## Program" headings, "- capability" lines, "### Coming" for what is on its way. One line is one capability.
export function parseList(text,source=LIST_SOURCE){
 const out=[];let heading='',status='live';
 const lines=String(text).split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  const h=/^##\s+(.+?)\s*$/.exec(line);
  if(h&&!line.startsWith('###')){heading=h[1];status='live';continue;}
  if(/^###\s+coming\b/i.test(line)){status='coming';continue;}
  if(/^###\s+/.test(line)){status='live';continue;}
  if(/^#\s/.test(line)){heading='';continue;}
  const b=/^\s*[-*]\s+(.+)$/.exec(line);
  if(!b||!heading)continue;
  const t=cleanBullet(b[1]);
  if(t.length<8)continue;
  out.push({heading,status,text:t,source,line:i+1});
 }
 return out;
}

// Markdown tables whose first column is "Capability": each row is one capability; the status column's first word is kept.
export function parseTables(text,source,program){
 const out=[];const lines=String(text).split(/\r?\n/);let cols=null,section='';
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  const h=/^#{2,4}\s+(.+?)\s*$/.exec(line);if(h){section=h[1];cols=null;continue;}
  if(!line.startsWith('|')){if(cols&&!line.trim())cols=null;continue;}
  const cells=line.split('|').slice(1,-1).map(c=>c.trim());
  if(!cols){if(/^capability/i.test(cells[0]||'')){cols=cells.map(c=>c.toLowerCase());}continue;}
  if(cells.every(c=>/^:?-{2,}:?$/.test(c)))continue;
  const t=cleanBullet(cells[0]||'');if(t.length<2)continue;
  const si=cols.indexOf('status'),status=si>=0?(cells[si]||'').split(/[\s,(]/)[0].toLowerCase():'listed';
  out.push({heading:program,status:status||'listed',text:t,source,line:i+1,section});
 }
 return out;
}

// Programs the master list says nothing about get their capabilities from the vault's own per-program sections and requirement notes.
// Section sources: a "### Heading" in a note, and its table rows whose status says PROVEN. Bullet sources: the list items of a short requirement note.
export const SECTION_SOURCES=Object.freeze([]);
export const BULLET_SOURCES=Object.freeze([]);
// Bullets under "Also in the family" belong to the program they describe; a bullet with no program (DocumentReader says the records claim no capability) is excused, never placed.
export const FAMILY_ROUTES=Object.freeze([]);

const escapeRx=t=>String(t).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function parseSection(text,source,section,program){
 const lines=String(text).split(/\r?\n/);
 const start=lines.findIndex(l=>new RegExp('^###\\s+'+escapeRx(section)+'\\s*$','i').test(l));
 if(start<0)return [];
 let end=lines.length;for(let i=start+1;i<lines.length;i++)if(/^#{1,3}\s/.test(lines[i])){end=i;break;}
 return parseTables(lines.slice(start,end).join('\n'),source,program)
  .map(r=>({...r,line:r.line+start}))
  .filter(r=>/^proven/.test(r.status)).map(r=>({...r,status:'live',section}));
}
export function parseBullets(text,source,program,{max=12}={}){
 const out=[];
 for(const [i,l] of String(text).split(/\r?\n/).entries()){
  const b=/^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(l);if(!b)continue;
  const t=cleanBullet(b[1]);if(t.length<30)continue;
  out.push({heading:program,status:'required',text:t,source,line:i+1});if(out.length>=max)break;
 }
 return out;
}

// Group, drop empties and duplicates (same words in the same program), cap the nodes drawn, keep the true total.
export function buildMap({listText,tables=[],extras=[],programs,listSource=LIST_SOURCE}){
 const index=programIndex(programs),byProgram=new Map(),unmappedCount=new Map(),excused=[];let dupes=0,total=0;
 const add=(p,c)=>{
  const bucket=byProgram.get(p.slug)||{program:p,items:[],seen:new Set()};byProgram.set(p.slug,bucket);
  const key=normalText(c.text);if(!key){return;}
  if(bucket.seen.has(key)){dupes++;return;}
  bucket.seen.add(key);total++;
  bucket.items.push({id:sha(p.slug+'|'+key).slice(0,12),text:c.text,status:c.status,source:noteName(c.source),line:c.line,heading:c.heading,section:c.section||''});
 };
 if(listText!=null)for(const c of parseList(listText,listSource)){
  let p=programFor(c.heading,programs,index);
  if(/^also in the family$/i.test(c.heading)){const route=FAMILY_ROUTES.find(([rx])=>rx.test(c.text));p=route?programFor(route[1],programs,index):null;if(!p){excused.push({heading:c.heading,text:c.text});continue;}}
  if(!p){unmappedCount.set(c.heading,(unmappedCount.get(c.heading)||0)+1);continue;}
  add(p,c);
 }
 for(const c of extras){
  const p=c.slug?programs.find(x=>x.slug.toLowerCase()===c.slug):programFor(c.heading,programs,index);
  if(!p){unmappedCount.set(c.heading,(unmappedCount.get(c.heading)||0)+1);continue;}
  add(p,c);
 }
 for(const t of tables){
  const p=programFor(t.program,programs,index);
  if(!p){unmappedCount.set(t.program,(unmappedCount.get(t.program)||0)+1);continue;}
  for(const c of parseTables(t.text,t.path,t.program))add(p,c);
 }
 const result={programs:{},unmapped:[...unmappedCount].map(([heading,count])=>({heading,count})),excused,dupes,total};
 for(const [slug,b] of byProgram)result.programs[slug]={name:b.program.name,count:b.items.length,items:b.items};
 return result;
}

export function ledgerBlock({name,items,stamp,hash}){
 const sources=[...new Set(items.map(i=>i.source))];
 const lines=[`## ${stamp} · capabilities from the vault, ${items.length} listed, version ${hash.slice(0,8)}`,`Sources: ${sources.map(s=>`[[${s}]]`).join(', ')}`,''];
 for(const i of items)lines.push(`- (${i.status}) ${i.text} — [[${i.source}]]`);
 return lines.join('\n');
}

export function readSources(vault){
 const read=rel=>{try{const abs=path.join(vault,rel);const st=fs.statSync(abs);if(st.size>8*1024*1024)return null;return {text:fs.readFileSync(abs,'utf8'),mtimeMs:st.mtimeMs};}catch{return null;}};
 const list=read(LIST_SOURCE);
 const tables=[];for(const t of TABLE_SOURCES){const r=read(t.path);if(r)tables.push({...t,text:r.text});}
 const extras=[];
 const cache=new Map(),get=rel=>{if(!cache.has(rel))cache.set(rel,read(rel));return cache.get(rel);};
 for(const t of SECTION_SOURCES){const r=get(t.path);if(r)extras.push(...parseSection(r.text,t.path,t.section,t.program));}
 for(const t of BULLET_SOURCES){const r=get(t.path);if(r)extras.push(...parseBullets(r.text,t.path,t.program));}
 for(const ps of PLANET_SOURCES){const planet=get(ps.path);
  if(planet)extras.push(...parsePlanet(planet.text,ps.heading).planet.map(i=>({heading:ps.heading,slug:ps.slug,status:i.status,text:i.text,source:i.source,line:i.line})));}
 const stamp=[list?.mtimeMs,...tables.map(t=>t.text.length),...[...cache.values()].map(r=>r?r.mtimeMs:0)].join('|');
 return {list,tables,extras,signature:sha(stamp).slice(0,16)};
}

// Rebuild the map, rewrite each program's derived capabilities.json, and append to its ledger only when its list changed.
export function syncCapabilities({vault,dataRoot,programs,ledgers,stamp,state=null}){
 const src=readSources(vault);
 if(!src.list&&!src.tables.length&&!src.extras.length)return {ok:false,reason:'No capability list found in the vault at '+LIST_SOURCE,programs:{},unmapped:[],total:0,written:0};
 const map=buildMap({listText:src.list?.text??null,tables:src.tables,extras:src.extras,programs});
 let written=0,unchanged=0;const perProgram={};
 for(const p of programs){
  const entry=map.programs[p.slug];
  const dir=path.join(dataRoot,'programs',p.slug);fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'capabilities.json');
  const items=entry?.items||[];
  perProgram[p.slug]={name:p.name,count:items.length};
  const tmp=file+'.next';fs.writeFileSync(tmp,JSON.stringify({schema:'adamanteum.capabilities/v1',program:p.name,count:items.length,items}));fs.renameSync(tmp,file);
  if(!items.length)continue;
  const hash=sha(items.map(i=>i.id+i.status).join('|'));
  const r=ledgers.append(p,'CAPABILITIES',ledgerBlock({name:p.name,items,stamp,hash}),{dedupeKey:'capmap|'+hash});
  if(r.written)written++;else unchanged++;
 }
 return {ok:true,programs:perProgram,unmapped:map.unmapped,excused:map.excused,dupes:map.dupes,total:map.total,written,unchanged,signature:src.signature};
}

export function loadCapabilities(dataRoot,slug){
 try{const j=JSON.parse(fs.readFileSync(path.join(dataRoot,'programs',slug,'capabilities.json'),'utf8'));return Array.isArray(j.items)?j.items:[];}catch{return [];}
}
