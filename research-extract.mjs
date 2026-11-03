// Text for the Research/ files the Markdown indexer used to skip (owner 25 Oct 11:28: "Everything should be indexed
// appropriately"): PDF -> page text, XLSX -> sheet rows, JSON -> keys and values, PNG -> file name, size and caption.
// Each becomes one index document whose body is plain Markdown, so search, titles and the page view treat it like a note.
// A file whose text cannot be read is still indexed (name, type, size, the reason), never silently dropped.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFile} from 'node:child_process';

export const RESEARCH_BINARY=/\.(pdf|xlsx|json|png)$/i;
export const isResearchBinary=p=>/^Research\//.test(p)&&RESEARCH_BINARY.test(p);
export const CAP=400_000;

const PY=`import sys
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
from pypdf import PdfReader
r=PdfReader(sys.argv[1]);out=[];n=0
for i,p in enumerate(r.pages[:500]):
    try:t=(p.extract_text() or '').strip()
    except Exception as e:t=''
    out.append('[page %d]\\n%s'%(i+1,t));n+=len(t)
    if n>${CAP}:break
print('Pages: %d'%len(r.pages));print('\\n\\n'.join(out)[:${CAP}])
`;
let pythonFound;
const run=(cmd,args,opt={})=>new Promise((resolve,reject)=>execFile(cmd,args,{maxBuffer:16*1024*1024,timeout:180000,windowsHide:true,...opt},(e,out,err)=>e?reject(Object.assign(e,{message:(String(err||'').trim().split('\n').pop()||e.message)})):resolve(String(out))));
async function findPython(){
  if(pythonFound!==undefined)return pythonFound;
  for(const cmd of [process.env.ADAMANTEUM_PYTHON,'py','python3','python'].filter(Boolean)){
    try{await run(cmd,[...(cmd==='py'?['-3']:[]),'-I','-c','import pypdf'],{timeout:20000});pythonFound=cmd;return cmd;}catch{/* try the next one */}
  }
  return (pythonFound=null);
}
async function pdfText(abs){
  const cmd=await findPython();
  if(!cmd)throw Error('no Python with pypdf on this machine (set ADAMANTEUM_PYTHON)');
  return (await run(cmd,[...(cmd==='py'?['-3']:[]),'-I','-c',PY,abs])).trim();
}

// ---- XLSX: a zip of XML; read it with the zlib that ships with Node
function zipEntries(buf){
  let end=buf.length-22;while(end>=0&&buf.readUInt32LE(end)!==0x06054b50)end--;
  if(end<0)throw Error('not a zip file');
  const count=buf.readUInt16LE(end+10);let p=buf.readUInt32LE(end+16);const out=new Map();
  for(let i=0;i<count;i++){
    if(buf.readUInt32LE(p)!==0x02014b50)throw Error('bad zip directory');
    const method=buf.readUInt16LE(p+10),csize=buf.readUInt32LE(p+20),nlen=buf.readUInt16LE(p+28),elen=buf.readUInt16LE(p+30),clen=buf.readUInt16LE(p+32),off=buf.readUInt32LE(p+42);
    const name=buf.toString('utf8',p+46,p+46+nlen);
    out.set(name,()=>{const ln=buf.readUInt16LE(off+26),le=buf.readUInt16LE(off+28),start=off+30+ln+le,raw=buf.subarray(start,start+csize);return method===0?raw:zlib.inflateRawSync(raw);});
    p+=46+nlen+elen+clen;
  }
  return out;
}
const unxml=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
function xlsxText(buf){
  const z=zipEntries(buf),read=n=>z.has(n)?z.get(n)().toString('utf8'):'';
  const shared=[...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m=>unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t=>t[1]).join('')));
  const names=[...read('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m=>unxml(m[1]));
  const sheets=[...z.keys()].filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  const out=[];
  sheets.forEach((s,i)=>{
    out.push(`## Sheet: ${names[i]||'Sheet'+(i+1)}`);
    for(const row of read(s).matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)){
      const cells=[...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(c=>{
        const t=/t="(\w+)"/.exec(c[1])?.[1],v=/<v>([\s\S]*?)<\/v>/.exec(c[2]||'')?.[1],is=/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2]||'')?.[1];
        return unxml(t==='s'?shared[Number(v)]??'':t==='inlineStr'?is??'':v??'');
      });
      if(cells.some(Boolean)){const first=out.length&&out[out.length-1].startsWith('## ');out.push('| '+cells.join(' | ')+' |');if(first)out.push('|'+cells.map(()=>'---').join('|')+'|');}
    }
  });
  return out.join('\n');
}

// ---- JSON: every key with its value, one line per leaf
function jsonText(text){
  const lines=[];
  const walk=(v,p)=>{
    if(lines.length>8000)return;
    if(Array.isArray(v))v.forEach((x,i)=>walk(x,p+'['+i+']'));
    else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))walk(x,p?p+'.'+k:k);
    else lines.push(`- ${p||'(value)'}: ${String(v).slice(0,300)}`);
  };
  walk(JSON.parse(text),'');
  return lines.join('\n');
}

// ---- PNG: dimensions from the header, the file name in words, and a caption from beside it when one exists
async function pngText(abs,rel,buf){
  const dims=buf.length>24&&buf.toString('latin1',1,4)==='PNG'?`${buf.readUInt32BE(16)} x ${buf.readUInt32BE(20)} pixels`:'size unknown';
  const base=path.basename(rel),words=base.replace(/\.[^.]+$/,'').replace(/[-_]+/g,' ');
  const dir=path.dirname(abs),caps=[];
  for(const n of ['captions.txt','CAPTIONS.txt','captions.md']){
    try{for(const l of (await fs.readFile(path.join(dir,n),'utf8')).split(/\r?\n/))if(l.toLowerCase().startsWith(base.toLowerCase()))caps.push(l.replace(/^[^:]+:\s*/,''));}catch{/* none */}
  }
  try{
    for(const n of await fs.readdir(dir))if(/\.(md|json|txt)$/i.test(n)&&n!=='captions.txt'){
      const t=await fs.readFile(path.join(dir,n),'utf8').catch(()=>'');
      if(t.length<200_000&&t.includes(base.replace(/\.png$/i,'')))caps.push(`Mentioned in ${n}: ${t.split(/\r?\n/).filter(l=>l.includes(base.replace(/\.png$/i,''))).slice(0,2).join(' ').slice(0,300)}`);
    }
  }catch{/* none */}
  return `Picture: ${words}. ${dims}.\n\n${caps.length?'Caption: '+[...new Set(caps)].join(' / '):'No caption file or note beside it; the name and folder are what search sees: '+path.dirname(rel).split('/').join(' / ')}.`;
}

/** The Markdown body to index for one Research/ binary file. Never throws; the reason is written into the body. */
export async function extractResearch(abs,rel){
  const ext=path.extname(rel).slice(1).toLowerCase(),name=path.basename(rel).replace(/\.[^.]+$/,'');
  const stat=await fs.stat(abs);
  let text='',note='';
  try{
    if(ext==='pdf')text=await pdfText(abs);
    else if(ext==='xlsx')text=xlsxText(await fs.readFile(abs));
    else if(ext==='json')text=jsonText(await fs.readFile(abs,'utf8'));
    else if(ext==='png')text=await pngText(abs,rel,await fs.readFile(abs));
    if(!text.trim())note=`No text was found in this ${ext.toUpperCase()}.`;
  }catch(e){note=`Text could not be read (${String(e.message||e).split('\n')[0].slice(0,160)}); indexed by name and folder only.`;}
  if(text.length>CAP)text=text.slice(0,CAP)+'\n\n[cut here: the rest of the file is not in the index]';
  return `# ${name.replace(/[-_]+/g,' ')}\n\nSource file: \`${rel}\` (${ext.toUpperCase()}, ${stat.size} bytes). ${note}\n\n${text}\n`;
}
