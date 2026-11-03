import fs from 'node:fs';
import path from 'node:path';
// FIVE1 (owner 26 Oct 20:04, "it's not just to look pretty"): open any node as the human page OR the actual code.
// Read-only. A vault file is read through the vault workspace (it refuses anything outside the vault). A program's code is read from the
// checkout the code scan recorded, and only inside that folder; secret-looking files and anything large or binary are refused.
const SECRET=/(^|[\\/])(\.env[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|keystore|jks|kdbx|ppk)|id_[a-z0-9]+(\.pub)?|[^\\/]*_(rsa|dsa|ecdsa|ed25519)|credentials?(\.[a-z]+)?|[^\\/]*(secret|password|passwd)[^\\/]*\.(json|txt|env|ya?ml)|\.npmrc|\.netrc|\.pgpass|\.git-credentials)$/i;
// Any folder or file whose name starts with a dot stays out of view (.ssh, .aws, .git, .obsidian), except .github.
const hiddenPath=rel=>rel.split('/').some(p=>p.startsWith('.')&&p!=='.'&&p!=='..'&&p!=='.github');
const refuse=()=>{throw Error('That file is kept out of view because its name looks like a secret.');};
const SKIP_DIR=new Set(['.git','node_modules','.next','dist-ssr','__pycache__','.venv','venv','.cache','.turbo','coverage','.data']);
const MAX_BYTES=400*1024;
const looksBinary=buf=>buf.subarray(0,4096).includes(0);
function clean(text){return String(text).replaceAll('\r\n','\n');}
export function vaultSource(workspace,relative){
 const rel=String(relative||'').replaceAll('\\','/');
 if(!rel||rel.length>600)throw Error('Name a vault file.');
 if(hiddenPath(rel))refuse();
 const abs=workspace.file(rel);
 const stat=fs.statSync(abs);
 if(stat.isDirectory())return {kind:'folder',path:rel,entries:fs.readdirSync(abs,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')).map(e=>({name:e.name,dir:e.isDirectory()})).sort((a,b)=>b.dir-a.dir||a.name.localeCompare(b.name)).slice(0,300)};
 if(SECRET.test(rel))refuse();
 const buf=fs.readFileSync(abs);
 if(looksBinary(buf))return {kind:'binary',path:rel,bytes:stat.size};
 const text=buf.subarray(0,MAX_BYTES).toString('utf8');
 return {kind:'file',path:rel,bytes:stat.size,truncated:buf.length>MAX_BYTES,text:clean(text)};
}
function programOf(capture,slug){
 const program=capture.programs().find(p=>p.slug===slug);
 if(!program)throw Error('That program is not in the list.');
 return program;
}
function codeRoot(capture,program){
 const summary=capture.codeSummary(program);
 const dir=summary?.dir;
 if(!dir||!fs.existsSync(dir))return {summary,dir:null};
 return {summary,dir:fs.realpathSync(dir)};
}
// The code side of a program node: where the checkout is, its entry files and best-known functions, and (with sub) one folder of it.
export function programCode(capture,slug,sub=''){
 const program=programOf(capture,slug),{summary,dir}=codeRoot(capture,program);
 if(!dir)return {program:program.name,slug,repo:program.repo,available:false,reason:summary?'The checkout from the last scan is not on this computer now ('+summary.dir+').':'No code scan yet. Use Scan code in the program panel.'};
 const rel=String(sub||'').replaceAll('\\','/').replace(/^\/+|\/+$/g,'');
 if(hiddenPath(rel)||rel.split('/').some(p=>SKIP_DIR.has(p)))throw Error('That folder is not shown.');
 let target;try{target=fs.realpathSync(path.resolve(dir,rel));}catch{throw Error('That folder is not in the program.');}
 const inside=path.relative(dir,target);
 if(inside.startsWith('..')||path.isAbsolute(inside))throw Error('That folder is outside the program.');
 const entries=fs.readdirSync(target,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')||e.name==='.github').filter(e=>!(e.isDirectory()&&SKIP_DIR.has(e.name))).map(e=>({name:e.name,dir:e.isDirectory()})).sort((a,b)=>b.dir-a.dir||a.name.localeCompare(b.name)).slice(0,400);
 return {program:program.name,slug,repo:program.repo,available:true,dir,sha:summary.sha,scannedAt:summary.at,files:summary.files,sub:rel,entries,entryFiles:rel?[]:(summary.entryFiles||[]),entrySymbols:rel?[]:(summary.entrySymbols||[]).slice(0,40).map(s=>({name:s.name,path:s.path,line:s.line,calls:s.calls}))};
}
export function programFile(capture,slug,file,line=0){
 const program=programOf(capture,slug),{dir}=codeRoot(capture,program);
 if(!dir)throw Error('The checkout is not on this computer now.');
 const rel=String(file||'').replaceAll('\\','/').replace(/^\/+/,'');
 if(!rel)throw Error('Name a file.');
 if(SECRET.test(rel)||hiddenPath(rel))refuse();
 let abs;try{abs=fs.realpathSync(path.resolve(dir,rel));}catch{throw Error('That file is not in the program.');}
 const inside=path.relative(dir,abs);
 if(inside.startsWith('..')||path.isAbsolute(inside))throw Error('That file is outside the program.');
 if(inside.split(path.sep).some(p=>SKIP_DIR.has(p)))throw Error('That folder is not shown.');
 if(SECRET.test(inside)||hiddenPath(inside.replaceAll('\\','/')))refuse();
 const stat=fs.statSync(abs);
 if(stat.isDirectory())throw Error('That is a folder.');
 const buf=fs.readFileSync(abs);
 if(looksBinary(buf))return {path:inside,bytes:stat.size,binary:true};
 return {path:inside,bytes:stat.size,truncated:buf.length>MAX_BYTES,line:Number(line)||0,text:clean(buf.subarray(0,MAX_BYTES).toString('utf8'))};
}
