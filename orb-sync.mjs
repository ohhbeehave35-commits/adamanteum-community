import fs from 'node:fs';
import path from 'node:path';
import {sha,noteName,programIndex,programFor,normalText,PLANET_SOURCE,parsePlanet} from './capability-sync.mjs';

// ADAMCAP4: orbs for adapters, connectors and extensions, built from the vault the same way the program capabilities are. Three sources:
//  - the orb registry note (a line per orb, edited in Obsidian),
//  - the export cards table (every tool card is a connector),
//  - the skill index (every skill group is an extension),
// plus the trade table for the trade list. Nothing here writes into the vault. An orb whose note is not in the vault is kept and marked,
// never silently dropped.

export const REGISTRY='Orbs/Registry.md';
export const EXPORT_PATHS='Orbs/Exports.md';
export const SKILL_DIR='Orbs/Skills';
export const TRADES_NOTE='Orbs/Trades.md';
export const FAMILIES=Object.freeze(['adapter','connector','extension']);
export const FAMILY_LABEL=Object.freeze({adapter:'Adapters',connector:'Connectors',extension:'Extensions'});
export const MAX_MEMBER_NODES=60;

const list=v=>String(v||'').split(',').map(s=>s.trim()).filter(Boolean);
const slugify=t=>String(t).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const titleCase=s=>String(s).replace(/[-_]+/g,' ').replace(/\b[a-z]/g,c=>c.toUpperCase());

export function parseRegistry(text){
 const out={adapter:[],connector:[],extension:[],categories:new Map()};
 let mode=null;
 for(const line of String(text).split(/\r?\n/)){
  const h=/^##\s+(.+?)\s*$/.exec(line);
  if(h){const t=h[1].toLowerCase();mode=t.startsWith('adapters')?'adapter':t.startsWith('connectors')?'connector':t.startsWith('extensions')?'extension':t.startsWith('categories')?'categories':null;continue;}
  const b=/^\s*-\s+(.+)$/.exec(line);if(!b||!mode)continue;
  const parts=b[1].split(' :: ').map(s=>s.trim());
  if(mode==='categories'){
   if(parts.length<3)continue;
   const programs=list(parts.find(p=>/^programs\s/i.test(p))?.replace(/^programs\s+/i,'')),trades=list(parts.find(p=>/^trades\s/i.test(p))?.replace(/^trades\s+/i,''));
   out.categories.set(parts[0].toLowerCase(),{programs,trades});continue;
  }
  if(parts.length<5)continue;
  const [name,category,trades,programs,note]=parts;
  out[mode].push({name,category,trades:/^all$/i.test(trades)?['all']:list(trades),programs:list(programs),note:noteName(note.replace(/^\[\[|\]\]$/g,'')).replace(/\.md$/i,'')+'',noteFile:note.replace(/^\[\[|\]\]$/g,'').replace(/\\/g,'/')});
 }
 return out;
}

// "| [[Integrations/Export-Cards/jobber]] | Field service | Jobs/clients/invoices | CSV |"
export function parseExportCards(text){
 const rows=[];
 for(const line of String(text).split(/\r?\n/)){
  const m=/^\|\s*\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
  if(!m)continue;
  rows.push({note:m[1].trim(),slug:path.posix.basename(m[1].trim()),category:m[2].trim(),exports:m[3].trim(),format:m[4].trim()});
 }
 return rows;
}

// A skill group file: "# 01. Sales and customers (49 skills; owner: Assistant) ..." and rows with Skill("plugin:skill").
export function parseSkillGroup(text,file){
 const head=/^#\s+(?:\d+\.\s+)?(.+?)\s*(?:\((\d+)\s+skills?;?\s*(?:owner:\s*([^)]+))?\))?(?:\s+-\s+built.*)?$/m.exec(String(text));
 const skills=[...String(text).matchAll(/^\|\s*`Skill\("([^"]+)"\)`\s*\|\s*([^|]*?)\s*\|/gm)].map(m=>({name:m[1],use:m[2]}));
 if(!head||!skills.length)return null;
 return {file,title:head[1].replace(/\s*\(.*$/,'').trim(),declared:head[2]?Number(head[2]):null,owner:(head[3]||'').trim(),skills};
}

export function parseTrades(text){
 const names=[];let inTable=false;
 for(const line of String(text).split(/\r?\n/)){
  if(/^\|\s*trade\s*\|\s*people/i.test(line)){inTable=true;continue;}
  if(inTable){if(!line.startsWith('|')){if(names.length)break;continue;}const c=line.split('|').slice(1,-1).map(s=>s.trim());if(/^:?-+:?$/.test(c[0]))continue;if(c[0])names.push(c[0]);}
 }
 return names;
}

const OWNERS={};

export function buildOrbs({registryText,exportText,skillGroups=[],agentGroups=[],tradesText,programs,capabilityTexts={},exists=()=>true,readCardTitle=()=>null,noteText=()=>''}){
 const index=programIndex(programs),reg=parseRegistry(registryText||''),trades=parseTrades(tradesText||''),orbs=[];
 const usedBy=name=>{
  const n=String(name).trim();if(n.length<4)return [];
  const rx=new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\p{L}\\p{N}])`,'iu'),found=[];
  for(const [slug,texts] of Object.entries(capabilityTexts)){if(texts.some(t=>rx.test(t)))found.push(slug);}
  return found;
 };
 const resolvePrograms=(names,auto=[])=>{
  const slugs=new Set(auto);
  for(const n of names){const p=programFor(n,programs,index);if(p)slugs.add(p.slug);}
  return [...slugs].sort().map(slug=>programs.find(p=>p.slug===slug)).filter(Boolean).map(p=>p.name);
 };
 const push=o=>{
  const note=o.note?String(o.note):'';
  orbs.push({id:`${o.family}:${slugify(o.name)}`,family:o.family,name:o.name,category:o.category||'Other',trades:o.trades?.length?o.trades:['all'],programs:o.programs||[],note,noteMissing:!!note&&!exists(note),count:o.count??(o.programs?.length||0),members:o.members||[],source:o.source||REGISTRY.replace(/\.md$/,'')});
 };
 for(const family of FAMILIES){
  for(const r of reg[family]){
   const file=r.noteFile.replace(/\.md$/i,'');
   push({family,name:r.name,category:r.category,trades:r.trades[0]==='all'?['all']:r.trades,programs:resolvePrograms(r.programs,usedBy(r.name)),note:file,
    members:family==='extension'&&/trade word sets/i.test(r.category)?trades.map(t=>({text:t})):[],count:family==='extension'&&/trade word sets/i.test(r.category)?trades.length:undefined});
  }
 }
 for(const c of parseExportCards(exportText||'')){
  const cat=reg.categories.get(c.category.toLowerCase())||{programs:[],trades:[]};
  const title=readCardTitle(c.note)||titleCase(c.slug);
  push({family:'connector',name:title,category:c.category,trades:cat.trades.length?cat.trades:['all'],programs:resolvePrograms(cat.programs,usedBy(title)),note:c.note,source:EXPORT_PATHS.replace(/\.md$/,''),
   members:[{text:`Exports ${c.exports}`},{text:`Format ${c.format}`}],count:undefined});
 }
// The assistant is its own planet; the skill groups it owns belong to that planet as well as to the project.
 const assistant=programs.find(p=>p.slug.toLowerCase()===PLANET_SOURCE.slug);
 for(const g of skillGroups){
  const owner=OWNERS[g.owner.toLowerCase()]||g.owner,prog=owner?[owner]:[];
  const linked=resolvePrograms(prog);if(assistant&&/^assistant$/i.test(g.owner)&&!linked.includes(assistant.name))linked.push(assistant.name);
  push({family:'extension',name:`Skills: ${g.title}`,category:'Skills',trades:['all'],programs:linked,note:noteName(g.file),source:noteName(g.file),members:g.skills.map(s=>({text:s.name+' - '+s.use})),count:g.skills.length});
 }
 // One moon per agent of hers: an extension orb whose members are that agent's own skills and capabilities, each line from its source file.
 for(const a of agentGroups){
  if(!assistant)break;
  push({family:'extension',name:`Agent: ${a.name}`,category:'Assistant agents',trades:['all'],programs:[assistant.name],note:noteName(PLANET_SOURCE.path),source:noteName(PLANET_SOURCE.path),members:a.items.map(i=>({text:`[${i.status}] ${i.text}`,source:i.source,line:i.line})),count:a.items.length});
 }
 // one orb per name and family; the first (registry before cards) wins
 // Where each program link comes from: a capability line of that program names the orb, or the orb's own note names the program, or it is the
 // owner a skill group file names; anything else is a proposal from the registry and is marked so.
 const slugOf=Object.fromEntries(programs.map(p=>[p.name,p.slug]));
 for(const o of orbs){
  const text=String(noteText(o.note)||'').toLowerCase(),key=o.name.toLowerCase();o.evidence={};
  for(const prog of o.programs){
   const viaCapability=(capabilityTexts[slugOf[prog]]||[]).some(t=>t.toLowerCase().includes(key)),viaNote=text.includes(prog.toLowerCase());
   o.evidence[prog]=viaCapability?'capability line':viaNote?'its note':(o.family==='extension'&&/^skills:/i.test(o.name))?'skill group owner':'proposed';
  }
 }
 const seen=new Set(),out=[];
 for(const o of orbs){const k=o.family+'|'+normalText(o.name);if(seen.has(k))continue;seen.add(k);out.push(o);}
 for(const o of out){if(o.count===undefined||o.count===null)o.count=o.programs.length||o.members.length||1;}
 out.sort((a,b)=>FAMILIES.indexOf(a.family)-FAMILIES.indexOf(b.family)||a.name.localeCompare(b.name));
 return {orbs:out,trades,counts:Object.fromEntries(FAMILIES.map(f=>[f,out.filter(o=>o.family===f).length]))};
}

export function readOrbSources(vault){
 const read=rel=>{try{const abs=path.join(vault,rel);const st=fs.statSync(abs);if(st.size>8*1024*1024)return null;return {text:fs.readFileSync(abs,'utf8'),mtimeMs:st.mtimeMs};}catch{return null;}};
 const registry=read(REGISTRY),exp=read(EXPORT_PATHS),trades=read(TRADES_NOTE);
 const skillGroups=[];
 try{for(const f of fs.readdirSync(path.join(vault,SKILL_DIR)).filter(f=>/^\d\d-.+\.md$/.test(f)).sort()){const r=read(SKILL_DIR+'/'+f);if(!r)continue;const g=parseSkillGroup(r.text,SKILL_DIR+'/'+f);if(g)skillGroups.push(g);}}catch{}
 const planet=read(PLANET_SOURCE.path),agentGroups=planet?parsePlanet(planet.text).agents:[];
 const signature=sha([registry?.mtimeMs,exp?.mtimeMs,trades?.mtimeMs,planet?.mtimeMs,skillGroups.map(g=>g.file+g.skills.length).join(',')].join('|')).slice(0,16);
 return {registryText:registry?.text,exportText:exp?.text,tradesText:trades?.text,skillGroups,agentGroups,signature};
}

export function syncOrbs({vault,dataRoot,programs,capabilityTexts}){
 const src=readOrbSources(vault);
 if(!src.registryText&&!src.exportText&&!src.skillGroups.length&&!src.agentGroups.length)return {ok:false,reason:'No orb registry, export cards or skill index in the vault',orbs:[],counts:{}};
 const exists=rel=>{try{return fs.existsSync(path.join(vault,rel.endsWith('.md')||/\.[a-z0-9]{2,4}$/i.test(rel)?rel:rel+'.md'));}catch{return false;}};
 const readCardTitle=rel=>{try{const t=fs.readFileSync(path.join(vault,rel+'.md'),'utf8');const m=/^#\s+(.+?)\s*$/m.exec(t);return m?m[1].replace(/^export card\s*[—:-]+\s*/i,'').replace(/\s*[—(:].*$/,'').trim():null;}catch{return null;}};
 const noteText=rel=>{for(const f of [rel+'.md',rel]){try{return fs.readFileSync(path.join(vault,f),'utf8');}catch{}}return '';};
 const built=buildOrbs({...src,programs,capabilityTexts,exists,readCardTitle,noteText});
 const dir=path.join(dataRoot,'orbs');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'orbs.json'),tmp=file+'.next';
 fs.writeFileSync(tmp,JSON.stringify({schema:'adamanteum.orbs/v1',at:new Date().toISOString(),...built}));fs.renameSync(tmp,file);
 return {ok:true,signature:src.signature,counts:built.counts,total:built.orbs.length,missingNotes:built.orbs.filter(o=>o.noteMissing).map(o=>({name:o.name,note:o.note})),trades:built.trades.length};
}

export function loadOrbs(dataRoot){
 try{const j=JSON.parse(fs.readFileSync(path.join(dataRoot,'orbs','orbs.json'),'utf8'));return {orbs:Array.isArray(j.orbs)?j.orbs:[],trades:j.trades||[],counts:j.counts||{}};}catch{return {orbs:[],trades:[],counts:{}};}
}

// The index: filter by kind, trade, category and program; the text query looks in names, categories, programs and members.
export function filterOrbs(orbs,{kind='',trade='',category='',program='',q=''}={}){
 const t=String(q||'').trim().toLowerCase();
 return orbs.filter(o=>(!kind||o.family===kind)&&(!trade||o.trades.includes('all')||o.trades.some(x=>x.toLowerCase()===String(trade).toLowerCase()))&&(!category||o.category.toLowerCase()===String(category).toLowerCase())&&(!program||o.programs.some(p=>p.toLowerCase()===String(program).toLowerCase()))
  &&(!t||[o.name,o.category,...o.programs,...o.trades,...o.members.map(m=>m.text)].some(s=>String(s).toLowerCase().includes(t))));
}
export function facets(orbs,trades=[]){
 const tally=f=>{const m=new Map();for(const o of orbs)for(const v of f(o))m.set(v,(m.get(v)||0)+1);return [...m].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([name,count])=>({name,count}));};
 return {kinds:FAMILIES.map(f=>({name:f,label:FAMILY_LABEL[f],count:orbs.filter(o=>o.family===f).length})),categories:tally(o=>[o.category]),programs:tally(o=>o.programs),trades:trades.map(t=>({name:t,count:orbs.filter(o=>o.trades.includes('all')||o.trades.includes(t)).length}))};
}
