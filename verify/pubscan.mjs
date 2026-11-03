import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const pinned=new Set(['dist/bigatlas.js','dist/graph-panel.js','dist/atlas-settings.js']);
const omitted=new Set(['.git','.work','.data','node_modules']);
// Owner-specific names and paths are read from an untracked file so this public scanner does not publish them.
// Create .work/private-patterns.json (or set PUBSCAN_PRIVATE_FILE) with {"names":[],"paths":"regex","services":"regex"}.
let extra={names:[],paths:'',services:''};
try{extra=JSON.parse(fs.readFileSync(process.env.PUBSCAN_PRIVATE_FILE||path.join(root,'.work','private-patterns.json'),'utf8'));}catch{}
const never=/a^/;
const rules=[
 ['personal-name',extra.names&&extra.names.length?new RegExp('(^|[^A-Za-z])('+extra.names.join('|')+')($|[^A-Za-z])','i'):never],
 ['personal-path',new RegExp('(?:[A-Z]:[/]Users[/]|[A-Z]:'+String.fromCharCode(92,92)+'Users'+String.fromCharCode(92,92)+(extra.paths?'|'+extra.paths:'')+')','i')],
 ['private-service',extra.services?new RegExp(extra.services,'i'):never],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['credential-shape',/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/],
 ['private-host',/https?:\/\/(?:[^/\s'"`]*\.(?:onrender\.com|vercel\.app)|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)/i],
];
const findings=[],hosts=new Set();let files=0;
function walk(dir=''){
 for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
  if(omitted.has(e.name))continue;
  const relative=dir?dir+'/'+e.name:e.name;
  if(e.isDirectory()){walk(relative);continue;}
  if(e.isSymbolicLink())throw Error('Unexpected symlink: '+relative);
  if(/\.(png|log)$/.test(relative))continue;
  const text=fs.readFileSync(path.join(root,relative),'utf8');files++;
  for(const [i,line] of text.split(/\r?\n/).entries()){
   for(const [kind,re] of rules)if(re.test(line))findings.push({file:relative,line:i+1,kind,pinned:pinned.has(relative)});
  }
  for(const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)(?=[:/\s'"`<])/gi))hosts.add(m[1]);
 }
}
walk();
const result={files,findings,unexpected:findings.filter(f=>!f.pinned).length,pinnedFindings:findings.filter(f=>f.pinned).length,hosts:[...hosts].sort(),verdict:findings.length?'REVIEW REQUIRED — not a clean release scan':'PASS'};
console.log(JSON.stringify(result,null,2));
process.exitCode=findings.length?1:0;
