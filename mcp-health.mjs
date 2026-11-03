// ADAMCAP1: one command that proves the Adamanteum MCP server is up. It starts mcp-server.mjs the way an AI app would (stdio),
// says hello, lists the tools, and makes two real calls through the door: who am I (status) and a search. It prints ONE line of
// facts and exits 0 only if all of it worked. Run:  node mcp-health.mjs [--url http://127.0.0.1:4173] [--token-file path] [--query "words"]
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback;};
const url=arg('url',process.env.ADAMANTEUM_DOOR_URL||'http://127.0.0.1:4173');
const tokenFile=arg('token-file',process.env.ADAMANTEUM_DOOR_TOKEN_FILE||'');
const query=arg('query','capability');
const here=path.dirname(fileURLToPath(import.meta.url));
const started=Date.now();
const fail=(why,extra={})=>{console.log(JSON.stringify({ok:false,why,ms:Date.now()-started,url,...extra}));process.exit(1);};
if(!tokenFile)fail('No door key: pass --token-file or set ADAMANTEUM_DOOR_TOKEN_FILE (mint one: node adamanteum-cli.mjs door mint <name> --scope read --out <file>)');

const child=spawn(process.execPath,[path.join(here,'mcp-server.mjs')],{env:{...process.env,ADAMANTEUM_DOOR_URL:url,ADAMANTEUM_DOOR_TOKEN_FILE:tokenFile},stdio:['pipe','pipe','pipe']});
let buffer='',nextId=1;const waiting=new Map();
child.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;try{const m=JSON.parse(line);if(m.id!=null&&waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}}catch{}}});
child.on('error',e=>fail('Could not start mcp-server.mjs: '+e.message));
const rpc=(method,params={},ms=90000)=>new Promise((resolve,reject)=>{const id=nextId++;const t=setTimeout(()=>{waiting.delete(id);reject(new Error(method+' timed out after '+ms+' ms'));},ms);waiting.set(id,m=>{clearTimeout(t);m.error?reject(new Error(m.error.message||JSON.stringify(m.error))):resolve(m.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
const text=r=>(r?.content||[]).map(c=>c.text||'').join('\n');

try{
 const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'adamanteum-mcp-health',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=(await rpc('tools/list')).tools||[];
 if(!tools.length)fail('The server listed no tools');
 const status=await rpc('tools/call',{name:'adamanteum_status',arguments:{}});
 if(status.isError)fail('adamanteum_status failed: '+text(status).slice(0,200));
 const search=await rpc('tools/call',{name:'adamanteum_search',arguments:{query,limit:3}});
 if(search.isError)fail('adamanteum_search failed: '+text(search).slice(0,200));
 const found=text(search);
 let hits=[];try{hits=(JSON.parse(found).hits||[]).map(h=>h.path);}catch{}
 if(!hits.length)fail('The search for "'+query+'" returned no notes',{answer:found.replace(/\s+/g,' ').slice(0,160)});
 console.log(JSON.stringify({ok:true,server:init.serverInfo?.name+' '+init.serverInfo?.version,tools:tools.length,status:text(status).replace(/\s+/g,' ').slice(0,160),searched:query,searchHits:hits.slice(0,3),ms:Date.now()-started,url}));
 child.kill();process.exit(0);
}catch(e){fail(String(e.message||e));}
