import fs from 'node:fs';
import path from 'node:path';

const {tool_name:tool,tool_input:input={}}=JSON.parse(fs.readFileSync(0,'utf8'));
const root=path.resolve(process.env.CLAUDE_PROJECT_DIR||process.cwd());
const within=(candidate,base)=>candidate===base||candidate.startsWith(base+path.sep);
const blocked=target=>{
 const candidate=path.resolve(root,target),parts=candidate.split(path.sep);
 for(let i=0;i<parts.length;i++)if(['Archive','_archive'].includes(parts[i])||parts[i].startsWith('GRAPHIFY-EXPORT')){
  const boundary=parts.slice(0,i+1).join(path.sep)||path.sep;
  if(within(candidate,boundary))return true;
 }
 return ['AGENTS.md','CLAUDE.md','AGENTS.override.md'].includes(path.basename(candidate))&&path.dirname(candidate)!==root;
};
let deny=false;
if(['Read','Grep','Glob','Bash'].includes(tool)){
 const command=String(input.command||'');
 const targets=tool==='Bash'?(command.match(/"[^"]*"|'[^']*'|[^\s;&|<>]+/g)||[]).map(s=>s.replace(/^["']|["']$/g,'')):[input.file_path,input.path,input.pattern].filter(v=>typeof v==='string');
 deny=targets.some(blocked)||(tool==='Bash'&&/\bgit\s+push\b/.test(command));
}
if(deny){process.stderr.write('authority: denied\n');process.exitCode=2;}
