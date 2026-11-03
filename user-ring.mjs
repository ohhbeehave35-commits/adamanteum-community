import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ADAMCAP4: "Pin to the ring". A person can put any note, folder or tag on the ring as an island of their own, and take it off again.
// Nothing is moved, copied or deleted in the vault: the pin is a small list kept beside the index (user-ring.json), and taking an island off
// just stops drawing it as one, so its notes are back in the graph. A fresh vault starts with an empty list.

export const KINDS=Object.freeze(['note','folder','tag']);
export const MAX_ISLANDS=40;
export const MAX_MEMBERS=400;
const clean=(v,max)=>String(v??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max);

export class UserRing{
 constructor(file){this.file=file;this.items=this.read();}
 read(){try{const j=JSON.parse(fs.readFileSync(this.file,'utf8'));return Array.isArray(j.items)?j.items.filter(i=>i&&KINDS.includes(i.kind)&&i.ref):[];}catch{return [];}}
 save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.next';fs.writeFileSync(tmp,JSON.stringify({schema:'adamanteum.user-ring/v1',items:this.items}));fs.renameSync(tmp,this.file);}
 list(){return this.items.map(i=>({...i}));}
 idFor(kind,ref){return crypto.createHash('sha256').update(kind+'|'+ref.toLowerCase()).digest('hex').slice(0,10);}
 add({kind,ref,name}){
  if(!KINDS.includes(kind))throw Error('Pin a note, a folder or a tag.');
  let r=clean(ref,300).replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');if(kind==='tag')r=r.replace(/^#/,'');
  if(!r)throw Error('Nothing to pin.');
  const id=this.idFor(kind,r),found=this.items.find(i=>i.id===id);
  if(found)return {...found,already:true};
  if(this.items.length>=MAX_ISLANDS)throw Error(`The ring holds up to ${MAX_ISLANDS} of your own islands. Remove one first.`);
  const item={id,kind,ref:r,name:clean(name,80)||(kind==='tag'?'#'+r:path.posix.basename(r).replace(/\.md$/i,'')),at:new Date().toISOString()};
  this.items.push(item);this.save();return {...item};
 }
 remove(id){const n=this.items.length;this.items=this.items.filter(i=>i.id!==String(id));if(this.items.length!==n)this.save();return n-this.items.length;}
}

// The notes an island holds: the note itself, every note under the folder, or every note with the tag.
export function membersOf(db,item){
 const cap=MAX_MEMBERS;
 if(item.kind==='note'){const r=db.prepare('SELECT id FROM docs WHERE path=? OR path=?').get(item.ref,item.ref+'.md');return r?[r.id]:[];}
 if(item.kind==='folder'){const like=item.ref.replace(/[\\%_]/g,m=>'\\'+m)+'/%';return db.prepare("SELECT id FROM docs WHERE path LIKE ? ESCAPE '\\' ORDER BY id LIMIT ?").all(like,cap).map(r=>r.id);}
 const want=item.ref.toLowerCase(),out=[];
 for(const r of db.prepare('SELECT id,tags FROM doc_metadata WHERE tags LIKE ?').all('%'+item.ref.replace(/[%_]/g,'')+'%')){
  let tags=[];try{tags=JSON.parse(r.tags);}catch{tags=String(r.tags).split(/[,\s]+/);}
  if(tags.some(t=>String(t).replace(/^#/,'').toLowerCase()===want))out.push(r.id);if(out.length>=cap)break;
 }
 return out;
}

// What an island's notes say they can and cannot do, and what is done and open. Built from the notes' own words:
//   done  = checked tasks ("- [x]");  open = unchecked tasks ("- [ ]");
//   cannot = bullet or task lines that say so ("cannot", "can't", "not yet", "does not", "no longer", "never", "not live", "not connected");
//   can    = the other bullet lines that start with a capability word ("can", "does", "supports", "sends", "shows", ...) or carry a "built" mark.
const NEGATION=/\b(cannot|can't|can not|not yet|does not|doesn't|is not|isn't|no longer|never|not live|not connected|not landed|unable)\b/i;
const CAN=/^(?:\*\*)?\s*(?:can|does|supports?|lets?|sends?|shows?|reads?|writes?|keeps?|opens?|builds?|finds?|runs?|saves?|tracks?|makes?|gives?|takes?)\b/i;
export function summarizeNotes(items,{maxLines=12}={}){
 const out={notes:items.length,can:0,cannot:0,open:0,done:0,lines:{can:[],cannot:[],open:[],done:[]}};
 const push=(k,text,note)=>{out[k]++;if(out.lines[k].length<maxLines)out.lines[k].push({text:text.replace(/\s+/g,' ').slice(0,160),note});};
 for(const it of items){
  for(const raw of String(it.body||'').split(/\r?\n/)){
   const m=/^\s*[-*+]\s+(\[[ xX]\]\s+)?(.+)$/.exec(raw);if(!m)continue;
   const text=m[2].replace(/<!--[\s\S]*?-->/g,'').trim();if(text.length<6)continue;
   if(m[1]){if(/x/i.test(m[1]))push('done',text,it.path);else push('open',text,it.path);if(NEGATION.test(text))push('cannot',text,it.path);continue;}
   if(NEGATION.test(text)){push('cannot',text,it.path);continue;}
   if(CAN.test(text))push('can',text,it.path);
  }
 }
 return out;
}
