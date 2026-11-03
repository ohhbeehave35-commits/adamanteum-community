// FIVE1 (owner 26 Oct 20:04, "it's not just to look pretty"): any program node opens as the human page OR the actual code.
// The human page is the program's INDEX note in the vault; the code is the checkout the last code scan recorded, browsed folder by folder, read-only.
export function initOpenNode({el,api,openDoc,readingView,closeSpot}){
 const $=s=>document.querySelector(s),dialog=$('#open-code');
 let program=null;
 const close=()=>dialog.close();
 $('#open-code-close').onclick=close;
 async function humanPage(prog){
  const name=prog.name,rows=await api('search',{q:'Programs '+name+' INDEX',scope:'records'});
  const want=('Programs/'+name+'/INDEX.md').toLowerCase(),hit=rows.find(r=>r.path.toLowerCase()===want)||rows.find(r=>r.path.toLowerCase().startsWith('programs/'+name.toLowerCase()+'/'));
  return hit?hit.id:null;
 }
 async function openHuman(prog){
  const id=await humanPage(prog).catch(()=>null);
  if(id!=null){if(dialog.open)close();openDoc(id);return true;}
  return false;
 }
 function crumbs(sub,go){
  const row=$('#open-code-crumbs');row.replaceChildren();
  const root=el('button','program root');root.onclick=()=>go('');row.append(root);
  let acc='';for(const part of sub.split('/').filter(Boolean)){acc+=(acc?'/':'')+part;const p=acc,b=el('button','/ '+part);b.onclick=()=>go(p);row.append(b);}
 }
 async function browse(sub=''){
  $('#open-code-text').textContent='';$('#open-code-text').hidden=true;
  $('#open-code-list').replaceChildren(el('p','Loading…'));
  let d;
  try{d=await api('open/program-code',{slug:program.slug,sub});}catch(e){$('#open-code-list').replaceChildren(el('p',e.message));return;}
  if(!d.available){$('#open-code-meta').textContent=d.reason;$('#open-code-list').replaceChildren();return;}
  $('#open-code-meta').textContent=`${d.repo||program.name} · ${d.dir} · last scan ${d.sha?.slice(0,8)||'none'} · ${d.files||0} files`;
  crumbs(sub,browse);
  const list=$('#open-code-list'),kids=[];
  if(!sub&&d.entrySymbols?.length){
   kids.push(el('h3','Main functions'));
   for(const s of d.entrySymbols){const b=el('button',undefined,'open-code-row');b.append(el('strong',s.name),el('small',`${s.path}:${s.line}${s.calls?' · '+s.calls+' calls':''}`));b.onclick=()=>file(s.path,s.line);kids.push(b);}
  }
  if(!sub&&d.entryFiles?.length){kids.push(el('h3','Where it starts'));for(const f of d.entryFiles){const b=el('button',f,'open-code-row');b.onclick=()=>file(f,0);kids.push(b);}}
  kids.push(el('h3',sub||'All files'));
  for(const e of d.entries){const full=(sub?sub+'/':'')+e.name,b=el('button',(e.dir?'▸ ':'')+e.name,'open-code-row');b.onclick=()=>e.dir?browse(full):file(full,0);kids.push(b);}
  list.replaceChildren(...kids);
 }
 async function file(rel,line){
  const out=$('#open-code-text');out.hidden=false;out.textContent='Loading…';
  try{
   const d=await api('open/program-file',{slug:program.slug,file:rel,line});
   const head=`${d.path} · ${(d.bytes/1024).toFixed(1)} KB${d.truncated?' · first 400 KB shown':''}\n\n`;
   if(d.binary){out.textContent=head+'(a binary file, not shown)';return;}
   const lines=d.text.split('\n'),width=String(lines.length).length;
   out.textContent=head+lines.map((t,i)=>String(i+1).padStart(width)+'  '+t).join('\n');
   if(line>0){const idx=head.split('\n').length-1+line-1;out.scrollTop=Math.max(0,(idx-3)*out.scrollHeight/Math.max(1,lines.length+head.split('\n').length));}
   out.scrollIntoView({block:'nearest'});
  }catch(e){out.textContent=e.message;}
 }
 function openCode(prog){
  program=prog;$('#open-code-title').textContent=prog.name+' · the actual code';
  if(!dialog.open)dialog.showModal();
  browse('');
 }

 // A note belongs to a program when it sits under Programs/<program>/; that program's checkout is its "actual code".
 let programList=null;
 async function programFor(notePath){
  const m=/^Programs\/([^/]+)\//i.exec(notePath||'');if(!m)return null;
  if(!programList)programList=api('programs').then(d=>d.programs||[]).catch(()=>[]);
  const seg=m[1].toLowerCase();
  return (await programList).find(p=>p.slug.toLowerCase()===seg||p.name.toLowerCase().replace(/\s+/g,'-')===seg)||null;
 }
 // FIVE1 (K2 22:39): a search result opens right inside the search box, as the human page, its source, or (for a program note) the program's actual code.
 const spot=$('#spotlight'),results=$('#spot-results'),box=$('#spot-preview'),page=$('#spot-doc');
 let opened=0;
 const resetPreview=()=>{opened++;box.hidden=true;results.hidden=false;page.replaceChildren();};
 spot.addEventListener('close',resetPreview);
 $('#spot-back').onclick=()=>{resetPreview();$('#spot-query').focus();};
 async function preview(row){
  const mine=++opened;results.hidden=true;box.hidden=false;page.replaceChildren(el('p','Opening…'));
  $('#spot-path').textContent=row.path;
  let d;try{d=await api('doc',{id:row.id});}catch(e){if(mine===opened)page.replaceChildren(el('p',e.message));return;}
  if(mine!==opened)return;
  const program=await programFor(d.path);if(mine!==opened)return;
  const tabs={human:$('#spot-human'),source:$('#spot-source')};
  const mark=name=>{for(const [k,b] of Object.entries(tabs))b.setAttribute('aria-pressed',String(k===name));};
  const show=async name=>{
   mark(name);
   if(name==='human'){page.replaceChildren(readingView(d));return;}
   page.replaceChildren(el('p','Loading…'));
   try{const s=await api('open/source',{path:d.path});if(mine!==opened)return;page.replaceChildren(el('pre',s.kind==='file'?s.text+(s.truncated?'\n\n(first 400 KB shown)':''):'(not shown: '+s.kind+')','doc-body'));}
   catch(e){if(mine===opened)page.replaceChildren(el('p',e.message));}
  };
  tabs.human.onclick=()=>show('human');tabs.source.onclick=()=>show('source');
  $('#spot-code').hidden=!program;$('#spot-code').onclick=()=>{if(program){closeSpot();openCode(program);}};
  $('#spot-atlas').onclick=()=>{closeSpot();document.body.classList.remove('graph-focus');openDoc(d.id);};
  show('human');
 }
 return {openCode,openHuman,preview,programFor};
}
