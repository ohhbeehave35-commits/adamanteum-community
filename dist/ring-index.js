// ADAMCAP4: the ring's own index and the card that opens when an orb is clicked.
//  - Ring index: adapters, connectors and extensions listed apart from the notes, filtered by kind, trade, category and program, with a search
//    that looks only in them. Each row opens the vault note it came from.
//  - Orb card: what a clicked orb is (kind, category, trades) and the programs that use it; each program name opens that program's panel.
const GLYPH={adapter:'◆',connector:'⇄',extension:'✦',user:'▣'};
export function initRingIndex({el,api,openDoc,openProgram,big,post,reload}){
 const panel=document.createElement('aside');panel.id='ring-index';panel.className='workspace-panel';panel.hidden=true;panel.setAttribute('aria-label','Ring index');
 const head=el('div',undefined,'spot-head');head.append(el('span','Ring index'));const close=el('button','×');close.setAttribute('aria-label','Close ring index');head.append(close);
 const body=el('div',undefined,'program-body ring-index-body');
 const filters=el('div',undefined,'ri-filters');
 const search=el('input');search.type='search';search.placeholder='Search adapters, connectors, extensions';search.setAttribute('aria-label','Search the ring index');
 const mk=(label)=>{const s=el('select');s.setAttribute('aria-label',label);return s;};
 const kind=mk('Kind'),trade=mk('Trade'),category=mk('Category'),program=mk('Program');
 filters.append(search,kind,trade,category,program);
 const count=el('p',undefined,'ri-count');count.setAttribute('role','status');
 const rows=el('ul',undefined,'ri-rows');
 body.append(filters,count,rows);panel.append(head,body);document.body.append(panel);
 const card=document.createElement('aside');card.id='orb-card';card.hidden=true;card.setAttribute('aria-label','Orb');
 document.body.append(card);
 let facetsDone=false,timer=0,request=0;
 const fill=(select,all,items)=>{const keep=select.value;select.replaceChildren();const o=el('option',all);o.value='';select.append(o);for(const it of items){const x=el('option',`${it.label||it.name} (${it.count})`);x.value=it.name;select.append(x);}select.value=keep;};
 async function load(){
  const mine=++request;
  const params={kind:kind.value,trade:trade.value,category:category.value,program:program.value,q:search.value,limit:300};
  let data;try{data=await api('orbs',params);}catch(e){count.textContent=e.message;return;}
  if(mine!==request)return;
  if(!facetsDone){facetsDone=true;fill(kind,'All kinds',data.facets.kinds);fill(trade,'All trades',data.facets.trades);fill(category,'All categories',data.facets.categories);fill(program,'All programs',data.facets.programs);}
  count.textContent=`${data.count} of ${data.total} orbs`;
  rows.replaceChildren(...data.orbs.map(o=>{
   const li=el('li',undefined,'ri-row ri-'+o.family),b=el('button',undefined,'ri-open');
   b.append(el('span',GLYPH[o.family]+' ','ri-glyph'),el('strong',o.name),el('span',` · ${o.memberCount||o.count}`,'ri-n'));
   b.title=`Open ${o.name}`;b.onclick=()=>{if(o.sourceId!=null)openDoc(o.sourceId);showCard(o);};
   const meta=el('span',`${o.family} · ${o.category}${o.programs.length?' · '+o.programs.join(', '):''}`,'ri-meta');
   li.append(b,meta);return li;
  }));
 }
 const later=()=>{clearTimeout(timer);timer=setTimeout(load,160);};
 search.oninput=later;for(const s of [kind,trade,category,program])s.onchange=load;
 function open(){panel.hidden=false;search.focus();load();}
 close.onclick=()=>{panel.hidden=true;};
 panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();panel.hidden=true;}});
 function showCard(o){
  const orb=o.orb||o,programs=orb.programs||[];
  card.replaceChildren();
  const h=el('div',undefined,'oc-head');h.append(el('strong',`${GLYPH[orb.family]||''} ${o.name}`));const x=el('button','×');x.setAttribute('aria-label','Close');x.onclick=()=>{card.hidden=true;};h.append(x);
  card.append(h,el('p',`${orb.family} · ${orb.category}`,'oc-line'),el('p',`Trades: ${(orb.trades||[]).includes('all')?'all trades':(orb.trades||[]).join(', ')}`,'oc-line'));
  const used=el('p','Used by: ','oc-line');
  if(!programs.length)used.append('no program recorded yet');
  programs.forEach((name,i)=>{if(i)used.append(', ');const b=el('button',name+(orb.evidence?.[name]==='proposed'?' (proposed)':''),'oc-prog');b.onclick=()=>openProgram?.(name);used.append(b);});
  card.append(used);
  if(orb.noteMissing)card.append(el('p','Its vault note is missing.','oc-line'));
  // What the island's notes say, built from the notes themselves: can, cannot, open, done, with the first lines of each.
  if(orb.ledger){
   const L=orb.ledger;card.append(el('p',`${L.notes} note${L.notes===1?'':'s'} · can ${L.can} · cannot ${L.cannot} · open ${L.open} · done ${L.done}`,'oc-line oc-ledger'));
   for(const k of ['can','cannot','open','done']){const first=L.lines?.[k]?.[0];if(first)card.append(el('p',`${k}: ${first.text}`,'oc-line oc-small'));}
  }
  if(orb.userId&&post){const rm=el('button','Remove from ring','oc-remove');rm.onclick=async()=>{try{await post('ring/unpin',{id:orb.userId});card.hidden=true;reload?.();}catch(e){rm.textContent=e.message;}};card.append(rm);}
  card.hidden=false;
 }
 return {open,showCard,panel,card};
}
