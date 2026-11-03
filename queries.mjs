import path from 'node:path';
import {frontmatter} from './vault-workspace.mjs';
import {advancedSearch,searchPlan} from './vault-search.mjs';
import {baseView} from './vault-views.mjs';
import {compileIgnore} from './obsidian-excluded.mjs';
import {searchExpression,nearest,resolver,targets as targetsOf} from './lib.mjs';
import {provenance} from './intelligence.mjs';
const fields='id,path,title,folder,category,degree,mtime,bytes';
const attachment=p=>! /\.(md|canvas|base)$/i.test(String(p));
function graphExtras(db,nodes,edges,input){
 const ids=new Set(nodes.map(n=>n.id));let next=-1;
 const add=(name,sources,tag)=>{const id=next--;nodes.push({id,path:name,title:name,folder:tag?'#tags':'',category:tag?'tag':'phantom',kind:tag?2:0,tag,phantom:tag?0:1,degree:sources.length,mtime:0,bytes:0});for(const source of sources)edges.push({source,target:id});};
 if(input.existing!=='1'&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='unresolved'").get()){
  const found=new Map();for(const r of db.prepare('SELECT source,name FROM unresolved ORDER BY name,source').iterate())if(ids.has(r.source)){if(!found.has(r.name))found.set(r.name,[]);found.get(r.name).push(r.source);}for(const [name,sources] of found)add(name,sources,false);
 }
 if(input.tags==='1'){
  const found=new Map();for(const r of db.prepare('SELECT id,tags FROM doc_metadata ORDER BY id').iterate())if(ids.has(r.id)){let tags=[];try{tags=JSON.parse(r.tags);}catch{}for(const tag of new Set(tags))if(typeof tag==='string'&&tag){if(!found.has(tag))found.set(tag,[]);found.get(tag).push(r.id);}}
  for(const [tag,sources] of [...found].sort(([a],[b])=>a.localeCompare(b)))add('#'+tag,sources,true);
 }
}
const totals=new WeakMap();
function documentCount(db){
 const version=db.prepare('PRAGMA data_version').get().data_version,cached=totals.get(db);
 if(cached?.version===version)return cached.total;
 const total=Number(db.prepare('SELECT count(*) n FROM docs').get().n);totals.set(db,{version,total});return total;
}
// One link target -> one document, without loading every path (works on a 220,000-note index).
function resolveLink(db,source,target){
 const key=String(target).replaceAll('\\','/').replace(/\.md$/i,'').replace(/^\/+/,'').trim();if(!key)return null;
 const relative=path.posix.normalize(path.posix.join(path.posix.dirname(source||''),key));
 for(const candidate of (key.includes('/')?[relative,key]:[key])){const row=db.prepare('SELECT id,path FROM docs WHERE path IN (?,?,?)').get(candidate+'.md',candidate,candidate+'.canvas');if(row)return row;}
 const name=path.posix.basename(key).toLowerCase().replace(/[\\%_]/g,'\\$&');
 const matches=db.prepare("SELECT id,path FROM docs WHERE lower(path)=? OR lower(path)=? OR lower(path) LIKE ? ESCAPE '\\' OR lower(path) LIKE ? ESCAPE '\\' LIMIT 200").all(name+'.md',name,'%/'+name+'.md','%/'+name);
 if(matches.length){const best=nearest(source||'',matches.map(m=>m.path));return best?matches.find(m=>m.path===best):null;}
 return db.prepare("SELECT d.id,d.path FROM doc_metadata m JOIN docs d ON d.id=m.id WHERE m.properties LIKE '%alias%' AND EXISTS(SELECT 1 FROM json_each(m.properties) p WHERE p.key IN ('aliases','alias') AND (lower(CAST(p.value AS TEXT))=lower(?) OR EXISTS(SELECT 1 FROM json_each(CASE WHEN p.type='array' THEN p.value ELSE '[]' END) v WHERE lower(CAST(v.value AS TEXT))=lower(?)))) LIMIT 1").get(key,key)||null;
}
export function queryVault(db,kind,input={}){
 const scope=['records','generated','archive'].includes(input.scope)?input.scope:'records',folder=input.folder||null;
 if(kind==='search'){
  const query=String(input.q||'').trim().slice(0,500),expression=searchExpression(query),args=folder?[scope,folder]:[scope],where=folder?' AND folder=?':'';
  const rawOffset=Number(input.offset||0),offset=Number.isSafeInteger(rawOffset)&&rawOffset>=0?rawOffset:0;
  const plan=searchPlan(query);
  if(plan.groups.length>1||plan.groups.some(g=>g.filters.length||g.terms.some(t=>t.negative||t.phrase)))return advancedSearch(db,query,scope,folder,offset);
  if(!expression)return db.prepare(`SELECT ${fields} FROM docs WHERE category=?${where} ORDER BY mtime DESC,id LIMIT 80 OFFSET ?`).all(...args,offset);
  const escaped=query.toLowerCase().replace(/[\\%_]/g,'\\$&'),filename=/\.md$/i.test(query)?query.toLowerCase():query.toLowerCase()+'.md',exact=filename.replace(/[\\%_]/g,'\\$&');
  // FIVE1 (owner 20:04, "handoff 2026-10-26" must list every handoff of that day): with two or more words, a note whose PATH holds every word comes first, newest first.
  const words=[...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))],pathAll=words.length>1&&words.length<=16?words.map(()=>"instr(lower(path),?)>0").join(' AND '):'';
  const pathUnion=pathAll?` UNION ALL SELECT id,-5e8 score FROM docs WHERE category=?${where} AND ${pathAll}`:'';
  return db.prepare(`WITH matches AS (
   SELECT rowid id,rank score FROM search WHERE search MATCH ?
   UNION ALL SELECT id,CASE WHEN lower(path)=? OR lower(path) LIKE ? ESCAPE '\\' THEN -1e9 ELSE -1e8 END score
    FROM docs WHERE category=?${where} AND lower(path) LIKE ? ESCAPE '\\'${pathUnion}
  ) SELECT ${fields.split(',').map(f=>'d.'+f).join(',')} FROM docs d
   JOIN (SELECT id,min(score) score FROM matches GROUP BY id) m ON d.id=m.id
   WHERE category=?${where} ORDER BY m.score,CASE WHEN m.score=-5e8 THEN -d.mtime ELSE d.id END,d.id LIMIT 80 OFFSET ?`).all(expression,filename,'%/'+exact,...args,'%'+escaped+'%',...(pathAll?[...args,...words]:[]),...args,offset);
 }
 // FIVE1: the offline copy was built on the door's own thread (30 MB, 11 s with every other request waiting); a query worker builds it now.
 if(kind==='counts')return {n:Number(db.prepare('SELECT count(*) n FROM docs').get().n),cats:db.prepare('SELECT category,count(*) count FROM docs GROUP BY category').all()};
 if(kind==='offlineindex'){const docs=db.prepare('SELECT id,path,title,folder,category,mtime,bytes,degree,substr(body,1,8000) AS body FROM docs ORDER BY mtime DESC LIMIT 8000').all();return {saved:true,generated:new Date().toISOString(),documents:docs.length,docs};}
 if(kind==='groups')return db.prepare('SELECT folder,count(*) count FROM docs WHERE category=? GROUP BY folder ORDER BY count DESC').all(scope);
 if(kind==='doc'){
  const doc=db.prepare('SELECT * FROM docs WHERE id=?').get(Number(input.id));
  if(!doc)return null;
  const connections=db.prepare(`SELECT ${fields.split(',').map(f=>'d.'+f).join(',')},e.source=? AS outgoing FROM edges e JOIN docs d ON d.id=CASE WHEN e.source=? THEN e.target ELSE e.source END WHERE e.source=? OR e.target=? ORDER BY d.degree DESC LIMIT 100`).all(doc.id,doc.id,doc.id,doc.id);
  const note=/\.canvas$/i.test(doc.path)?{properties:{},body:doc.body}:frontmatter(doc.body),tags=(()=>{try{return JSON.parse(db.prepare('SELECT tags FROM doc_metadata WHERE id=?').get(doc.id)?.tags||'[]');}catch{return [];}})();
  return {...doc,properties:note.properties,renderBody:note.body,frontmatterError:note.error||null,tags,connections,provenance:provenance(doc)};
 }
 if(kind==='graph'){
  const limit=Math.max(30,Math.min(5000,Number(input.limit)||500)),focus=Number(input.focus)||null;
  let nodes=focus?db.prepare(`SELECT ${fields} FROM docs WHERE id=? OR id IN (SELECT target FROM edges WHERE source=? UNION SELECT source FROM edges WHERE target=?) ORDER BY (id=?) DESC,degree DESC LIMIT ?`).all(focus,focus,focus,focus,limit):
   db.prepare(`SELECT ${fields} FROM docs WHERE category=? ${folder?'AND folder=?':''} ORDER BY degree DESC,mtime DESC LIMIT ?`).all(...(folder?[scope,folder,limit]:[scope,limit]));
  nodes=nodes.filter(n=>input.attachments!=='0'||!attachment(n.path)).map(n=>({...n,kind:attachment(n.path)?1:0,attachment:attachment(n.path)}));
  const ids=new Set(nodes.map(n=>n.id)),edges=[],statement=db.prepare('SELECT source,target FROM edges WHERE source=?');
  for(const n of nodes)for(const edge of statement.all(n.id))if(ids.has(edge.target))edges.push(edge);
  graphExtras(db,nodes,edges,input);
  return {nodes,edges,scope,focus,total:documentCount(db),limit};
 }
 if(kind==='graphfull'||kind==='graphtitles'){
  const rows=(input.scope==='all'?db.prepare('SELECT id,title,folder,mtime,path,category FROM docs ORDER BY id').all():db.prepare('SELECT id,title,folder,mtime,path,category FROM docs WHERE category=? ORDER BY id').all(scope)).filter(r=>input.attachments!=='0'||!attachment(r.path)),links=[];
  graphExtras(db,rows,links,input);
  if(kind==='graphtitles')return rows.map(r=>r.tag?r.title:String(r.title||r.path||'').replace(/\.md$/i,'').slice(0,80));
  const at=new Map(),folders=[],folderAt=new Map(),n=rows.length,ids=[],fold=[],mtime=[],kinds=[],phantom=[],degree=new Array(n).fill(0);
  rows.forEach((r,i)=>{at.set(r.id,i);ids[i]=r.id;if(!folderAt.has(r.folder)){folderAt.set(r.folder,folders.length);folders.push(r.folder);}fold[i]=folderAt.get(r.folder);mtime[i]=Math.floor((r.mtime||0)/1000);kinds[i]=r.kind??(attachment(r.path)?1:0);phantom[i]=r.phantom||0;});
  const edges=[],seen=new Set(),add=e=>{const a=at.get(e.source),b=at.get(e.target);if(a===undefined||b===undefined||a===b)return;const key=a<b?a*n+b:b*n+a;if(seen.has(key))return;seen.add(key);edges.push(a,b);degree[a]++;degree[b]++;};
  for(const e of db.prepare('SELECT source,target FROM edges').iterate())add(e);for(const e of links)add(e);
  // ADAMLOOK3 (owner 16:34, "that's a lot of orange"): the generated GRAPHIFY code-map notes get a key of their own so the atlas can colour them by program and draw them quieter
  // than real records. A per-program export is keyed by its program; the one big flat export is keyed by the code community its note links to; anything else is 'main'.
  const GEN_MAIN=/^GRAPHIFY-EXPORT-DO-NOT-HAND-EDIT\//,GEN_PROG=/^GRAPHIFY-EXPORT-([^/]+?)(?:-DO-NOT-HAND-EDIT|-SHARED-SUBSET)\//;
  const genAt=new Array(n).fill(0),genPrograms=[],genIndex=new Map(),genKey=k=>{let g=genIndex.get(k);if(!g){genPrograms.push(k);g=genPrograms.length;genIndex.set(k,g);}return g;};
  const mainGen=new Uint8Array(n),hubNote=new Uint8Array(n);rows.forEach((r,i)=>{if(r.category==='generated'&&GEN_MAIN.test(r.path)){mainGen[i]=1;if(/\/_COMMUNITY_/.test(r.path))hubNote[i]=1;}});
  const hubOf=new Int32Array(n).fill(-1);for(let e=0;e<edges.length;e+=2){const a=edges[e],b=edges[e+1];if(hubNote[b]&&mainGen[a]&&hubOf[a]<0)hubOf[a]=b;else if(hubNote[a]&&mainGen[b]&&hubOf[b]<0)hubOf[b]=a;}
  rows.forEach((r,i)=>{if(r.category!=='generated')return;const pm=GEN_PROG.exec(r.path);if(pm){genAt[i]=genKey('prog:'+pm[1]);return;}if(mainGen[i]){const h=hubNote[i]?i:hubOf[i];genAt[i]=genKey(h>=0?'comm:'+String(rows[h].title||rows[h].path):'main');}});
  return {n,ids,degree,folder:fold,folders,mtime,kind:kinds,phantom,edges,links:edges.length/2,scope,gen:genAt,genPrograms};
 }
 if(kind==='tags')return db.prepare('SELECT t.value tag,count(*) count FROM doc_metadata m JOIN docs d ON d.id=m.id,json_each(m.tags) t WHERE d.category=? GROUP BY t.value ORDER BY count DESC,t.value LIMIT 2000').all(scope);
 if(kind==='properties')return db.prepare('SELECT p.key name,count(*) count,group_concat(DISTINCT p.type) types FROM doc_metadata m JOIN docs d ON d.id=m.id,json_each(m.properties) p WHERE d.category=? GROUP BY p.key ORDER BY count DESC,p.key LIMIT 500').all(scope);
 if(kind==='base'){
  const options={view:input.view,offset:input.offset,limit:input.pageSize};
  if(input.all){
   // A .base file opened by name: every Markdown note in the vault, minus Obsidian's Excluded files, like Obsidian's own table.
   const ignored=compileIgnore((()=>{try{return JSON.parse(input.ignore||'[]');}catch{return [];}})());
   const all=db.prepare("SELECT d.path,d.mtime,d.bytes,m.properties,m.tags FROM docs d JOIN doc_metadata m ON m.id=d.id WHERE d.path LIKE '%.md'").all().filter(r=>!ignored(String(r.path)));
   return baseView(all,JSON.parse(input.config||'{}'),{...options,maxRows:null});
  }
  const rows=db.prepare(`SELECT d.path,d.mtime,d.bytes,m.properties,m.tags FROM docs d JOIN doc_metadata m ON m.id=d.id WHERE d.category=?${folder?' AND d.folder=?':''}`).all(...(folder?[scope,folder]:[scope]));
  return baseView(rows,JSON.parse(input.config||'{}'),options);
 }
 if(kind==='resolve')return resolveLink(db,input.source,input.target);
 if(kind==='changes'){
  const time=Date.parse(input.since);if(!Number.isFinite(time))throw Error('Choose an ISO date');
  const rows=db.prepare('SELECT path,mtime FROM docs WHERE category=? AND mtime>? ORDER BY mtime DESC LIMIT 500').all(scope,time);
  const total=Number(db.prepare('SELECT count(*) n FROM docs WHERE category=? AND mtime>?').get(scope,time).n);
  return {since:new Date(time).toISOString(),total,shown:rows.length,files:rows.map(r=>({path:r.path,mtime:r.mtime,when:new Date(r.mtime).toISOString()}))};
 }
 if(kind==='health'){
  const resolve=resolver(db.prepare('SELECT path FROM docs').all().map(r=>r.path)),broken=[],byName=new Map();let brokenTotal=0,notes=0,last=0;
  const batch=db.prepare("SELECT id,path,body FROM docs WHERE category=? AND id>? AND path LIKE '%.md' ORDER BY id LIMIT 400");
  for(;;){
   const rows=batch.all(scope,last);if(!rows.length)break;
   for(const r of rows){
    last=r.id;notes++;const name=r.path.split('/').pop().toLowerCase();if(!byName.has(name))byName.set(name,[]);byName.get(name).push(r.path);
    for(const t of targetsOf(r.body))if(!resolve(r.path,t)){brokenTotal++;if(broken.length<1000)broken.push({source:r.path,target:t});}
   }
  }
  const orphanSql="FROM docs d WHERE d.category=? AND d.path LIKE '%.md' AND NOT EXISTS(SELECT 1 FROM edges e WHERE e.target=d.id)";
  const orphanTotal=Number(db.prepare('SELECT count(*) n '+orphanSql).get(scope).n),orphans=db.prepare('SELECT d.path '+orphanSql+' ORDER BY d.mtime DESC LIMIT 1000').all(scope).map(r=>r.path);
  const duplicates=[...byName.values()].filter(v=>v.length>1);
  return {scope,summary:{notes,broken:brokenTotal,orphans:orphanTotal,duplicates:duplicates.length},broken,orphans,duplicates:duplicates.slice(0,500)};
 }
 throw Error('Unknown query.');
}
