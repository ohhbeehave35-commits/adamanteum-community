import {createReader} from './reader.js';
export function initPrograms({el,api,post,openDoc,refreshGraph,openNode}){
 const $=s=>document.querySelector(s),panel=$('#program-panel');
 const reader=createReader({el,api,openDoc,filterTag:()=>{}});
 let generation=0,active=null,lastFocus=null;
 const render=text=>reader.view({body:text,properties:{},tags:[],path:''});
 const close=()=>{generation++;panel.hidden=true;lastFocus?.focus();};
 $('#program-close').onclick=close;
 $('#program-human').onclick=async()=>{$('#program-action-status').textContent='Opening the human page…';const ok=active?await openNode.openHuman(active):false;$('#program-action-status').textContent=ok?'':'No human page was found for this program.';};
 $('#program-source').onclick=()=>{if(active)openNode.openCode(active);};
 panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close();}});
 async function open(program,ledger='CODE',symbol=null){
  lastFocus=document.activeElement;active=program;panel.hidden=false;$('#program-title').textContent=program.name;$('#program-close').focus();
  $('#program-symbol').textContent=symbol?`${symbol.name} · ${symbol.path||'Unknown path'}${symbol.line?':'+symbol.line:''}`:'';
  $('#program-meta').textContent='Loading program…';
  const mine=program;
  api('programs').then(data=>{if(active!==mine)return;const p=data.programs.find(p=>p.slug===program.slug);$('#program-meta').textContent=p?`Repo: ${p.repo||'Not recorded'} · Main branch: ${p.mainBranch}\nLast scan: ${p.code?.sha||'No scan yet'} · ${p.code?.at||'No scan time'}
From its notes: can ${p.ledger?.can??0} · cannot ${p.ledger?.cannot??0} · open ${p.ledger?.open??0} · done ${p.ledger?.done??0} · ${p.ledger?.notes??0} listed`:'Program no longer configured';}).catch(e=>{$('#program-meta').textContent=e.message;});
  for(const tab of panel.querySelectorAll('[data-ledger]'))tab.onclick=()=>load(tab.dataset.ledger);
  await load(ledger);
 }
 async function load(ledger,archive=''){
  const request=++generation,program=active;let before=null;
  const content=$('#program-content'),current=$('#program-current'),earlier=$('#program-earlier'),archives=$('#program-archives');
  content.replaceChildren(el('p','Loading…'));current.replaceChildren();earlier.hidden=true;archives.replaceChildren();
  for(const tab of panel.querySelectorAll('[data-ledger]'))tab.setAttribute('aria-selected',String(tab.dataset.ledger===ledger));
  async function page(older=false){
   earlier.disabled=true;
   try{
    const params={bytes:32768};if(archive)params.archive=archive;if(older)params.before=before;
    const data=await api('programs/'+encodeURIComponent(program.slug)+'/'+ledger,params);
    if(request!==generation)return;
    before=data.before??data.start;earlier.hidden=!data.hasEarlier;
    if(older)content.prepend(render(data.text));else{
     content.replaceChildren(render(data.text||'No entries yet.'));
     if(ledger==='CAPABILITIES'&&data.current)current.replaceChildren(el('h3','Current'),render(data.current));
     if(archive){const live=el('button','Latest ledger');live.onclick=()=>load(ledger);archives.append(live);}
     if(data.archives?.length){archives.append(el('h3','Archives'));for(const file of data.archives){const button=el('button',file);button.onclick=()=>load(ledger,file);archives.append(button);}}
    }
   }catch(e){if(request===generation){if(!older)content.replaceChildren();content.append(el('p',e.message));}}
   finally{if(request===generation)earlier.disabled=false;}
  }
  earlier.onclick=()=>page(true);await page();
 }
 for(const [id,route] of [['program-capture','capture-now'],['program-scan','scan']])$('#'+id).onclick=async()=>{
  const button=$('#'+id),program=active;button.disabled=true;$('#program-action-status').textContent='Working…';
  try{await post('programs/'+route,{slug:program.slug});$('#program-action-status').textContent=route==='scan'?'Code scan started. Reopen CODE after it finishes.':'Capture complete.';await poll();refreshGraph?.();if(route==='capture-now'&&active===program)await load(panel.querySelector('[aria-selected="true"]').dataset.ledger);}
  catch(e){$('#program-action-status').textContent=e.message;}finally{button.disabled=false;}
 };
 async function poll(){
  try{const status=await api('programs/status'),today=status.today||{},counter=$('#capture-counter'),paused=$('#capture-paused'),bar=$('#capture-progress');
   counter.textContent=status.enabled===false?`Program capture is not set up: ${status.reason||'No manifest configured'}`:`Capture: ${today.events||0} events · ${((today.bytes||0)/1024).toFixed(1)} KB written today of ${((today.budgetBytes||0)/1048576).toFixed(0)} MB budget · ${today.deduped||0} repeats skipped · disk ${status.diskFreeGB??'unknown'} GB free`;
   bar.value=today.budgetBytes?Math.min(100,100*today.bytes/today.budgetBytes):0;bar.hidden=status.enabled===false;
   paused.textContent=status.paused?`Capture paused: ${status.paused}`:'';paused.hidden=!status.paused;
  }catch(e){$('#capture-counter').textContent='Capture status unavailable: '+e.message;}
 }
 poll();setInterval(poll,10000);
 return {open};
}
