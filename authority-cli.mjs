import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {frontmatter,markdown} from './vault-workspace.mjs';
import {proposeLabel,renderBrief} from './authority.mjs';

const columns=['path','decision','sha256','current_authority','proposed_authority','proposed_status','reason'];
const header=columns.join('\t');
const utc=()=>new Date().toISOString().slice(0,10);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const result=text=>({__text:text+'\n'});
const refuse=(reason,line)=>{process.exitCode=3;return result(line||'authority: '+reason);};
const within=(candidate,root)=>candidate===root||candidate.startsWith(root+path.sep);
function directory(value){
 if(!path.isAbsolute(value)||!fs.existsSync(value)||!fs.statSync(value).isDirectory())return null;
 return fs.realpathSync(value);
}
function files(root){
 const out=[];
 const walk=relative=>{
  for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
   const next=relative?relative+'/'+entry.name:entry.name;
   if(entry.isDirectory()){if(!['node_modules','.git','_archive'].includes(entry.name))walk(next);}
   else if(entry.isFile()&&entry.name.endsWith('.md'))out.push(next);
  }
 };
 walk('');return out.sort();
}
function source(root,relative){
 if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))return null;
 const full=path.resolve(root,relative);
 if(!within(full,root))return null;
 let current=root;
 for(const part of relative.split(/[\\/]/)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())return null;}
 return full;
}
export async function run(args){
 const [command,...tokens]=args,required={propose:['vault','out'],apply:['vault','archive','sheet'],export:['vault','repo','out']}[command];
 const badArgs=()=>{process.exitCode=2;return result('authority: bad args');};
 if(!required||tokens.length!==required.length*2)return badArgs();
 const options={};
 for(let i=0;i<tokens.length;i+=2){const key=tokens[i].slice(2);if(!tokens[i].startsWith('--')||!required.includes(key)||Object.hasOwn(options,key)||!tokens[i+1])return badArgs();options[key]=tokens[i+1];}
 if(command==='export'&&!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.repo))return badArgs();
 const vault=directory(options.vault);
 if(!vault)return refuse('paths');
 let archive;
 if(command==='apply'){
  archive=directory(options.archive);
  if(!archive||within(vault,archive)||within(archive,vault))return refuse('paths');
 }
 if(command==='propose'){
  const paths=files(vault);
  if(paths.some(p=>/[\t\r\n]/.test(p)))return refuse('path');
  const out=path.resolve(options.out);
  if(within(out,vault))return refuse('paths');
  if(fs.existsSync(out))return refuse('out-exists');
  const rows=paths.map(p=>proposeLabel({path:p,rawBytes:fs.readFileSync(path.join(vault,p))})).filter(Boolean);
  const text=header+'\n'+rows.map(row=>columns.map(k=>row[k]).join('\t')+'\n').join('');
  try{fs.writeFileSync(out,text,{flag:'wx'});}catch(error){if(error.code==='EEXIST')return refuse('out-exists');throw error;}
  return result('authority: proposed '+rows.length);
 }
 if(command==='apply'){
  const lines=fs.readFileSync(options.sheet,'utf8').split('\n');
  if(lines.shift()!==header)return refuse('sheet');
  if(lines.at(-1)==='')lines.pop();
  let count=0;
  for(const line of lines){
   const cells=line.split('\t'),relative=cells[0];
   if(cells.length!==columns.length||cells.some(c=>/[\r\n\t]/.test(c)))return refuse('sheet','authority: stopped at '+relative);
   const row=Object.fromEntries(columns.map((key,i)=>[key,cells[i]]));
   if(row.decision!=='approve')continue;
   if(!row.proposed_authority)return refuse('empty-label');
   if(!['live','draft','archived','superseded'].includes(row.proposed_authority)||!['not_started','in_progress','done','dropped','wont_fix'].includes(row.proposed_status))return refuse('sheet','authority: stopped at '+relative);
   const full=source(vault,relative),destination=source(archive,utc()+'/'+relative);
   if(!full||!destination)return refuse('path');
   const bytes=fs.readFileSync(full);
   if(hash(bytes)!==row.sha256)return refuse('hash','authority: stopped at '+relative);
   fs.mkdirSync(path.dirname(destination),{recursive:true});
   let fd;
   try{fd=fs.openSync(destination,'wx');}catch(error){if(error.code==='EEXIST')return refuse('archive-exists');throw error;}
   try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   if(process.platform!=='win32'){
    const parent=fs.openSync(path.dirname(destination),'r');
    try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
   }
   const original=frontmatter(bytes.toString('utf8'));
   const properties={...original.properties,authority:row.proposed_authority,status:row.proposed_status,as_of:utc()};
   fs.writeFileSync(full,markdown(row.proposed_authority==='archived'?'Superseded. The previous text is in the archive.\n':original.body,properties,original));
   count++;
  }
  return result('authority: applied '+count);
 }
 const out=path.resolve(options.out);
 if(fs.existsSync(out))return refuse('out-exists');
 if(within(out,vault))return refuse('paths');
 const tickets=files(vault).map(p=>frontmatter(fs.readFileSync(path.join(vault,p),'utf8')).properties);
 const brief=renderBrief({repo:options.repo,tickets});
 fs.mkdirSync(out);
 if(brief.replace(/\n$/,'').split('\n').length>200||/^```/m.test(brief)){
  fs.rmdirSync(out);return refuse('brief-length');
 }
 fs.writeFileSync(path.join(out,'CLAUDE.md'),brief,{flag:'wx'});
 fs.writeFileSync(path.join(out,'AGENTS.md'),brief,{flag:'wx'});
 fs.copyFileSync(new URL('./templates/USER-LEVEL-PASTE.txt',import.meta.url),path.join(out,'USER-LEVEL-PASTE.txt'),fs.constants.COPYFILE_EXCL);
 return result('authority: exported '+options.out);
}
