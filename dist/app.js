import {initPrograms} from './programs-ui.js';
import {initOpenNode} from './open-node.js';
import {initRingIndex} from './ring-index.js';
import {initVaultTools,renderCanvas} from './vault-tools.js';
import {Atlas} from './graph.js';
import {initGraphPanel,engineSettings} from './graph-panel.js';
import {BigAtlas} from './bigatlas.js';
import {createVoice} from './voice-viz.js';
import {analyzeGraph,graphML} from './analysis.js';
import {initOrganizer} from './organizer.js';
import {initNotebook} from './notebook.js';
import {createReader} from './reader.js';
const $=s=>document.querySelector(s);
const state={scope:'records',folder:'',focus:0,theme:localStorage.getItem('adamanteum-interface')||'nebula'};
const api=async(path,params={})=>{const r=await fetch('/api/'+path+'?'+new URLSearchParams(params));if(!r.ok)throw Error(`Vault service: ${r.status}`);return r.json();};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const graph=new Atlas($('#graph'),{select:id=>{if(id<0){const tag=graph.nodes.find(n=>n.id===id);graph.select(id);if(tag?.tag){$('#search').value='tag:'+tag.title.slice(1);$('#search').dispatchEvent(new Event('input'));}return;}openDoc(id);},expand:id=>{if(id<0)return;state.focus=id;loadGraph();},trace:(a,b)=>traceBetween(a,b)});
// Shift-click a second document: draw the shortest chain of real links on the live graph; ask the service when the loaded map does not hold it.
async function traceBetween(a,b){
 const title=id=>graph.nodes.find(n=>n.id===id)?.title||'document',say=t=>{$('#graph-info').textContent=t;};
 const ids=graph.tracePath(a,b);if(ids){say(`Path · ${ids.length-1} link${ids.length>2?'s':''} from ${title(a)} to ${title(b)}`);return;}
 try{const result=await api('path',{from:a,to:b});if(!result.path.length){say(result.bounded?'No path within 5,000 visited documents':'No chain of links connects these two documents');return;}graph.timelineMode=false;graph.setData(result);graph.tracePath(a,b);say(`Path · ${result.path.length-1} links · actual source links`);}catch(e){say(e.message);}
}
const restore=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}};
let saved=restore('adamanteum-saved',[]),visited=restore('adamanteum-visited',[]),docHistory=[],historyAt=-1,currentDoc=null;
let bookmarksHash=null;api('workspace/bookmarks').then(file=>{saved=JSON.parse(file.body);bookmarksHash=file.sha256;}).catch(()=>{});
const historyButtons=()=>{$('#back-doc').disabled=historyAt<=0;$('#forward-doc').disabled=historyAt>=docHistory.length-1;};
function documentOpened(d,fromHistory){
 currentDoc=d;
 document.body.classList.add('has-document');
 if(!fromHistory&&docHistory[historyAt]!==d.id){docHistory=docHistory.slice(0,historyAt+1);docHistory.push(d.id);historyAt=docHistory.length-1;}
 historyButtons();
 visited=[{id:d.id,title:d.title,folder:d.folder},...visited.filter(n=>n.id!==d.id)].slice(0,30);
 localStorage.setItem('adamanteum-visited',JSON.stringify(visited));
 const pin=el('button',saved.some(n=>n.id===d.id)?'★ Saved':'☆ Save this place','save-document');
 pin.onclick=async()=>{try{const has=saved.some(n=>n.id===d.id),next=has?saved.filter(n=>n.id!==d.id):[{id:d.id,path:d.path,title:d.title,folder:d.folder},...saved];const receipt=await post('workspace/save',{path:'Adamanteum-bookmarks.json',body:JSON.stringify(next,null,2),expectedHash:bookmarksHash});saved=next;bookmarksHash=receipt.sha256;pin.textContent=has?'Save this place':'Saved';}catch(e){pin.textContent=e.message;}};
 $('#document').insertBefore(pin,$('#document .primary'));
 const analysis=el('details',undefined,'outline');analysis.append(el('summary','Knowledge tools · provenance and connections'));
 if(d.provenance){const provenance=el('p',`Source: ${d.provenance.source_file||d.path}${d.provenance.location?' · '+d.provenance.location:''}\nContent SHA-256: ${d.provenance.sha256}`,'doc-path');analysis.append(provenance);}
 const impact=el('button','Explore 2-hop neighborhood');impact.onclick=async()=>{try{impact.disabled=true;const result=await api('impact',{id:d.id,depth:2});graph.timelineMode=false;graph.setData(result);$('#graph-info').textContent=`${result.nodes.length} documents within 2 hops${result.truncated?' · bounded to 300 documents':''}`;graph.pulse(result.nodes.slice(0,20).map(n=>n.id));}catch(e){impact.textContent=e.message;}finally{impact.disabled=false;}};analysis.append(impact);
 const destinations=saved.filter(n=>n.id!==d.id);if(destinations.length){const select=el('select');select.setAttribute('aria-label','Find connection to saved document');for(const n of destinations){const option=el('option',n.title);option.value=n.id;select.append(option);}const pathButton=el('button','Find connection path');pathButton.onclick=async()=>{try{pathButton.disabled=true;const result=await api('path',{from:d.id,to:select.value});if(!result.path.length){pathButton.textContent=result.bounded?'No path within 5,000 visited nodes':'No connected path';return;}graph.timelineMode=false;graph.setData(result);$('#graph-info').textContent=`Connection path · ${result.path.length} documents · actual source links`;graph.pulse(result.path);}catch(e){pathButton.textContent=e.message;}finally{pathButton.disabled=false;}};analysis.append(select,pathButton);}
 $('#document').append(analysis);
 const readingRoot=$('#document > .reading'),headings=readingRoot?[...readingRoot.querySelectorAll('h2,h3,h4')]:[];
 if(headings.length>0){const outline=el('details',undefined,'outline');outline.append(el('summary','In this document · '+headings.length+' sections'));for(const [index,heading] of headings.entries()){const b=el('button',heading.textContent);b.onclick=()=>readingRoot?.querySelectorAll('h2,h3,h4')[index]?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});outline.append(b);}$('#document').insertBefore(outline,readingRoot);}
}
let graphRequest=0,searchRequest=0;
function theme(name){if(!['nebula','ember','aurora','ivory','terminal'].includes(name))name='nebula';state.theme=name;document.body.dataset.theme=name;localStorage.setItem('adamanteum-interface',name);document.querySelectorAll('nav button').forEach(b=>{b.classList.toggle('active',b.dataset.theme===name);b.setAttribute('aria-pressed',b.dataset.theme===name);});graph.refresh();const whole=graph.canvas.parentElement.bigAtlas;if(whole)whole.theme(name==='ivory');}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>theme(b.dataset.theme));theme(state.theme);
function drawLegend(){
 const by=graph.display.colorBy,items=by==='folder'?graph.groups.slice(0,7).map((g,i)=>[g,graph.colors[i%graph.colors.length]]):by==='custom'?graph.customGroups.filter(g=>g.query.trim()).map(g=>[g.query,g.color]):[];
 $('#legend').replaceChildren(...items.map(([label,color])=>{const n=el('span',label);n.style.setProperty('--dot',color);return n;}));
}
graph.onsettings=()=>{drawLegend();};
const big=new BigAtlas($('#graph').parentElement,{program:(...args)=>programUI.open(...args),capability:(program,meta)=>{if(meta?.sourceId!=null)openDoc(meta.sourceId);else programUI.open(program,'CAPABILITIES');},orb:program=>{if(program.orb?.sourceId!=null)openDoc(program.orb.sourceId);ringUI.showCard(program);},select:id=>openDoc(id),tag:name=>{$('#search').value='tag:'+name;$('#search').dispatchEvent(new Event('input'));},trace:(a,b)=>{const ids=big.path(a,b);$('#graph-info').textContent=ids?`Path · ${ids.length-1} link${ids.length>2?'s':''} between these two notes`:'No chain of links connects these two notes in this map';}});
window.__adamBig=big; // read-only handle for tests/organic-phone-render.test.mjs (island spread, view)
big.attach(graph);
const syncBigTheme=()=>{const style=getComputedStyle(document.body);big.theme(document.body.dataset.theme==='ivory',(()=>{const c=style.getPropertyValue('--accent').trim();return /^#[0-9a-f]{6}$/i.test(c)?[parseInt(c.slice(1,3),16)/255,parseInt(c.slice(3,5),16)/255,parseInt(c.slice(5,7),16)/255]:null;})());big.palette=graph.palette();};
let bigLoading=0;
// The whole vault: every note and every link as flat columns, laid out in a worker and drawn by the graphics card. Falls back to the strongest 5,000 where WebGL is missing.
async function loadWhole(request){
 const started=performance.now(),mine=++bigLoading;$('#graph-info').textContent='Loading every note and link…';
 const params={scope:'all',tags:state.tags||'',existing:state.existing||'1',attachments:'1'};
 // FIVE1: the page head already asked for the map while this file was still loading (the same request the first draw makes); use that answer once, then fall back to asking.
 const early=window.__adamGraph;window.__adamGraph=null;
 let data=early&&params.tags===''&&params.existing==='1'?await early:null;
 if(!data)data=await api('graphfull',params);
if(request!==graphRequest||mine!==bigLoading)return;
 big.palette=graph.palette();big.customGroups=graph.customGroups;big.display={...big.display,...graph.display};big.forces={...big.forces,...engineSettings(panel.settings.obs).bigForces};big.setData(data);if(big.noGL){big.hide();throw Error('NOGL');}
 syncBigTheme();big.show();try{performance.mark('adam-graph-data');}catch{}timeMap.textContent='Map: connections';
 // WRONGLOOK1: the header said 102,839 documents beside 472,675 in the side panel. The map draws every note once, each link pair once, and adds the program points; say so, and count only notes as documents.
 {const ring=(data.island||[]).reduce((s,k)=>s+(k>0?1:0),0),docs=data.n-ring;$('#graph-info').textContent=`${docs.toLocaleString()} documents · ${data.links.toLocaleString()} links on the map`;$('#graph-info').title=`The list on the left counts every link in both directions. The map draws each linked pair once${ring?` and adds ${ring.toLocaleString()} program points`:''}.`;}
 canvasStat(Math.round(performance.now()-started));
 api('graphtitles',params).then(titles=>{if(mine===bigLoading){big.setTitles(titles);big.paintNodes();}}).catch(()=>{});
}
const canvasStat=ms=>{$('#graph').dataset.wholeMs=ms;};
let lastGraphAt=0,graphFailed=false,graphDocs=0,statusDocs=0;
async function loadGraph(){const request=++graphRequest;lastGraphAt=Date.now();graphFailed=false;graphDocs=statusDocs;panel.localOff();
 if($('#density').value==='all'&&!state.folder&&!state.focus){try{await loadWhole(request);return;}catch(e){if(e.message!=='NOGL'){graphFailed=true;$('#graph-info').textContent=e.message;return;}$('#density').value='5000';}}
 big.hide();
 try{const data=await api('graph',{...state,limit:$('#density').value});if(request!==graphRequest)return;graph.timelineMode=false;timeMap.textContent='Map: connections';graph.setData(data);$('#graph-info').textContent=`${data.nodes.length.toLocaleString()} documents · ${data.edges.length.toLocaleString()} real links${state.focus?' · neighborhood':state.folder?' · '+state.folder:' · strongest connections'}`;drawLegend();}catch(e){graphFailed=true;$('#graph-info').textContent=e.message;}}
async function groups(){const data=await api('groups',state);$('#groups').replaceChildren(...data.map(g=>{const b=el('button',undefined,'group');b.append(el('span',g.folder),el('small',g.count.toLocaleString()));b.onclick=()=>{state.folder=g.folder;state.focus=0;document.querySelectorAll('.group').forEach(n=>n.classList.remove('selected'));b.classList.add('selected');loadGraph();search();};return b;}));}
const ORBGLYPH={adapter:'◆',connector:'⇄',extension:'✦'};
async function orbMatches(q){if(!q||q.length<2)return [];try{const d=await api('orbs',{q,limit:8});return (d.orbs||[]).slice(0,8);}catch{return [];}}
function orbRow(o,cls){const b=el('button',undefined,cls+' orb-result');b.dataset.orb=o.name;b.append(el('strong',`${ORBGLYPH[o.family]||'●'} ${o.name}`),el('small',`${o.family} orb · ${o.category}${o.programs&&o.programs.length?' · '+o.programs.join(', '):''}`));b.onclick=()=>{if(o.sourceId!=null)openDoc(o.sourceId);ringUI.showCard(o);};return b;}
async function search(offset=0){if(!Number.isSafeInteger(offset))offset=0;const request=++searchRequest;try{const q=$('#search').value;const [rows,orbs]=await Promise.all([api('search',{...state,q,offset}),offset?[]:orbMatches(q)]);if(request!==searchRequest)return;$('#results-title').textContent=q?`SEARCH · ${offset+1}–${offset+rows.length}${rows.length===80?'+':''}`:'RECENT DOCUMENTS';$('#results').replaceChildren(...orbs.map(o=>orbRow(o,'result')),...rows.map(d=>{const b=el('button',undefined,'result');b.append(el('strong',d.title),el('small',d.path+' · '+d.degree+' links'));b.onclick=()=>openDoc(d.id);return b;}));if(!rows.length&&!orbs.length){$('#results-title').textContent=q?'SEARCH · END OF RESULTS':'RECENT DOCUMENTS';$('#results').append(el('p',offset?'No more results.':'No matching documents. Try fewer words.'));}const paging=el('div',undefined,'workspace-row');if(offset){const previous=el('button','← Previous 80');previous.onclick=()=>search(Math.max(0,offset-80));paging.append(previous);}if(rows.length===80){const next=el('button','Next 80 →');next.onclick=()=>search(offset+80);paging.append(next);}$('#results').append(paging);}catch(e){$('#results').textContent=e.message;}}
let selectedRequest=0;
let vaultWritable=false;fetch('/api/workspace/settings').then(r=>r.json()).then(s=>{vaultWritable=!!s.writable;}).catch(()=>{});
const reader=createReader({el,api,openDoc:(id,fromHistory,anchor)=>openDoc(id,fromHistory,anchor),filterTag:tag=>{$('#search').value='tag:'+tag;$('#search').dispatchEvent(new Event('input'));}});
function readingView(d){
 if(d.path?.endsWith('.canvas')){try{return renderCanvas(d.body.trim()?JSON.parse(d.body):{nodes:[],edges:[]},{el,api,readingView:reader.view,save:vaultWritable?async json=>{const file=await api('workspace/file',{path:d.path});await post('workspace/save',{path:d.path,body:json,expectedHash:file.sha256});}:null,openFile:async target=>{const found=await api('workspace/resolve',{source:d.path,target});if(found)openDoc(found.id);}});}catch(e){return el('p',e.message);}}
 return reader.view(d);
}
async function openDoc(id,fromHistory=false,anchor=null){const request=++selectedRequest;try{const d=await api('doc',{id});if(request!==selectedRequest)return;graph.select(id);panel.onOpen(id);const title=el('h2',d.title),meta=el('p',d.path,'doc-path'),date=el('small',new Date(d.mtime).toLocaleString()+' · '+(d.bytes/1024).toFixed(1)+' KB'),expand=el('button','Explore connections ↗','primary');let body=readingView(d);const source=el('button','View original Markdown','source-toggle'),codeBtn=el('button','The actual code','source-toggle');codeBtn.hidden=true;try{openNode.programFor(d.path).then(p=>{if(p){codeBtn.hidden=false;codeBtn.onclick=()=>openNode.openCode(p);}});}catch{}let raw=false;source.onclick=()=>{raw=!raw;const next=raw?el('pre',d.body,'doc-body'):readingView(d);body.replaceWith(next);body=next;source.textContent=raw?'Reading view':'View original Markdown';const outline=$('#document .outline');if(outline)outline.hidden=raw;};expand.onclick=()=>{state.focus=id;loadGraph();};const links=el('div',undefined,'connections');links.append(el('h3',`${d.degree} connections`));for(const c of d.connections){const b=el('button',(c.outgoing?'↗ ':'↙ ')+c.title);b.onclick=()=>openDoc(c.id);links.append(b);}const pin=el('div',undefined,'pin-row');{const mkPin=(label,kind,ref,name)=>{const b=el('button',label,'pin-btn');b.onclick=async()=>{try{const r=await post('ring/pin',{kind,ref,name});b.textContent=r.item.already?'Already on the ring':'On the ring ('+r.notes+' note'+(r.notes===1?'':'s')+')';b.disabled=true;if(big.active)loadGraph();}catch(e){b.textContent=e.message;}};return b;};pin.append(mkPin('Pin note to the ring','note',d.path,d.title));{const dir=String(d.path||'').split('/').slice(0,-1).join('/');if(dir)pin.append(mkPin('Pin folder to the ring','folder',dir,dir.split('/').pop()));}for(const t of (d.tags||[]).slice(0,3))pin.append(mkPin('Pin #'+t+' to the ring','tag',t,'#'+t));}
$('#document').replaceChildren(title,meta,date,expand,source,codeBtn,pin,body,links);documentOpened(d,fromHistory);if(anchor)body.scrollToAnchor?.(anchor);}catch(e){$('#document').textContent=e.message;}}
let timer;$('#search').oninput=()=>{panel.applySearch($('#search').value);document.body.classList.toggle('searching',!!$('#search').value.trim());clearTimeout(timer);timer=setTimeout(search,180);};
$('#scope').onchange=()=>{state.scope=$('#scope').value;state.folder='';state.focus=0;groups();search();loadGraph();};
$('#all').onclick=()=>{state.folder='';state.focus=0;groups();search();loadGraph();};
$('#overview').onclick=()=>{state.focus=0;loadGraph();};
$('#density').onchange=loadGraph;
$('#fit').onclick=()=>graph.fit();$('#plus').onclick=()=>graph.zoom(1.3);$('#minus').onclick=()=>graph.zoom(1/1.3);
$('#close-doc').onclick=()=>{selectedRequest++;currentDoc=null;$('#document').replaceChildren(el('h2','Follow a connection.'),el('p','Select any document to read its original text.'));graph.select(0);document.body.classList.remove('reader-focus','has-document');};
$('#back-doc').onclick=()=>{if(historyAt>0)openDoc(docHistory[--historyAt],true);};
$('#forward-doc').onclick=()=>{if(historyAt<docHistory.length-1)openDoc(docHistory[++historyAt],true);};
$('#reader-mode').onclick=()=>{document.body.classList.remove('graph-focus');document.body.classList.toggle('reader-focus');};
function showPlaces(items,label){const area=$('#places-list');if(area.dataset.label===label&&!area.hidden){area.hidden=true;return;}area.dataset.label=label;area.hidden=false;area.replaceChildren(el('div',label,'section-title'),...items.map(d=>{const b=el('button',d.title,'result');b.onclick=()=>openDoc(d.id);return b;}));if(!items.length)area.append(el('p',label==='SAVED PLACES'?'Open a document and choose “Save this place”.':'Documents you open will appear here.'));}
$('#saved-places').onclick=()=>showPlaces(saved,'SAVED PLACES');$('#recent-places').onclick=()=>showPlaces(visited,'RECENTLY VISITED');
const tools=$('#atlas-tool-grid'),full=el('button','⛶ Expand atlas'),labels=el('button','Labels: auto'),edges=el('button','Links: on'),exportGraph=el('button','↓ Export graph');
full.onclick=()=>{document.body.classList.remove('reader-focus');const expanded=document.body.classList.toggle('graph-focus');full.textContent=expanded?'⤢ Restore panels':'⛶ Expand atlas';};
labels.onclick=()=>{graph.hideLabels=!graph.hideLabels;big.hideLabels=graph.hideLabels;big.dirty=true;big.drawSoon();labels.textContent=graph.hideLabels?'Labels: off':'Labels: auto';graph.refresh();};
edges.onclick=()=>{graph.hideEdges=!graph.hideEdges;big.hideEdges=graph.hideEdges;big.dirty=true;big.drawSoon();edges.textContent=graph.hideEdges?'Links: off':'Links: on';graph.refresh();};
exportGraph.onclick=()=>{const source=big.active?big.gl:$('#graph'),flat=document.createElement('canvas');flat.width=source.width;flat.height=source.height;const fc=flat.getContext('2d');fc.fillStyle=getComputedStyle(document.body).getPropertyValue('--graph').trim()||'#100e18';fc.fillRect(0,0,flat.width,flat.height);if(big.active)big.draw(performance.now());fc.drawImage(source,0,0);if(big.active)fc.drawImage(big.ink,0,0);flat.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='Adamanteum-vault-graph.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});};
const rendering=el('button','View: constellation');rendering.onclick=()=>{graph.structural=!graph.structural;big.structural=graph.structural;big.drawSoon();rendering.textContent=graph.structural?'View: structure':'View: constellation';graph.refresh();};
const cellView=el('button','◉ Cell view');const shapeButtons=()=>{cellView.textContent=graph.cellular?'◉ Exit cell view':'◉ Cell view';};cellView.title='Arrange real notes inside a cell-shaped membrane; the most connected notes form its nucleus.';cellView.onclick=()=>{graph.cell();shapeButtons();timeMap.textContent='Map: connections';};
const timeMap=el('button','Map: connections');timeMap.onclick=()=>{if(!graph.nodes.length&&!big.active)return;graph.timeline();shapeButtons();timeMap.textContent=graph.timelineMode?'Map: modified time':'Map: connections';};
const panel=initGraphPanel({graph,el,api,state,loadGraph:()=>loadGraph(),currentDoc:()=>currentDoc,info:text=>{$('#graph-info').textContent=text;}}),animate=panel.animate;
const resetLook=el('button','\u21ba Reset look');resetLook.title='Back to the approved look: constellation, colour links, glow and the default sizes';
resetLook.onclick=()=>{if(graph.structural){graph.structural=false;big.structural=false;rendering.textContent='View: constellation';}if(graph.cellular){graph.cell();shapeButtons();}document.querySelector('.gp-reset-all')?.click();graph.refresh();big.dirty=true;big.drawSoon();$('#fit')?.click();};
tools.append(full,cellView,timeMap,rendering,labels,edges);
const zoomRow=el('div',undefined,'atlas-zoom-row');zoomRow.setAttribute('role','group');zoomRow.setAttribute('aria-label','Atlas zoom');zoomRow.append($('#minus'),$('#fit'),$('#plus'));tools.append(zoomRow);
$('.graph-bottom').remove();
const toolGroup=$('#atlas-tool-group'),phoneAtlas=matchMedia('(max-width:640px)');
toolGroup.open=!phoneAtlas.matches;
if(!phoneAtlas.matches)try{toolGroup.open=localStorage.getItem('Adamanteum:atlas:tools')!=='closed';}catch{}
phoneAtlas.addEventListener('change',e=>{toolGroup.open=!e.matches;if(!e.matches)try{toolGroup.open=localStorage.getItem('Adamanteum:atlas:tools')!=='closed';}catch{}});
toolGroup.ontoggle=()=>{if(phoneAtlas.matches)return;try{localStorage.setItem('Adamanteum:atlas:tools',toolGroup.open?'open':'closed');}catch{}};
const analyze=el('button','◎ Analyze'),analysisDialog=el('dialog',undefined,'workspace-dialog');
analysisDialog.setAttribute('aria-label','Graph analysis');document.body.append(analysisDialog);const actionRow=el('div',undefined,'atlas-action-row');actionRow.append(analyze,exportGraph);tools.append(actionRow);const resetRow=el('div',undefined,'atlas-reset-row');resetRow.append(resetLook);tools.append(resetRow);
analyze.onclick=()=>{
 const nodes=graph.nodes.map(({id,title,path,folder,category,degree,mtime,bytes})=>({id,title,path,folder,category,degree,mtime,bytes})),links=graph.edges.map(e=>({source:e.a.id,target:e.b.id}));
 const result=analyzeGraph(nodes,links),head=el('div',undefined,'spot-head'),close=el('button','Close analysis');close.onclick=()=>analysisDialog.close();head.append(el('span','UNDERSTAND THIS MAP'),close);
 const content=el('div',undefined,'workspace-content');content.append(el('h2',`${result.nodes} documents. ${result.edges} real links.`),el('p',`${result.communities.length} structural communities · ${result.components.length} connected components · ${result.isolated.length} isolated documents`),el('p','Analysis applies to this selected map, not the entire vault. Communities are calculated from link structure; they are not AI-inferred facts.'));
 const downloads=el('div',undefined,'workspace-row');
 for(const [label,filename,type,body] of [['Download JSON','adamanteum-graph.json','application/json',JSON.stringify({schema:'adamanteum.graph/v1',source:'selected source-backed map',nodes,edges:links,analysis:result},null,2)],['Download GraphML','adamanteum-graph.graphml','application/graphml+xml',graphML(nodes,links)]]){
  const button=el('button',label);button.onclick=()=>{const url=URL.createObjectURL(new Blob([body],{type})),a=el('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};downloads.append(button);
 }
 content.append(downloads,el('h3','Key documents · directed PageRank'));
 const entire=el('button','Analyze my entire vault','primary'),entireResult=el('div');content.insertBefore(entire,downloads);content.insertBefore(entireResult,downloads);
 entire.onclick=async()=>{
  entire.disabled=true;
  try{
   await post('analysis/start',{});
   const poll=async()=>{
    try{
     const job=await api('analysis/status');
     entireResult.replaceChildren(el('p','Whole-vault analysis: '+job.phase));
     if(job.phase==='error'){entireResult.append(el('p',job.error));entire.disabled=false;return;}
     if(job.phase!=='complete'){if(analysisDialog.open)setTimeout(poll,1000);else entire.disabled=false;return;}
     const r=job.result;entireResult.replaceChildren(el('h3','Your entire indexed vault'),el('p',`${r.documents.toLocaleString()} documents · ${r.links.toLocaleString()} real links · ${r.components.toLocaleString()} components · ${r.isolated.toLocaleString()} isolated documents`));
     entireResult.append(el('p','Exact components and directed PageRank across all indexed documents, calculated in a background worker. No AI inference or source changes.'));
     for(const n of r.ranked.slice(0,10)){const b=el('button',n.title+' · '+n.connections+' links','result');b.onclick=()=>{analysisDialog.close();openDoc(n.id);};entireResult.append(b);}
     const download=el('button','Download whole-vault analysis');download.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download='adamanteum-whole-vault-analysis.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};entireResult.append(download);entire.disabled=false;
    }catch(error){entireResult.textContent=error.message;entire.disabled=false;}
   };await poll();
  }catch(error){entireResult.textContent=error.message;entire.disabled=false;}
 };
 for(const n of result.ranked.slice(0,12)){const button=el('button',`${n.title} · ${n.connections} connections`,'result');button.onclick=()=>{analysisDialog.close();openDoc(n.id);};content.append(button);}
 content.append(el('h3','Explore a structural community'));
 for(const [i,community] of result.communities.slice(0,16).entries()){const button=el('button',`Community ${i+1} · ${community.length} documents`,'result');button.onclick=()=>{const selected=new Set(community);graph.setData({nodes:nodes.filter(n=>selected.has(n.id)),edges:links.filter(e=>selected.has(e.source)&&selected.has(e.target))});$('#graph-info').textContent=`Structural community ${i+1} · ${community.length} documents`;analysisDialog.close();};content.append(button);}
 analysisDialog.replaceChildren(head,content);analysisDialog.showModal();
};
let spotRequest=0,spotIndex=-1,spotRows=[];
const spot=$('#spotlight'),spotInput=$('#spot-query');
function openSpot(){spot.showModal();spotInput.focus();}
$('#quick-open').onclick=openSpot;$('#spot-close').onclick=()=>spot.close();
async function quickSearch(){const request=++spotRequest,q=spotInput.value.trim();if(!q){$('#spot-results').replaceChildren(el('p','Search source records, exports, and archives together.'));return;}$('#spot-results').replaceChildren(el('p','Searching…'));try{const [batches,spotOrbs]=await Promise.all([Promise.all(['records','generated','archive'].map(scope=>api('search',{q,scope}))),orbMatches(q)]);if(request!==spotRequest)return;spotRows=batches.flat().slice(0,90);spotIndex=-1;$('#spot-results').replaceChildren(...spotOrbs.map(o=>{const b=orbRow(o,'spot-result');const old=b.onclick;b.onclick=()=>{spot.close();old();};return b;}),...spotRows.map(d=>{const b=el('button',undefined,'spot-result');b.append(el('strong',d.title),el('small',d.category+' / '+d.path));b.onclick=()=>openNode.preview(d);return b;}));if(!spotRows.length&&!spotOrbs.length)$('#spot-results').append(el('p','No matching documents.'));}catch(e){$('#spot-results').textContent=e.message;}}
let spotTimer;spotInput.oninput=()=>{clearTimeout(spotTimer);spotTimer=setTimeout(quickSearch,180);};
spotInput.onkeydown=e=>{const buttons=[...$('#spot-results').querySelectorAll('button')];if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();spotIndex=Math.max(0,Math.min(buttons.length-1,spotIndex+(e.key==='ArrowDown'?1:-1)));buttons.forEach((b,i)=>b.classList.toggle('spot-selected',i===spotIndex));buttons[spotIndex]?.scrollIntoView({block:'nearest'});}if(e.key==='Enter'&&buttons.length){e.preventDefault();buttons[Math.max(0,spotIndex)].click();}};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(!spot.open)openSpot();}if(e.key==='Escape'){document.body.classList.remove('graph-focus','reader-focus');full.textContent='⛶ Expand atlas';}});
const activityStream=new EventSource('/api/activity');
activityStream.onopen=()=>{$('#activity-connection').textContent='● Connected';};
activityStream.onerror=()=>{$('#activity-connection').textContent='Reconnecting…';};
activityStream.onmessage=e=>{const event=JSON.parse(e.data);if(Date.now()-Date.parse(event.time)<5000)graph.pulse(event.nodes||[]);const row=el('div',undefined,'activity-row');row.append(el('small',new Date(event.time).toLocaleTimeString()+' · '+event.type),el('strong',event.label));if(event.nodes?.length){const view=el('button','Inspect '+event.nodes.length+' document'+(event.nodes.length===1?'':'s'));view.onclick=()=>{state.focus=event.nodes[0];loadGraph();openDoc(event.nodes[0]);};row.append(view);}$('#activity-events').prepend(row);while($('#activity-events').children.length>40)$('#activity-events').lastElementChild.remove();};
$('#activity-open').onclick=()=>{$('#activity-panel').hidden=!$('#activity-panel').hidden;};$('#activity-close').onclick=()=>{$('#activity-panel').hidden=true;};
let aiConnection=null,aiBusy=false,selectedKnowledge=null;
const knowledgeConsent=el('label'),knowledgeCheck=el('input'),knowledgeLabel=el('span','No knowledge entity selected.');knowledgeCheck.type='checkbox';knowledgeCheck.id='ai-knowledge';knowledgeConsent.append(knowledgeCheck,knowledgeLabel);knowledgeConsent.hidden=true;$('.context-choice').append(knowledgeConsent);
const post=async(route,input)=>{const response=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');return data;};
function profile(){return {schema:'adamanteum.ai/v1',name:$('#ai-name').value.trim(),model:$('#ai-model').value.trim(),endpoint:$('#ai-endpoint').value.trim()};}
$('#ai-open').onclick=()=>{$('#ai-context-label').textContent=currentDoc?`Selected: ${currentDoc.title}. Up to 10,000 characters will be sent only if checked.`:'No document selected. Context is off by default.';$('#ai-panel').showModal();};$('#ai-close').onclick=()=>$('#ai-panel').close();
async function loadCard(file){try{if(!file||file.size>20000)throw Error('Choose a JSON connection card under 20 KB.');const p=JSON.parse(await file.text());if(p.schema!=='adamanteum.ai/v1'||p.command||p.script||p.apiKey||p.tools)throw Error('Use a safe adamanteum.ai/v1 connection card without keys, commands, or tools.');$('#ai-name').value=String(p.name||'');$('#ai-model').value=String(p.model||'');$('#ai-endpoint').value=String(p.endpoint||'');$('#ai-status').textContent=`${p.name||'AI'} card loaded. Review the endpoint, then Connect AI. No vault text has been sent.`;}catch(e){$('#ai-status').textContent=e.message;}}
$('#ai-file').onchange=e=>loadCard(e.target.files[0]);$('#ai-drop').ondragover=e=>{e.preventDefault();$('#ai-drop').classList.add('dragging');};$('#ai-drop').ondragleave=()=>$('#ai-drop').classList.remove('dragging');$('#ai-drop').ondrop=e=>{e.preventDefault();$('#ai-drop').classList.remove('dragging');loadCard(e.dataTransfer.files[0]);};
$('#ai-card').onclick=()=>{const p=profile();if(!p.name||!p.model||!p.endpoint){$('#ai-status').textContent='Enter a name, model, and endpoint first.';return;}const url=URL.createObjectURL(new Blob([JSON.stringify(p,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download='adamanteum-ai-connection.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('#ai-connect').onclick=async()=>{if(aiBusy)return;aiBusy=true;$('#ai-connect').disabled=true;$('#ai-status').textContent='Checking provider and model…';try{if(aiConnection)await post('ai/disconnect',{id:aiConnection.id});aiConnection=await post('ai/attach',{profile:profile(),key:$('#ai-key').value});$('#ai-key').value='';$('#ai-status').textContent=`${aiConnection.name} connected to ${new URL(aiConnection.endpoint).host}. Context is off until you approve it.`;$('#ai-send').disabled=false;$('#ai-disconnect').disabled=false;$('#ai-config').open=false;}catch(e){aiConnection=null;$('#ai-send').disabled=true;$('#ai-status').textContent=e.message;}finally{aiBusy=false;$('#ai-connect').disabled=false;}};
$('#ai-disconnect').onclick=async()=>{try{if(aiConnection)await post('ai/disconnect',{id:aiConnection.id});$('#ai-status').textContent='Disconnected. This computer no longer holds the connection credential.';}catch(e){$('#ai-status').textContent=e.message;}finally{aiConnection=null;$('#ai-key').value='';$('#ai-send').disabled=true;$('#ai-disconnect').disabled=true;}};
const {initImageSharing}=await import('./image-share.js');
const imageSharing=initImageSharing();
const {initProjects}=await import('./projects.js');initProjects();
const {initKnowledge}=await import('./knowledge.js');const knowledgeWorkspace=initKnowledge({connection:()=>aiConnection,currentDocument:()=>currentDoc,openDocument:openDoc,askAI:selection=>{selectedKnowledge=selection;knowledgeConsent.hidden=false;knowledgeCheck.checked=false;knowledgeLabel.textContent=`Send selected knowledge entity “${selection.title}” and up to eight evidence-linked relationships to my connected AI.`;$('#ai-context').checked=false;$('#ai-search').checked=false;$('#ai-open').click();$('#ai-message').value=`Explain ${selection.title}, its relationships, and any uncertainty in the evidence.`;}});
const directionKey=document.createElement('div');directionKey.className='direction-key';directionKey.textContent='Source → linked document · select to trace';directionKey.hidden=true;document.querySelector('.atlas-heading').append(directionKey);
// Assistant's voice: replies are read aloud by the browser's own voice (nothing leaves this computer) and the ring shows only while she speaks.
const voice=createVoice({name:'Assistant',onstate:on=>{$('#ai-voice-stop').hidden=!on;}});
const voiceViews=[voice.view($('#ai-panel'),{className:'centre'}),voice.view(document.body,{className:'dock'})];
$('#ai-panel').voice=voice;// the page's own checks drive her voice through this
try{if(localStorage.getItem('adamanteum-voice')==='0')$('#ai-voice').checked=false;}catch{}
if(!voice.supported){$('#ai-voice').checked=false;$('#ai-voice').disabled=true;$('#ai-voice').parentElement.title='This browser has no speech voice';}
$('#ai-voice').onchange=()=>{try{localStorage.setItem('adamanteum-voice',$('#ai-voice').checked?'1':'0');}catch{}if(!$('#ai-voice').checked)voice.stop();};
$('#ai-voice-stop').onclick=()=>voice.stop();
$('#ai-panel').addEventListener('close',()=>{});
$('#ai-form').onsubmit=async e=>{
 e.preventDefault();if(!aiConnection||aiBusy)return;
 const message=$('#ai-message').value.trim();if(!message)return;
 const context=$('#ai-context').checked&&currentDoc;aiBusy=true;$('#ai-send').disabled=true;
 const user=el('div',undefined,'chat-message user');user.append(el('small','YOU'),el('p',message));$('#ai-conversation').append(user);
 const reply=el('div','Waiting for your AI…','chat-message');$('#ai-conversation').append(reply);
 try{
  const result=await post('ai/chat',{connectionId:aiConnection.id,message,...imageSharing.payload(),documentIds:context?[currentDoc.id]:[],allowContext:!!context,knowledgeSelection:knowledgeCheck.checked?selectedKnowledge:null,allowKnowledge:knowledgeCheck.checked,allowSearch:$('#ai-search').checked,approvedUrls:$('#ai-urls').value.split('\n').map(s=>s.trim()).filter(Boolean)});
  reply.replaceChildren(el('small',result.ai),el('p',result.answer));
  if($('#ai-voice').checked){for(const v of voiceViews)v.root.querySelector('.voice-tag').textContent=result.ai||'Assistant';voice.speak(result.answer);}
  for(const source of result.sources){const b=el('button','Source: '+source.title);b.onclick=()=>{$('#ai-panel').close();openDoc(source.id);};reply.append(b);}
  for(const source of result.knowledgeSources||[]){const b=el('button','Knowledge: '+source.title);b.onclick=()=>{$('#ai-panel').close();knowledgeWorkspace.open(source);};reply.append(b);}
  for(const source of result.webSources||[]){const a=el('a','Web source: '+source.title);a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';reply.append(a);}
  if(result.trace?.length)reply.append(el('small',result.trace.map(t=>t.tool+': '+t.status).join(' · ')));
  for(const note of result.notices||[]){const p=el('p',note);p.className='ai-notice';p.setAttribute('role','status');reply.append(p);}
  $('#ai-message').value='';
  imageSharing.clear();
 }catch(err){reply.textContent='Request failed: '+err.message;}
 finally{aiBusy=false;knowledgeCheck.checked=false;$('#ai-send').disabled=!aiConnection;}
};
$('#browser-open').onclick=()=>$('#browser-panel').showModal();$('#browser-close').onclick=()=>$('#browser-panel').close();
$('#browser-form').onsubmit=e=>{e.preventDefault();try{const url=new URL($('#browser-url').value);if(url.protocol!=='https:'||url.username||url.password)throw Error('Use an HTTPS address without embedded credentials.');$('#browser-reading').hidden=true;$('#workspace-browser').hidden=false;$('#workspace-browser').src=url.href;$('#browser-external').href=url.href;}catch(err){$('#browser-url').setCustomValidity(err.message);$('#browser-url').reportValidity();}};
$('#browser-read').onclick=async()=>{const button=$('#browser-read');button.disabled=true;$('#browser-status').textContent='Reading public page…';try{const page=await post('browser/read',{url:$('#browser-url').value});$('#workspace-browser').hidden=true;$('#browser-reading').hidden=false;$('#browser-reading').replaceChildren(el('h2',page.title),el('p',page.text));$('#browser-status').textContent=`Read ${page.text.length.toLocaleString()} characters · ${page.mode}`;$('#browser-external').href=page.url;}catch(e){$('#browser-status').textContent=e.message;}finally{button.disabled=false;}};
$('#browser-ai').onclick=()=>{try{const url=new URL($('#browser-url').value);if(url.protocol!=='https:'||url.username||url.password||url.search)throw Error('Choose a public HTTPS page without credentials or query parameters.');url.hash='';$('#ai-urls').value=url.href;$('#browser-panel').close();$('#ai-open').click();$('#ai-message').value='Read this approved page and explain its key points: '+url.href;}catch(e){$('#browser-status').textContent=e.message;}};
$('#browser-url').oninput=()=>$('#browser-url').setCustomValidity('');
let listsAt=0,listsPending=false,previousPhase='',previousDocuments=0,previousGraph=false,previousCompleted='',indexPrefetched=false;
// Phone: ask the service worker to save the search index itself. On a first visit this page is not yet controlled by the worker, so a plain fetch from here would not be cached.
function saveOfflineIndex(){if(!('serviceWorker' in navigator))return;navigator.serviceWorker.ready.then(reg=>{if(reg.active)reg.active.postMessage({type:'save-offline-index'});}).catch(()=>{});}
async function status(){
 try{
  const s=await api('status');
  const vaultKey=location.origin+':'+(s.source||'vault');big.setVault(vaultKey);graph.setVault(vaultKey);
  $('.library h1').replaceChildren(document.createTextNode(s.source||'Your vault'),el('span','.'));
  $('#status').textContent=s.phase==='ready'?`${s.documents.toLocaleString()} documents · ${s.links.toLocaleString()} links`:`${s.phase} · ${s.indexed.toLocaleString()} / ${(s.total||0).toLocaleString()} documents`;
  if(s.snapshot&&s.completed)$('#status').textContent+=` · snapshot ${new Date(s.completed).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
  if(s.refresh&&s.refresh.phase!=='ready')$('#status').textContent+=s.refresh.phase==='error'?` · refresh failed: ${s.refresh.error}`:` · background ${s.refresh.phase}`;
  else if(s.watching)$('#status').textContent+=' · live updates';
  if(s.errors||s.skipped)$('#status').textContent+=` · ${s.errors} errors, ${s.skipped} skipped`;
  // FIVE1: the folder list and the recent list were rebuilt on every refresh the indexer finished (every few seconds while sessions write); at most once a minute now unless the index itself changed state.
  if(s.phase!==previousPhase||(!previousDocuments&&s.documents)||s.graphReady!==previousGraph){listsAt=Date.now();listsPending=false;groups().catch(()=>{});search();}
  else if(s.completed!==previousCompleted)listsPending=true;
  if(listsPending&&Date.now()-listsAt>60000){listsAt=Date.now();listsPending=false;groups().catch(()=>{});search();}
  // FIVE1: with a dozen sessions writing to the vault, every refresh reported changes and the whole map was fetched (7 MB) and laid out again from nothing, so it never settled. Draw it once, then at most every ten minutes after a change (every 30 s while still indexing; again after 10 s if a draw failed).
  // The map is drawn again only when the number of notes has moved by 1 percent (at least 500) since it was drawn, so a map that is still right is never reshuffled.
  statusDocs=s.documents||0;
  {const age=Date.now()-lastGraphAt,moved=graphDocs&&statusDocs&&Math.abs(statusDocs-graphDocs)>=Math.max(500,Math.round(graphDocs*0.01));if((s.completed&&!previousCompleted)||(!s.completed&&age>30000)||(moved&&age>600000)||(graphFailed&&age>10000))loadGraph();}
  previousPhase=s.phase;previousDocuments=s.documents;previousGraph=s.graphReady;previousCompleted=s.completed;
  if(s.phase==='ready'&&!indexPrefetched){indexPrefetched=true;setTimeout(saveOfflineIndex,30000);}
 }catch(e){$('#status').textContent=e.message;}
 setTimeout(status,5000);
}
initOrganizer({el,api,post,graph,openDoc});
initVaultTools({el,api,post,openDoc,currentDocument:()=>currentDoc});
initNotebook({currentDocument:()=>currentDoc,renderMarkdown:readingView});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js',{type:'module'}).catch(()=>{});
api('workspace/obsidian-import').then(report=>{
 if(!report?.hasObsidian||!report.text)return;
 try{if(localStorage.getItem('adamanteum-obsidian-import-seen'))return;localStorage.setItem('adamanteum-obsidian-import-seen','1');}catch{return;}
 const dialog=el('dialog');dialog.className='workspace-dialog';dialog.id='obsidian-import-report';
 const head=el('div',undefined,'spot-head');head.append(el('span','OBSIDIAN SETTINGS'),el('button','Close'));
 head.querySelector('button').onclick=()=>dialog.close();
 const content=el('div',undefined,'workspace-content');
 const body=el('pre',report.text);body.style.whiteSpace='pre-wrap';
 content.append(el('p','The same report as import-obsidian. Shown the first time this vault is opened.'),body);
 dialog.append(head,content);document.body.append(dialog);dialog.showModal();
}).catch(()=>{});
status();groups();search(); // FIVE1: the first status answer draws the graph (it asked twice before: two 7 MB fetches at start)
setTimeout(()=>{if(!lastGraphAt)loadGraph();},8000); // and if the status answer never comes, draw it anyway

const openNode=initOpenNode({el,api,openDoc,readingView,closeSpot:()=>spot.close()});
const programUI=initPrograms({el,api,post,openDoc,openNode,refreshGraph:()=>{if(big.active)loadGraph();}});
const ringUI=initRingIndex({el,api,openDoc,post,reload:()=>{if(big.active)loadGraph();},openProgram:name=>{const p=big.programs.find(q=>q.name===name&&!q.orb);if(p)programUI.open(p);},big});
{const ringBtn=el('button','Ring index','graph-gear');ringBtn.id='ring-index-open';ringBtn.title='Adapters, connectors and extensions, by kind, trade, category and program';ringBtn.onclick=()=>ringUI.open();panel.gear.after(ringBtn);}
// FIVE1: the shared Talk to Assistant box in the top bar; started after the first screen so it never delays the graph.
// A local test hook (add ?adamdebug to the address): lets a headless check open a program the same way a click on its node does.
try{if(new URLSearchParams(location.search).has('adamdebug'))window.__adam={big,programUI,openNode,openDoc};}catch{}
