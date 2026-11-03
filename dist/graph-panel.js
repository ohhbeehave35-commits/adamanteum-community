import {coalesceFrame} from './atlas-settings.js';
import {DISPLAY_DEFAULTS,matchesQuery} from './graph.js';
import {FORCE_DEFAULTS} from './physics.js';
// The atlas control panel: Filters, Groups, Display and Forces, in the order Obsidian's graph settings use,
// plus the Animate button, the time-lapse scrubber and the reduce-motion choice.
const KEY='adamantium-graph-settings';
// The controls use Obsidian's own numbers and ranges (Text fade -3..3, Node size 0.1..5, Link thickness 0.1..5, Center 0..1,
// Repel 0..20, Link force 0..1, Link distance 30..500), defaulting to the values the owner has them set to. Each is scaled to
// the engine's own units here, so his values give the tuned look on both the ordinary atlas and the whole-vault map.
export const OBS_DEFAULTS=Object.freeze({textFade:-1,nodeSize:1.22,linkThickness:2.93,center:.46,repel:11.23,link:.24,distance:254});
const unit=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
export function engineSettings(obs){
 return {
  display:{textFade:unit(.45+(obs.textFade+1)*.1125),nodeSize:obs.nodeSize/OBS_DEFAULTS.nodeSize,linkThickness:obs.linkThickness/OBS_DEFAULTS.linkThickness},
  forces:{center:unit(.06*obs.center/OBS_DEFAULTS.center),repel:unit(.9*obs.repel/OBS_DEFAULTS.repel),link:unit(.4*obs.link/OBS_DEFAULTS.link),distance:unit(.5*obs.distance/OBS_DEFAULTS.distance)},
  bigForces:{center:obs.center,repel:obs.repel,link:obs.link,distance:obs.distance}
 };
}
const read=()=>{try{return JSON.parse(localStorage.getItem(KEY))||{};}catch{return {};}};
// ADAMLOOK2: the look settings a browser keeps (link tint, glow, node and link sizes, colour choices, forces) outlive every release, so one
// extreme setting made earlier leaves the atlas as white lines for good. From version 4 they go back to the approved defaults once; what is content, not look
// (tags, existing files, groups, folder grouping, motion, the local graph) is kept.
export const SETTINGS_VERSION=6; // 6: 2 Nov 2026 (old graphic after every restart): a saved Tags switch added ~4,100 tag nodes and 237,000 links that crush the organic map into a blob; tags go back to the approved default (off) once and Reset turns them off. 5: 5: 1 Nov 2026, the owner's settings change reverted the organic look and Reset look only unpinned (it clicked the first .gp-reset, Unpin all)
export function migrateSettings(saved){
 if(!saved||typeof saved!=='object'||Array.isArray(saved))return {};
 if(saved.v>=SETTINGS_VERSION)return saved;
 const keep={v:SETTINGS_VERSION};for(const k of ['existing','customGroups','cluster','motionOverride','local'])if(k in saved)keep[k]=saved[k];
 return keep;
}
const write=value=>{try{localStorage.setItem(KEY,JSON.stringify(value));}catch{}};
// Local graph: keep what is reachable from the open note in `depth` hops along the allowed link directions.
export function localSubgraph(result,seed,{depth=2,incoming=true,outgoing=true,neighbors=true}={}){
 const seen=new Map([[seed,0]]),used=new Set();let frontier=[seed];
 for(let hop=1;hop<=depth&&frontier.length;hop++){
  const next=[];
  for(const id of frontier)for(const e of result.edges){
   const other=outgoing&&e.source===id?e.target:incoming&&e.target===id?e.source:null;
   if(other!==null){used.add(e);if(!seen.has(other)){seen.set(other,hop);next.push(other);}}
  }
  frontier=next;
 }
 const nodes=result.nodes.filter(n=>seen.has(n.id)),edges=result.edges.filter(e=>seen.has(e.source)&&seen.has(e.target)&&(neighbors||used.has(e)));
 return {...result,nodes,edges};
}
export function initGraphPanel({graph,el,api,state,loadGraph,currentDoc,info}){
 const saved=migrateSettings(read());if(saved.display&&!saved.display.palette)saved.display.colorBy='folder';if(!([2,3].includes(saved.v))&&saved.display)delete saved.display.colorBy;// plain notes by default, as Obsidian draws them; folder colour stays one click away in Groups
 const settings={tags:!!saved.tags,existing:saved.existing!==false,display:{...DISPLAY_DEFAULTS,...saved.display},obs:{...OBS_DEFAULTS,...saved.obs},forces:{...FORCE_DEFAULTS},customGroups:saved.customGroups||[],cluster:!!saved.cluster,motionOverride:!!saved.motionOverride,local:{on:false,depth:2,incoming:true,outgoing:true,neighbors:false,...saved.local,on:false}};state.tags=settings.tags?'1':'';state.existing=settings.existing?'1':'0';
 const persist=()=>write({v:SETTINGS_VERSION,tags:settings.tags,existing:settings.existing,display:settings.display,obs:settings.obs,customGroups:settings.customGroups,cluster:settings.cluster,motionOverride:settings.motionOverride,local:settings.local});
 graph.motionOverride=settings.motionOverride;
 if((read().v||0)<SETTINGS_VERSION)persist();
 const atlas=document.querySelector('.atlas'),panel=el('aside',undefined,'graph-panel');panel.hidden=true;panel.setAttribute('aria-label','Graph settings');
 const gear=el('button','⚙ Graph','graph-gear');gear.id='graph-settings';gear.setAttribute('aria-expanded','false');gear.title='Filters, groups, display and forces for the graph';
 gear.onclick=()=>{panel.hidden=!panel.hidden;gear.setAttribute('aria-expanded',String(!panel.hidden));gear.classList.toggle('on',!panel.hidden);};
 document.querySelector('.graph-top').prepend(gear);
 const engine=()=>{const e=engineSettings(settings.obs);return {display:{...settings.display,...e.display},forces:e.forces,bigForces:e.bigForces,customGroups:settings.customGroups};};
 const apply=coalesceFrame(()=>{graph.settings(engine());graph.retime();persist();});
 const section=(title,open=false)=>{const d=el('details',undefined,'gp-section');d.open=open;d.append(el('summary',title));const body=el('div',undefined,'gp-body');d.append(body);panel.append(d);return body;};
 const row=(label,control,hint)=>{const r=el('label',undefined,'gp-row');r.append(el('span',label),control);if(hint)r.title=hint;return r;};
 const switches=new Map();
 const toggle=(label,value,onchange,hint)=>{const b=el('button',undefined,'gp-switch');b.type='button';b.setAttribute('role','switch');const set=v=>{b.setAttribute('aria-checked',String(v));b.dataset.on=v?'1':'0';};set(value);b.onclick=()=>{const v=b.dataset.on!=='1';set(v);onchange(v);};const r=el('div',undefined,'gp-row');r.append(el('span',label),b);if(hint)r.title=hint;r.onclick=e=>{if(e.target!==b)b.click();};r.set=set;switches.set(label,set);return r;};
 const slider=(label,value,min,max,step,onchange,hint)=>{const i=el('input');i.type='range';i.min=min;i.max=max;i.step=step;i.value=value;i.setAttribute('aria-label',label);const out=el('output',Number(value).toFixed(step<1?2:0),'gp-out');const paint=()=>{i.style.setProperty('--fill',((i.value-min)/(max-min)*100)+'%');};paint();i.oninput=()=>{paint();out.textContent=Number(i.value).toFixed(step<1?2:0);onchange(Number(i.value));};const r=el('div',undefined,'gp-row gp-slider');const head=el('span',label);head.append(out);r.append(head,i);if(hint)r.title=hint;r.input=i;r.paint=paint;return r;};
 const segmented=(options,value,onchange)=>{const wrap=el('div',undefined,'gp-segment');wrap.setAttribute('role','group');const buttons=options.map(([v,text])=>{const b=el('button',text);b.type='button';b.dataset.value=v;b.setAttribute('aria-pressed',String(v===value));b.onclick=()=>{buttons.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));onchange(v);};wrap.append(b);return b;});return wrap;};
 // ---- Filters
 const filters=section('Filters',true);
 const search=el('input');search.type='search';search.placeholder='Search files in this graph…';search.setAttribute('aria-label','Highlight documents in the graph');
 const found=el('small','','gp-note');
 const applySearch=text=>{const q=String(text||'').trim();if(search.value!==text)search.value=text||'';if(!q){graph.highlight(null);found.textContent='';return;}const n=graph.highlight(node=>matchesQuery(node,q));found.textContent=n?`${n} of ${graph.live.length.toLocaleString()} documents match`:'No document in this graph matches';};
 search.oninput=()=>applySearch(search.value);filters.append(search,found);
 filters.append(toggle('Tags',settings.tags,v=>{settings.tags=v;state.tags=v?'1':'';persist();loadGraph();},'Show each tag as a node linked from the notes that use it'));
 filters.append(toggle('Attachments',settings.display.attachments,v=>{settings.display.attachments=v;apply();},'Show linked images, PDFs, audio and video files'));
 filters.append(toggle('Existing files only',settings.existing,v=>{settings.existing=v;state.existing=v?'1':'0';persist();loadGraph();},'Hide unresolved links whose target file does not exist'));
 filters.append(toggle('Show unlinked documents',settings.display.orphans,v=>{settings.display.orphans=v;apply();},'Documents with no link inside this graph'));
 filters.append(toggle('Ring',settings.display.ring!==false,v=>{settings.display.ring=v;apply();},'The program islands and the adapter, connector and extension orbs around the graph. Off leaves the plain graph; the choice is saved for you.'));
 const local=toggle('Local graph for the open note',false,v=>{settings.local.on=v;if(v)loadLocal();else loadGraph();syncLocal();persist();},'Show only what is connected to the document you are reading');
 const depth=slider('Depth',settings.local.depth,1,5,1,v=>{settings.local.depth=v;persist();if(settings.local.on)loadLocal();});
 const incoming=toggle('Incoming links',settings.local.incoming,v=>{settings.local.incoming=v;persist();if(settings.local.on)loadLocal();}),outgoing=toggle('Outgoing links',settings.local.outgoing,v=>{settings.local.outgoing=v;persist();if(settings.local.on)loadLocal();});
 const neighbors=toggle('Neighbor links',settings.local.neighbors,v=>{settings.local.neighbors=v;persist();if(settings.local.on)loadLocal();},'Also draw links between the neighbours themselves');
 const localBox=el('div',undefined,'gp-local');localBox.append(depth,incoming,outgoing,neighbors);filters.append(local,localBox);
 const syncLocal=()=>{local.set(settings.local.on);localBox.dataset.on=settings.local.on?'1':'0';};syncLocal();
 async function loadLocal(){
  const doc=currentDoc();if(!doc){info('Open a note, then its local graph appears here.');return;}
  try{const result=await api('impact',{id:doc.id,depth:5}),sub=localSubgraph(result,doc.id,settings.local);graph.setData(sub);graph.select(doc.id);info(`Local graph · ${sub.nodes.length} documents within ${settings.local.depth} hop${settings.local.depth>1?'s':''} of ${doc.title}`);applySearch(search.value);}catch(e){info(e.message);}
 }
 // ---- Groups
 const groups=section('Groups'),groupList=el('div',undefined,'gp-groups');
 const palette=()=>graph.palette();
 const drawGroups=()=>{
  groupList.replaceChildren();if(settings.display.colorBy!=='custom')return;
  for(const [i,g] of settings.customGroups.entries()){
   const r=el('div',undefined,'gp-group'),q=el('input'),c=el('input'),x=el('button','×');q.value=g.query;q.placeholder='path:Clients or a word';q.setAttribute('aria-label','Group query');c.type='color';c.value=g.color;c.setAttribute('aria-label','Group colour');x.setAttribute('aria-label','Remove group');x.type='button';
   q.oninput=()=>{g.query=q.value;apply();};c.oninput=()=>{g.color=c.value;apply();};x.onclick=()=>{settings.customGroups.splice(i,1);drawGroups();apply();};r.append(c,q,x);groupList.append(r);
  }
  const add=el('button','+ New group','gp-add');add.type='button';add.onclick=()=>{settings.customGroups.push({query:'',color:palette()[settings.customGroups.length%7]});drawGroups();};groupList.append(add);
 };
 groups.append(segmented([['folder','By folder'],['none','Plain'],['custom','Custom']],settings.display.colorBy,v=>{settings.display.colorBy=v;if(v==='custom'&&!settings.customGroups.length)settings.customGroups.push({query:'',color:palette()[0]});drawGroups();apply();}),groupList);drawGroups();
 // ---- Colors
 const colors=section('Colors',true);
 const choice=(label,key,values)=>{const select=el('select');select.setAttribute('aria-label',label);for(const [value,text] of values){const o=el('option',text);o.value=value;select.append(o);}select.value=settings.display[key];select.onchange=()=>{settings.display[key]=select.value;apply();};colors.append(row(label,select));};
 choice('Palette','palette',['Spectrum','Ember','Aurora','Ocean','Mono'].map(v=>[v,v]));
 choice('Color by','colorBy',[['folder','Folder'],['age','Age'],['links','Links'],['none','None'],['custom','Custom']]);
 colors.append(toggle('Link tint',settings.display.linkTint,v=>{settings.display.linkTint=v;apply();}),toggle('Glow',settings.display.glow,v=>{settings.display.glow=v;apply();}));
 const unpin=el('button','Unpin all','gp-reset');unpin.onclick=()=>{graph.unpinAll();};panel.append(unpin);
 // ---- Display
 const display=section('Display');
 display.append(row('Arrows',(()=>{const s=el('select');for(const [v,t] of [['auto','Near the pointer'],['on','Always'],['off','Never']]){const o=el('option',t);o.value=v;s.append(o);}s.value=settings.display.arrows;s.onchange=()=>{settings.display.arrows=s.value;apply();};return s;})()));
 display.append(slider('Text fade threshold',settings.obs.textFade,-3,3,.01,v=>{settings.obs.textFade=v;apply();},'Lower shows names sooner as you zoom out'));
 display.append(slider('Animate speed',settings.display.animateSpeed,.25,4,.05,v=>{settings.display.animateSpeed=v;apply();graph.retime();},'How fast the growth time-lapse plays; works while it plays'));
 display.append(slider('Node size',settings.obs.nodeSize,.1,5,.01,v=>{settings.obs.nodeSize=v;apply();}));
 display.append(slider('Link thickness',settings.obs.linkThickness,.1,5,.01,v=>{settings.obs.linkThickness=v;apply();}));
 display.append(toggle('Folder names when zoomed out',settings.display.clusterLabels,v=>{settings.display.clusterLabels=v;apply();}));
 display.append(toggle('Flow along links',!!graph.animating,v=>graph.animate(v),'Animated dots travelling source to target. Decorative; not live traffic.'));
 // ---- Forces
 const forces=section('Forces');
 const forceSliders=[['center','Center force',0,1,.01],['repel','Repel force',0,20,.01],['link','Link force',0,1,.01],['distance','Link distance',30,500,1]].map(([k,t,lo,hi,st])=>slider(t,settings.obs[k],lo,hi,st,v=>{settings.obs[k]=v;apply();}));
 forces.append(...forceSliders);
 const cluster=toggle('Group by folder',settings.cluster,v=>{settings.cluster=v;persist();graph.setCluster(v);},'Pulls each folder into its own neighbourhood');forces.append(cluster);
 const reset=el('button','Reset graph settings','gp-reset gp-reset-all');reset.type='button';reset.onclick=()=>{if(settings.tags){settings.tags=false;state.tags='';switches.get('Tags')?.(false);persist();loadGraph();}if(settings.local.on){settings.local.on=false;syncLocal();persist();loadGraph();}Object.assign(settings.display,DISPLAY_DEFAULTS);Object.assign(settings.obs,OBS_DEFAULTS);settings.customGroups=[];settings.cluster=false;graph.setCluster(false);for(const n of graph.nodes)n.radius=(2.3+Math.min(8.5,Math.sqrt(n.degree||0)*.95));apply();drawGroups();for(const [label,key] of [['Attachments','attachments'],['Show unlinked documents','orphans'],['Folder names when zoomed out','clusterLabels'],['Link tint','linkTint'],['Glow','glow']])switches.get(label)?.(settings.display[key]);cluster.set(false);display.querySelector('select').value=settings.display.arrows;for(const button of groups.querySelectorAll('[data-value]'))button.setAttribute('aria-pressed',String(button.dataset.value===settings.display.colorBy));for(const input of panel.querySelectorAll('input[type=range]')){const name=input.getAttribute('aria-label');if(name==='Depth')continue;const key={'Node size':'nodeSize','Text fade threshold':'textFade','Link thickness':'linkThickness','Center force':'center','Repel force':'repel','Link force':'link','Link distance':'distance'}[name];input.value=key?settings.obs[key]:settings.display.animateSpeed;input.dispatchEvent(new Event('input'));}for(const select of colors.querySelectorAll('select'))select.value=settings.display[select.getAttribute('aria-label')==='Palette'?'palette':'colorBy'];};panel.append(reset);
 const mount=()=>{atlas.append(panel);};mount();
 if(settings.cluster)graph.forces.cluster=.55;
 // ---- Animate (growth time-lapse)
 const animate=el('button','\u25b6','animate-button');animate.type='button';animate.setAttribute('aria-pressed','false');
 animate.setAttribute('aria-label','Play vault replay');animate.title='Replay your vault being built: documents appear oldest to newest and the layout moves as they connect.';
 const bar=el('div',undefined,'lapse-bar');bar.hidden=false;bar.setAttribute('role','group');bar.setAttribute('aria-label','Growth time-lapse');
 const playPause=el('button','❚❚');playPause.type='button';playPause.setAttribute('aria-label','Pause or resume');
 const scrub=el('input');scrub.type='range';scrub.min=0;scrub.max=1000;scrub.value=0;scrub.setAttribute('aria-label','Scrub through time');
 const stamp=el('span','','lapse-stamp');bar.append(animate,scrub,stamp);atlas.append(bar);
 const note=el('div',undefined,'motion-note');note.hidden=true;note.setAttribute('role','status');atlas.append(note);
 const fmt=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
 graph.onlapse=l=>{
  if(!l){bar.hidden=false;animate.textContent='\u25b6';animate.setAttribute('aria-label','Play vault replay');animate.setAttribute('aria-pressed','false');return;}
  bar.hidden=false;animate.textContent=l.done?'\u21bb':l.playing?'\u25a0':'\u25b6';animate.setAttribute('aria-label',l.done?'Replay vault':l.playing?'Stop replay':'Resume replay');animate.setAttribute('aria-pressed',String(l.playing));
  playPause.textContent=l.done?'↻':l.playing?'❚❚':'▶';scrub.value=Math.round(l.progress*1000);scrub.style.setProperty('--fill',l.progress*100+'%');
  stamp.title=stamp.textContent=`${l.count.toLocaleString()} of ${l.total.toLocaleString()} · last edited ${l.date?fmt(l.date):'—'}`;
 };
 const start=()=>{note.hidden=true;if(!graph.play())info('Nothing to animate yet.');};
 animate.onclick=()=>{
  if(graph.lapse){if(graph.lapse.progress>=1)start();else if(graph.lapse.playing)graph.pause();else graph.resume();return;}
  if(!graph.nodes.length&&!graph.bigActive)return;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches&&!graph.motionOverride){
   note.replaceChildren(el('span','Your device asks for less motion, so the graph holds still.'));
   const go=el('button','Play anyway','primary'),keep=el('button','Keep still');go.type=keep.type='button';
   go.onclick=()=>{graph.motionOverride=true;settings.motionOverride=true;persist();start();};keep.onclick=()=>{note.hidden=true;};
   note.append(go,keep);note.hidden=false;go.focus();return;
  }
  start();
 };
 playPause.onclick=()=>{const l=graph.lapse;if(!l)return;if(l.playing)graph.pause();else graph.resume();};
 scrub.oninput=()=>graph.scrub(Number(scrub.value)/1000);
 // Stopping the time-lapse leaves a calm layout; Escape is the keyboard way out.
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.target.closest?.('input,textarea,dialog')){if(graph.lapse)graph.stopLapse();else if(graph.trail)graph.clearTrail();}});
 graph.settings(engine());
 return {gear,panel,animate,applySearch,localOn:()=>settings.local.on,onOpen:id=>{if(settings.local.on)loadLocal();},localOff:()=>{if(settings.local.on){settings.local.on=false;syncLocal();}},settings};
}
