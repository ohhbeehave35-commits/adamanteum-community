import {interactionBudget,labelRebuildDue,arrowCandidates,INTERACTION_MS,fitAtlas,tallStretch,atlasViewport,programLabelIndices,placeProgramLabels,ATLAS_BOTTOM_PADDING,screenRadius,arrowAlpha,MAX_ARROWS,nodeColor,readPins,savePins,coalesceFrame,throttleLatest} from './atlas-settings.js';
import {BIG_DEFAULTS,sanitizeForces} from './bigphysics.js';
// The whole-vault map: every note a dot, every link a thin line, drawn by the graphics card, laid out in a worker.
// It sits over the ordinary atlas and borrows its controls (panel, Animate bar, search) through attach().
// ADAMCAP4: the three orb families are drawn in their own colours, apart from the program islands' palette.
const ORB_COLORS={adapter:'#f2a93b',connector:'#3fc1c9',extension:'#b58cf0',user:'#f26d85'},ORB_COLORS_LIGHT={adapter:'#b8700a',connector:'#12868f',extension:'#7a4fc4',user:'#c2334f'},ORB_GLYPH={adapter:'◆ ',connector:'⇄ ',extension:'✦ ',user:'▣ '};
const NODE_VS=`#version 300 es
in vec2 aPos;in float aSize;in vec4 aColor;in float aT;
uniform vec2 uView;uniform vec3 uCam;uniform float uDpr,uSizeK,uLapse,uMinPx,uBoost,uSc;uniform vec4 uOverride;
out vec4 vColor;out float vPhantom;
void main(){
 vec2 p=aPos*uCam.z+uCam.xy;
 gl_Position=vec4(p.x*2./uView.x-1.,1.-p.y*2./uView.y,0.,1.);
 float px=clamp(max(uMinPx,aSize*uSizeK*uSc)*uBoost,.7,12.)*uDpr;
 if(aT>uLapse||aSize<=0.){gl_Position=vec4(2.,2.,2.,1.);px=0.;}
 gl_PointSize=px;vPhantom=aColor.a<.8?1.:0.;vColor=uOverride.a>0.?uOverride:aColor;
}`;
const NODE_FS=`#version 300 es
precision mediump float;in vec4 vColor;in float vPhantom;uniform float uAlpha,uGlow;out vec4 o;
void main(){float d=length(gl_PointCoord-.5)*2.;if(d>1.||(vPhantom>.5&&d<.58))discard;float a=mix(1.,smoothstep(1.,.62,d),uGlow)*(vPhantom>.5?.55:vColor.a)*uAlpha;o=vec4(vColor.rgb*a,a);}`;
const EDGE_VS=`#version 300 es
in vec2 aPos;in float aT;in vec3 aColor;out vec3 vColor;
uniform vec2 uView;uniform vec3 uCam;uniform float uLapse;
void main(){
 vec2 p=aPos*uCam.z+uCam.xy;
 gl_Position=vec4(p.x*2./uView.x-1.,1.-p.y*2./uView.y,0.,1.);
 vColor=aColor;if(aT>uLapse)gl_Position=vec4(2.,2.,2.,1.);
}`;
const EDGE_FS=`#version 300 es
precision mediump float;uniform vec4 uColor;uniform float uTint;in vec3 vColor;out vec4 o;
void main(){o=vec4(mix(uColor.rgb,vColor,uTint)*uColor.a,uColor.a);}`;
const LAYOUT_SLOTS=['pointerdown','pointermove','pointerup','pointercancel','wheel','pointerleave'];
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const hex=h=>{const n=parseInt(h.slice(1),16);return [(n>>16&255)/255,(n>>8&255)/255,(n&255)/255];};
// ADAMLOOK3: how the generated code-map notes are drawn. Default 'both'. For a side-by-side look: add ?genlook=plain|program|dim|both to the address.
// WRONGLOOK1 ("organic, almost like mycelium"): the mycelium look is the default. It keeps one colour per program and folder but pales them toward white so the fine threads read first,
// draws the notes small, fits the view to the main mass (the program ring waits just outside, and its labels come in when you zoom), and keeps the generated code notes dim.
// ?look=classic brings back the previous coloured look for a side-by-side.
function lookChoice(){try{const q=new URLSearchParams(globalThis.location?.search||'').get('look');return q==='classic'?'classic':'mycelium';}catch{return 'mycelium';}}
const TUNE=(()=>{try{const q=new URLSearchParams(globalThis.location?.search||'');const g=(k,d)=>Number.isFinite(Number(q.get(k)))&&q.get(k)!==null?Number(q.get(k)):d;return {nk:g('nk',1),eb:g('eb',1),mx:g('mx',.4),em:g('em',.3),na:g('na',255),gq:g('gq',.9),ga:g('ga',190),tm:g('tm',1),ik:g('ik',.3),dx:g('dx',.22)};}catch{return {nk:1,eb:1,mx:.4,dx:.22,em:.3,na:255,gq:.9,ga:190,tm:1,ik:.3};}})();
function genLookChoice(){try{const q=new URLSearchParams(globalThis.location?.search||'').get('genlook');return ['plain','program','dim','both'].includes(q)?q:'both';}catch{return 'both';}}

// The hover caption sits 22 px under its dot but never past the right edge, the top controls (46) or the bottom bar (84).
export function captionPlacement(x,y,width,w,h,topBand=46,bottomBand=84){const half=11,cy=y+22>h-bottomBand-half?y-22:y+22;return {x:Math.max(4,Math.min(x,w-width-4)),y:Math.max(topBand+half,Math.min(cy,h-bottomBand-half))};}
// Auto-exposure: the share of lit pixels that may be solid (alpha >= 235/255) at the fitted view, and the dimmest exposure allowed.
export const DESK_MIN_WIDTH=700;
export const EXPOSE_TARGET=.2,EXPOSE_TARGET_LIGHT=.1,EXPOSE_MIN=.12;
// The mycelium look tints every note toward a pole colour: near-white on the dark themes, ink on Ivory (near-white tints on an Ivory page vanish: ADAMLOOK 28 Oct, "in Ivory it's completely blown out").
export const MYC_POLE_DARK=[.9,.9,.94],MYC_POLE_LIGHT=[.3,.32,.42];
export class BigAtlas{
 constructor(host,callbacks={}){
  this.host=host;host.bigAtlas=this;this.callbacks=callbacks;this.active=false;this.loaded=false;
  this.gl=document.createElement('canvas');this.gl.id='graph-big';this.gl.setAttribute('aria-label','Whole-vault map. Drag to pan, scroll to zoom, hover a note to see its links, click to open it.');
  this.ink=document.createElement('canvas');this.ink.id='graph-big-ink';
  for(const c of [this.gl,this.ink]){c.style.cssText='position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:none;';}
  this.ink.style.cursor='grab';(host.querySelector('#graph')||host.firstChild).after(this.gl,this.ink);// right after the ordinary canvas, so the buttons and panel stay above and clickable
  this.display={nodeSize:1,linkThickness:1,textFade:.45,orphans:true,attachments:true,colorBy:'folder',palette:'Spectrum',linkTint:true,glow:true,animateSpeed:1};
  this.forces={...BIG_DEFAULTS};this.view={x:0,y:0,z:1};this.goal=null;this.autoFit=true;this.pointers=new Map();
  this.hover=-1;this.selected=-1;this.match=null;this.lapse=null;this.palette=['#b49be8'];this.stats={frames:0,last:performance.now(),fps:0};
  this.dirty=true;this.frame=0;this.light=false;
  this.interactingUntil=0;this.detailTimer=0;this.labelBuiltAt=-Infinity;this.programBuiltAt=-Infinity;
  this.labelIds=new Uint32Array(260);this.labelAlphas=new Float32Array(260);this.labelCount=0;
  this.labelX=new Float32Array(260);this.labelY=new Float32Array(260);this.labelCells=new Int32Array(1);
  this.arrowIds=new Uint32Array(MAX_ARROWS);this.arrowState={};this.singleHover=new Uint32Array(1);
  this.focusEdges=new Float32Array(4096*4);this.focusCache=null;this.programBoxes=[];
  this.refreshInkTheme();this.themeObserver=new MutationObserver(()=>{this.refreshInkTheme();this.programBuiltAt=-Infinity;this.drawSoon();});this.themeObserver.observe(document.body,{attributes:true,attributeFilter:['data-theme']});
  new ResizeObserver(()=>this.resize()).observe(host);
  this.pins=new Map();this.vault='';this.queuePaint=coalesceFrame(()=>{this.paintNodes();this.drawSoon();});this.sendForces=throttleLatest(forces=>this.worker?.postMessage({type:'forces',forces}));this.bind();
  const dock=document.querySelector('.workspace-switcher');this.dock=dock;
  const syncDock=()=>{const map=this.host.getBoundingClientRect(),row=this.dock?.getBoundingClientRect();const overlap=row&&row.bottom>map.top&&row.top<map.bottom?Math.max(0,map.bottom-row.top):0;const clearance=Math.max(72,Math.ceil(overlap));
   if(clearance===this.dockClearance)return;this.dockClearance=clearance;this.bottomPadding=Math.max(ATLAS_BOTTOM_PADDING,clearance+60);this.host.style.setProperty('--atlas-dock-clearance',clearance+'px');this.host.style.setProperty('--atlas-bottom-padding',this.bottomPadding+'px');if(this.loaded&&this.autoFit)this.fit(true);this.drawSoon();};
  this.syncDock=syncDock;const chromeObserver=new ResizeObserver(syncDock);chromeObserver.observe(host);if(dock)chromeObserver.observe(dock);window.addEventListener('scroll',syncDock,{passive:true});window.addEventListener('resize',syncDock);syncDock();
 }
 setVault(key){if(this.vault===key)return;this.vault=key;this.pins=readPins(globalThis.localStorage,key);this.restorePins();}
 restorePins(){if(!this.index)return;for(const [id,[x,y]] of this.pins){const i=this.index.get(Number(id));if(i!==undefined)this.worker?.postMessage({type:'pin',i,x,y});}}
 unpinAll(){for(const id of this.pins.keys()){const i=this.index?.get(Number(id));if(i!==undefined)this.worker?.postMessage({type:'unpin',i});}this.pins.clear();savePins(globalThis.localStorage,this.vault,this.pins);this.drawSoon();}
 refreshInkTheme(){const style=getComputedStyle(document.body);this.inkColor=style.getPropertyValue('--text').trim()||'#eee';this.inkBack=style.getPropertyValue('--graph').trim()||'#222';this.inkAccent=style.getPropertyValue('--accent').trim()||'#b49be8';}
 markInteraction(){this.interactingUntil=performance.now()+INTERACTION_MS;clearTimeout(this.detailTimer);this.detailTimer=setTimeout(()=>{this.detailTimer=0;this.labelKey=null;this.programBuiltAt=-Infinity;this.dirty=true;this.drawSoon();},INTERACTION_MS);}
 // ---------- data
 setData(d){
  this.hover=-1;this.selected=-1;this.traceFrom=-1;this.match=null;this.trail=null;this.labelKey=null;this.grid=null;this.rebuildGrid=true;
  this.phantom=Uint8Array.from(d.phantom||new Array(d.n).fill(0));this.n=d.n;this.ids=Int32Array.from(d.ids);this.degree=Uint32Array.from(d.degree);this.degreeOrder=Uint32Array.from({length:d.n},(_,i)=>i);this.degreeOrder.sort((a,b)=>this.degree[b]-this.degree[a]||a-b);this.labelImportance=Float32Array.from(this.degree,d=>1+.28*Math.log2(1+d));this.folder=Uint16Array.from(d.folder);this.folders=d.folders;this.gen=Int32Array.from(d.gen||[]);this.genPrograms=d.genPrograms||[];this.genLook=genLookChoice();this.look=lookChoice();
  this.mtime=Int32Array.from(d.mtime);this.kind=Uint8Array.from(d.kind||new Array(d.n).fill(0));this.edges=Uint32Array.from(d.edges);this.m=this.edges.length>>1;
  this.index=new Map();for(let i=0;i<this.n;i++)this.index.set(this.ids[i],i);
  this.island=Uint32Array.from(d.island||new Array(d.n).fill(0));this.islandNodes=new Map();for(let i=0;i<d.n;i++){const k=this.island[i];if(k){if(!this.islandNodes.has(k))this.islandNodes.set(k,[]);this.islandNodes.get(k).push(i);}}this.lastAspect=1;this.programs=d.programs||[];this.ringSplit=d.ringSplit||0;this.familyByIsland=new Map();for(const p of this.programs)if(p.family)this.familyByIsland.set(p.index,p.family);this.programOrder=this.programs.length?[...this.programs].sort((a,b)=>a.index-b.index).map(p=>p.hub):Array.from({length:this.n},(_,i)=>i).filter(i=>this.kind[i]===3);this.titles=null;this.programLabelWidth=160;
  // adjacency in compressed form, for hover, neighbours and the shortest path
  const start=new Uint32Array(this.n+1);for(let e=0;e<this.edges.length;e++)start[this.edges[e]+1]++;
  for(let i=0;i<this.n;i++)start[i+1]+=start[i];
  const fill=start.slice(0,this.n),adj=new Uint32Array(this.edges.length),eid=new Uint32Array(this.edges.length);
  for(let e=0;e<this.m;e++){const a=this.edges[2*e],b=this.edges[2*e+1];adj[fill[a]]=b;eid[fill[a]++]=e;adj[fill[b]]=a;eid[fill[b]++]=e;}
  this.adjStart=start;this.adj=adj;this.adjEdge=eid;
  // time order for Animate
  const order=Array.from({length:this.n},(_,i)=>i).sort((a,b)=>this.mtime[a]-this.mtime[b]||a-b);
  this.rank=new Float32Array(this.n);this.timeOrder=Uint32Array.from(order);for(let k=0;k<this.n;k++)this.rank[order[k]]=(k+1)/this.n;
  this.pos=new Float32Array(this.n*2);this.epos=new Float32Array(this.m*4);
  this.focusCache=null;this.labelBuiltAt=-Infinity;this.programBuiltAt=-Infinity;this.loaded=true;this.initGL();this.startWorker();this.dirty=true;this.drawSoon();
 }
 setTitles(list){this.titles=list;this.shortTitles=list.map(t=>t.length>44?t.slice(0,43)+'\u2026':t);this.programBuiltAt=-Infinity;const c=this.ink.getContext('2d');c.font='17.34px system-ui';this.titleWidths=Float32Array.from(this.shortTitles,t=>c.measureText(t).width);c.font='600 17.34px system-ui';this.programLabelWidth=Math.max(0,...this.programOrder.map(i=>c.measureText(this.title(i)).width+8));if(this.autoFit)this.fit(true);this.dirty=true;this.drawSoon();}
 startWorker(){
  this.stopWorker();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches&&!this.motionOverride;
  this.worker=new Worker('/big-worker.js',{type:'module'});this.version=(this.version||0)+1;this.asleep=false;this.alpha=1;
  this.worker.onmessage=({data:m})=>{
   if(m.type!=='pos'||m.version!==this.version)return;
   if(!this.markedFirst){this.markedFirst=true;try{performance.mark('adam-first-layout');}catch{}}if(m.final)try{performance.mark('adam-layout-settled');}catch{}
   this.layoutPos=m.positions;this.pos=m.positions;this.applyViewMode();this.posVersion=(this.posVersion|0)+1;this.alpha=m.alpha;this.asleep=m.asleep;this.moved=true;
   if(m.final){this.programBuiltAt=-Infinity;this.exposure=1;this.expDue=true;}if(m.final&&this.callbacks.settled)this.callbacks.settled();
   this.rebuildGrid=true;this.dirty=true;this.drawSoon();
   this.worker?.postMessage({type:'ack',version:m.version});
  };
  const edges=this.edges.slice();
  this.worker.postMessage({type:'init',n:this.n,edges,island:this.island,forces:this.forces,version:this.version,settle:reduced,ringSplit:this.ringSplit},[edges.buffer]);this.restorePins();
 }
 stopWorker(){if(this.worker){this.worker.postMessage({type:'stop'});this.worker.terminate();this.worker=null;}}
 // ---------- graphics
 initGL(){
  const gl=this.ctx=this.gl.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,powerPreference:'high-performance'});
  if(!gl){this.noGL=true;return;}
  // ADAMCAP4: if the graphics card drops the drawing context (memory pressure, a driver reset) the map used to stay blank for good. Now it is
  // told to wait, and when the browser gives the context back everything is rebuilt from the data the page still holds.
  if(!this.glGuard){this.glGuard=true;this.gl.addEventListener('webglcontextlost',e=>{e.preventDefault();this.glLost=true;this.glLosses=(this.glLosses||0)+1;});
   this.gl.addEventListener('webglcontextrestored',()=>{this.glLost=false;this.initGL();if(this.pos&&this.ctx){this.moved=true;this.uploadPositions();}this.dirty=true;this.drawSoon();});}
  const build=(vs,fs)=>{const p=gl.createProgram();for(const [t,s] of [[gl.VERTEX_SHADER,vs],[gl.FRAGMENT_SHADER,fs]]){const h=gl.createShader(t);gl.shaderSource(h,s);gl.compileShader(h);if(!gl.getShaderParameter(h,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(h));gl.attachShader(p,h);}gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p;};
  this.nodeProg=build(NODE_VS,NODE_FS);this.edgeProg=build(EDGE_VS,EDGE_FS);
  const loc=(p,names,u)=>Object.fromEntries(names.map(n=>[n,(u?gl.getUniformLocation(p,n):gl.getAttribLocation(p,n))]));
  this.nu=loc(this.nodeProg,['uView','uCam','uDpr','uSizeK','uLapse','uMinPx','uBoost','uOverride','uAlpha','uSc','uGlow'],true);
  this.na=loc(this.nodeProg,['aPos','aSize','aColor','aT']);
  this.eu=loc(this.edgeProg,['uView','uCam','uLapse','uColor','uTint'],true);this.ea=loc(this.edgeProg,['aPos','aT','aColor']);
  const buf=(data,usage)=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data,usage);return b;};
  this.posBuf=buf(this.pos.byteLength,gl.DYNAMIC_DRAW);
  this.sizeBuf=buf(this.n*4,gl.DYNAMIC_DRAW);this.colorBuf=buf(this.n*4,gl.DYNAMIC_DRAW);this.timeBuf=buf(this.rank,gl.STATIC_DRAW);
  const et=new Float32Array(this.m*2);for(let e=0;e<this.m;e++){const t=Math.max(this.rank[this.edges[2*e]],this.rank[this.edges[2*e+1]]);et[2*e]=t;et[2*e+1]=t;}
  this.edgePosBuf=buf(this.epos.byteLength,gl.DYNAMIC_DRAW);this.edgeTimeBuf=buf(et,gl.STATIC_DRAW);
  this.hoverEdgeBuf=buf(4*4*4096,gl.DYNAMIC_DRAW);this.hoverNodeBuf=gl.createBuffer();
  this.edgeColorBuf=buf(this.m*6*4,gl.DYNAMIC_DRAW);this.paintNodes();
 }
 visible(i){return (this.display.orphans||this.degree[i])&&(this.display.attachments!==false||this.kind[i]!==1)&&(this.display.ring!==false||!this.island[i]);}
 radius(i){return (this.kind[i]===3?5:this.kind[i]===6?1.35:1.15)+Math.min(6.5,Math.sqrt(this.degree[i])*.62);}
 // ADAMLOOK3: the generated GRAPHIFY code-map notes. 'program' colours them by program (the colour of that program's island where it has one, else a steady pick from the palette,
 // one colour per code community inside the big flat export); 'dim' draws them smaller and fainter than real records; 'both' does both. 'plain' is the old one-folder-colour look.
 genColors(pal){
  const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,''),alias={};
  const byName=new Map();for(const p of this.programs)if(p.index)byName.set(norm(p.name),p.index);
  return this.genPrograms.map((key,k)=>{
   const [kind,name]=[key.slice(0,key.indexOf(':')+1||key.length),key.slice(key.indexOf(':')+1)];
   if(kind==='prog:'){const n=norm(name),idx=byName.get(n)||byName.get(alias[n]||'');if(idx)return hex(nodeColor({island:idx,kind:3},this.display,this.light));}
   let h=2166136261;for(let j=0;j<key.length;j++){h^=key.charCodeAt(j);h=Math.imul(h,16777619);}
   return pal[(h>>>0)%pal.length];
  });
 }
 paintNodes(){
  if(!this.ctx||!this.loaded)return;const gl=this.ctx,n=this.n,size=new Float32Array(n),color=new Uint8Array(n*4);this.nodeVisible=new Uint8Array(n);this.visibleVersion=(this.visibleVersion||0)+1;this.programBuiltAt=-Infinity;
  const memo=(this.display.colorBy==='age'||this.display.colorBy==='links')?null:new Map(),plain=this.light?[.28,.3,.38]:[.9,.9,.94],green=hex(this.light?'#2f8a4b':'#7ad98f'),by=this.display.colorBy,pal=this.palette.map(hex);
  const desk=this.deskLook(),pole=desk&&this.light?MYC_POLE_LIGHT:MYC_POLE_DARK;this.tintK={island:desk?TUNE.ik:.55,main:desk?TUNE.dx:TUNE.mx,desk};const myc=this.look==='mycelium',genOn=this.gen&&this.gen.length&&this.genLook!=='plain',genColour=genOn&&(this.genLook==='program'||this.genLook==='both')?this.genColors(pal):null,genQuiet=genOn&&(this.genLook==='dim'||this.genLook==='both');
  const groups=by==='custom'?(this.customGroups||[]).filter(g=>g.query&&g.query.trim()).map(g=>({q:g.query.trim().toLowerCase().replace(/^path:/,''),c:hex(g.color)})):[];
  for(let i=0;i<n;i++){
   this.nodeVisible[i]=this.visible(i)?1:0;size[i]=this.nodeVisible[i]?this.radius(i)*(genQuiet&&this.gen[i]?(myc?.85:.62):1)*(myc&&!this.island?.[i]?TUNE.nk:1):0;
   // Notes of one folder, island and kind share a colour unless colour follows age or links: work it out once per kind of note, not once per note.
   let c;if(memo){const mk=(this.folder?.[i]||0)*1048576+(this.island?.[i]||0)*16+this.kind[i];c=memo.get(mk);if(!c){c=hex(nodeColor({folder:this.folder?.[i]||0,age:0,degree:0,island:this.island?.[i]||0,kind:this.kind[i]},this.display,this.light));memo.set(mk,c);}}else c=hex(nodeColor({folder:this.folder?.[i]||0,age:this.rank[i],degree:this.degree[i],island:this.island?.[i]||0,kind:this.kind[i]},this.display,this.light));
   if(groups.length&&this.titles){const t=(this.titles[i]||'').toLowerCase(),f=(this.folders[this.folder[i]]||'').toLowerCase();for(const g of groups)if(t.includes(g.q)||f.includes(g.q)){c=g.c;break;}}
   if(this.kind[i]===2)c=green;
   {const fam=this.familyByIsland?.get(this.island[i]);if(fam)c=this.light?hex(ORB_COLORS_LIGHT[fam]):hex(ORB_COLORS[fam]);}

   if(genColour&&this.gen[i]){const gc=genColour[this.gen[i]-1];if(gc)c=gc;}
   if(myc&&!desk){const k=this.island?.[i]?.55:TUNE.mx;c=[.9+(c[0]-.9)*k,.9+(c[1]-.9)*k,.94+(c[2]-.94)*k];}
   else if(myc){const k=this.island?.[i]?TUNE.ik:TUNE.dx;c=[pole[0]+(c[0]-pole[0])*k,pole[1]+(c[1]-pole[1])*k,pole[2]+(c[2]-pole[2])*k];}
   color[4*i]=c[0]*255;color[4*i+1]=c[1]*255;color[4*i+2]=c[2]*255;color[4*i+3]=this.phantom[i]?140:(genQuiet&&this.gen[i]?(myc?TUNE.ga:105):(myc&&!this.island?.[i]?TUNE.na:255));
  }
  this.nodeColors=color;const ec=new Float32Array(this.m*6);for(let e=0;e<this.m;e++){const q=genQuiet&&this.gen[this.edges[e*2]]?(myc?TUNE.gq:.5):1;for(let j=0;j<6;j++){const v=color[this.edges[e*2]*4+j%3]/255,pl=pole[j%3];ec[e*6+j]=(myc?pl+(v-pl)*TUNE.em:v)*q;}}gl.bindBuffer(gl.ARRAY_BUFFER,this.edgeColorBuf);gl.bufferData(gl.ARRAY_BUFFER,ec,gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.sizeBuf);gl.bufferData(gl.ARRAY_BUFFER,size,gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.colorBuf);gl.bufferData(gl.ARRAY_BUFFER,color,gl.DYNAMIC_DRAW);this.dirty=true;this.labelKey=null;if(this.hover>=0&&!this.visible(this.hover))this.hover=-1;
  const et=new Float32Array(this.m*2);for(let e=0;e<this.m;e++){const a=this.edges[2*e],b=this.edges[2*e+1],t=this.visible(a)&&this.visible(b)?Math.max(this.rank[a],this.rank[b]):3;et[2*e]=et[2*e+1]=t;}gl.bindBuffer(gl.ARRAY_BUFFER,this.edgeTimeBuf);gl.bufferData(gl.ARRAY_BUFFER,et,gl.DYNAMIC_DRAW);
 }
 resize(){
  const r=this.host.getBoundingClientRect();if(!r.width)return;this.w=r.width;this.h=r.height;this.labelCells=new Int32Array((Math.ceil(this.w/90)+2)*(Math.ceil(this.h/22)+2));this.programBuiltAt=-Infinity;this.dpr=Math.min(devicePixelRatio||1,2);
  for(const c of [this.gl,this.ink]){c.width=Math.round(this.w*this.dpr);c.height=Math.round(this.h*this.dpr);}
  if(this.loaded&&(Math.abs(this.islandAspect()-(this.lastAspect||1))>.05||Math.abs(tallStretch(this.w,this.h)-(this.lastTall||1))>.05))this.applyViewMode();
  if(this.loaded&&this.autoFit)this.fit(true);{const d=this.deskLook();this.exposure=1;this.expDue=true;if(this.loaded&&this.wasDesk!==undefined&&this.wasDesk!==d)this.paintNodes();this.wasDesk=d;}this.dirty=true;this.drawSoon();
 }
 // Alternate views reuse the loaded columns and leave the worker layout intact.
 applyViewMode(){
  if(!this.layoutPos)return;this.pos=this.layoutPos;
  if(this.cellular||this.timelineMode){this.pos=this.layoutPos.slice();const span=Math.sqrt(this.n)*2;
   for(let i=0;i<this.n;i++){if(this.island[i])continue;if(this.timelineMode){this.pos[2*i]=(this.rank[i]-.5)*span*3;this.pos[2*i+1]=(this.folder[i]%32-16)*span/20;}else{const x=this.pos[2*i],y=this.pos[2*i+1],d=Math.hypot(x,y)||1,r=span*Math.tanh(d/span);this.pos[2*i]=x/d*r*1.2;this.pos[2*i+1]=y/d*r*.8;}}
   for(const [id,p] of this.pins){const i=this.index.get(Number(id));if(i!==undefined){this.pos[i*2]=p[0];this.pos[i*2+1]=p[1];}}
  }this.spreadIslands();this.moved=true;this.rebuildGrid=true;this.labelKey=null;
 }
 // On a wide map the program islands are spread sideways in proportion to the map shape, so the picture fills the width instead of sitting in a square with empty sides.
 islandAspect(){if(!this.w||!this.h)return 1;const raw=this.w/this.h;return raw<1.15?1:Math.min(2.2,raw*.9);}
 spreadIslands(){const A=this.islandAspect(),T=tallStretch(this.w,this.h);this.lastAspect=A;this.lastTall=T;if(T>1&&this.look==='mycelium'&&this.n){if(this.pos===this.layoutPos)this.pos=this.layoutPos.slice();const k=1+(T-1)*TUNE.tm;for(let i=0;i<this.n;i++){if(this.island[i]||this.pins.has(this.ids[i]))continue;this.pos[2*i+1]*=k;}}
  if((A<=1&&T<=1)||!this.programs.length||!this.islandNodes)return;if(this.pos===this.layoutPos)this.pos=this.layoutPos.slice();for(const p of this.programs){const dx=(A-1)*this.pos[2*p.hub],dy=T>1?(T-1)*this.pos[2*p.hub+1]:0;if(!dx&&!dy)continue;for(const i of this.islandNodes.get(p.index)||[]){if(this.pins.has(this.ids[i]))continue;this.pos[2*i]+=dx;this.pos[2*i+1]+=dy;}}}
 cell(){this.cellular=!this.cellular;this.timelineMode=false;this.atlas.cellular=this.cellular;this.atlas.timelineMode=false;this.applyViewMode();this.fit();this.drawSoon();}
 timeline(){this.timelineMode=!this.timelineMode;this.cellular=false;this.atlas.timelineMode=this.timelineMode;this.atlas.cellular=false;this.applyViewMode();this.fit();this.drawSoon();}
 // ---------- view
 extent(all=false){
  if(!all&&this.look==='mycelium'&&this.island?.some(k=>k>0)){const stride=Math.max(1,Math.floor(this.n/8000)),xs=[],ys=[];for(let i=0;i<this.n;i+=stride){if(this.island[i])continue;xs.push(this.pos[2*i]);ys.push(this.pos[2*i+1]);}if(xs.length>50){xs.sort((a,b)=>a-b);ys.sort((a,b)=>a-b);const a=Math.floor(xs.length*.004),b=Math.min(xs.length-1,Math.floor(xs.length*.996));return {x0:xs[a],x1:xs[b],y0:ys[a],y1:ys[b]};}}
  if(this.island?.some(k=>k>0)){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(let i=0;i<this.n;i++){x0=Math.min(x0,this.pos[2*i]);x1=Math.max(x1,this.pos[2*i]);y0=Math.min(y0,this.pos[2*i+1]);y1=Math.max(y1,this.pos[2*i+1]);}return {x0,y0,x1,y1};}
  // 1st to 99th percentile of positions, so one far-flung note does not shrink the map
  const stride=Math.max(1,Math.floor(this.n/6000)),n=Math.ceil(this.n/stride),xs=new Float32Array(n),ys=new Float32Array(n);for(let i=0,k=0;k<n;i+=stride,k++){xs[k]=this.pos[2*i];ys[k]=this.pos[2*i+1];}
  xs.sort();ys.sort();const a=Math.floor(n*.004),b=Math.min(n-1,Math.floor(n*.996));return {x0:xs[a],x1:xs[b],y0:ys[a],y1:ys[b]};
 }
 fit(now=false){
  if(!this.loaded||!this.w||!this.h)return;
  const {z,x,y}=fitAtlas(this.w,this.h,this.extent(),this.programLabelWidth||160,this.bottomPadding||ATLAS_BOTTOM_PADDING);
  this.fitZoom=z;const goal={z,x,y};
  if(now||!this.goal)this.view={...goal};this.goal=goal;this.autoFit=true;this.dirty=true;this.drawSoon();
 }
 zoom(factor,cx=this.w/2,cy=this.h/2){
  const z=clamp(this.view.z*factor,(this.fitZoom||.05)*.5,60),k=z/this.view.z;this.autoFit=false;this.goal=null;
  this.view={z,x:cx-(cx-this.view.x)*k,y:cy-(cy-this.view.y)*k};this.dirty=true;this.drawSoon();
 }
 // Notes keep a readable size as you zoom in (they grow with the square root of the zoom, not with it), as Obsidian's do.
 sc(){const f=this.fitZoom||this.view.z;return f*Math.pow(Math.max(this.view.z/f,.2),.42);}
 toWorld(px,py){return {x:(px-this.view.x)/this.view.z,y:(py-this.view.y)/this.view.z};}
 // ---------- pointer
 bind(){
  const c=this.ink;
  c.addEventListener('pointerdown',e=>{this.markInteraction();c.setPointerCapture(e.pointerId);this.pointers.set(e.pointerId,{x:e.offsetX,y:e.offsetY});this.moved0={x:e.offsetX,y:e.offsetY};this.dragNode=this.pointers.size>1?-1:this.pick(e.offsetX,e.offsetY);this.dragging=false;this.autoFit=false;this.goal=null;c.style.cursor='grabbing';});
  c.addEventListener('pointermove',e=>{
   const p=this.pointers.get(e.pointerId);
   if(!p){this.setHover(this.pick(e.offsetX,e.offsetY));return;}
   this.markInteraction();if(this.pointers.size===2){this.dragNode=-1;const [a,b]=[...this.pointers.values()],before=Math.hypot(a.x-b.x,a.y-b.y);p.x=e.offsetX;p.y=e.offsetY;const after=Math.hypot(a.x-b.x,a.y-b.y);if(before>0)this.zoom(after/before,(a.x+b.x)/2,(a.y+b.y)/2);this.dragging=true;return;}
   const dx=e.offsetX-p.x,dy=e.offsetY-p.y;p.x=e.offsetX;p.y=e.offsetY;
   if(Math.abs(e.offsetX-this.moved0.x)+Math.abs(e.offsetY-this.moved0.y)>4)this.dragging=true;
   if(this.dragging&&this.dragNode>=0){const i=this.dragNode,w=this.toWorld(e.offsetX,e.offsetY);this.pins.set(this.ids[i],[w.x,w.y]);this.pos[2*i]=w.x;this.pos[2*i+1]=w.y;this.worker?.postMessage({type:'pin',i,x:w.x,y:w.y});this.moved=true;this.rebuildGrid=true;this.drawSoon();return;}
   if(this.dragging){this.view.x+=dx;this.view.y+=dy;this.dirty=true;this.drawSoon();}
  });
  const up=e=>{
   if(!this.pointers.has(e.pointerId))return;this.pointers.delete(e.pointerId);c.style.cursor='grab';if(this.dragging&&this.dragNode>=0)savePins(globalThis.localStorage,this.vault,this.pins);this.dragNode=-1;
   if(!this.dragging&&this.pointers.size===0&&e.type==='pointerup'){const i=this.pick(e.offsetX,e.offsetY);if(i>=0)this.click(i,e);}
  };
  c.addEventListener('pointerup',up);c.addEventListener('pointercancel',up);
  c.addEventListener('pointerleave',()=>this.setHover(-1));
  c.addEventListener('wheel',e=>{this.markInteraction();e.preventDefault();this.zoom(Math.exp(-e.deltaY*(e.ctrlKey?.01:.0016)),e.offsetX,e.offsetY);},{passive:false});
  c.addEventListener('dblclick',e=>{const i=this.pick(e.offsetX,e.offsetY);if(i>=0&&this.pins.has(this.ids[i])){this.pins.delete(this.ids[i]);savePins(globalThis.localStorage,this.vault,this.pins);this.worker?.postMessage({type:'unpin',i});this.drawSoon();}else this.zoom(2,e.offsetX,e.offsetY);});
 }
 click(i,e){
  {const orbHub=this.kind[i]===3?this.programs.find(p=>p.hub===i&&p.orb):null;if(orbHub){this.selected=i;this.dirty=true;this.drawSoon();this.callbacks.orb?.(orbHub);return;}}
  if(this.kind[i]===6){const program=this.programs.find(p=>p.index===this.island[i]),at=program?.capabilities?.indexOf(i)??-1;if(program&&program.orb){this.selected=i;this.dirty=true;this.drawSoon();this.callbacks.orb?.(program);return;}if(program&&at>=0){this.selected=i;this.dirty=true;this.drawSoon();this.callbacks.capability?.(program,program.capabilityMeta?.[at]);}return;}
  if(this.kind[i]>=3){const program=this.programs.find(p=>p.index===this.island[i]);if(program){this.selected=i;this.dirty=true;this.drawSoon();this.callbacks.program?.(program,Object.keys(program.ledgers).find(k=>program.ledgers[k]===i)||'CODE',program.codeSymbols?.[program.symbols.indexOf(i)]);}return;}
  if(this.kind[i]===2){this.callbacks.tag?.(this.title(i).slice(1));return;}if(this.phantom[i])return;
  this.selected=i;this.dirty=true;this.drawSoon();
  if(e.shiftKey&&this.callbacks.trace&&this.traceFrom>=0){this.callbacks.trace(this.ids[this.traceFrom],this.ids[i]);this.traceFrom=-1;return;}
  this.traceFrom=i;this.callbacks.select?.(this.ids[i]);
 }
 buildGrid(){
  // uniform grid of world cells, rebuilt only when notes have moved, so hovering stays cheap
  const e=this.extent(true),size=Math.max(e.x1-e.x0,e.y1-e.y0)*1.02+4,G=256,cell=size/G;this.grid={x0:e.x0-2,y0:e.y0-2,cell,G};
  const count=new Uint32Array(G*G+1),cellOf=new Int32Array(this.n);
  for(let i=0;i<this.n;i++){const gx=Math.floor((this.pos[2*i]-this.grid.x0)/cell),gy=Math.floor((this.pos[2*i+1]-this.grid.y0)/cell);const c=gx<0||gy<0||gx>=G||gy>=G?-1:gy*G+gx;cellOf[i]=c;if(c>=0)count[c+1]++;}
  for(let c=0;c<G*G;c++)count[c+1]+=count[c];
  const fill=count.slice(0,G*G),items=new Uint32Array(count[G*G]);for(let i=0;i<this.n;i++)if(cellOf[i]>=0)items[fill[cellOf[i]]++]=i;
  this.grid.count=count;this.grid.items=items;this.rebuildGrid=false;
 }
 pick(px,py){
  if(!this.loaded)return -1;if(this.rebuildGrid||!this.grid)this.buildGrid();
  const w=this.toWorld(px,py),g=this.grid,reach=(8/this.view.z),best={i:-1,d:1e18};
  const gx0=Math.floor((w.x-reach-g.x0)/g.cell),gx1=Math.floor((w.x+reach-g.x0)/g.cell),gy0=Math.floor((w.y-reach-g.y0)/g.cell),gy1=Math.floor((w.y+reach-g.y0)/g.cell);
  for(let gy=Math.max(0,gy0);gy<=Math.min(g.G-1,gy1);gy++)for(let gx=Math.max(0,gx0);gx<=Math.min(g.G-1,gx1);gx++){
   const c=gy*g.G+gx;for(let k=g.count[c];k<g.count[c+1];k++){const i=g.items[k];if(!this.visible(i))continue;
    const dx=this.pos[2*i]-w.x,dy=this.pos[2*i+1]-w.y,d=(dx*dx+dy*dy)/Math.max(1,this.radius(i)*this.radius(i)*this.display.nodeSize*this.display.nodeSize);
    const r=Math.max(this.radius(i)*this.display.nodeSize*this.sc(),5)/this.view.z;if(dx*dx+dy*dy<=r*r&&d<best.d){best.d=d;best.i=i;}}
  }
  return best.i;
 }
 setHover(i){if(i===this.hover)return;this.hover=i;this.hoverCaption=i>=0?this.degree[i]+' link'+(this.degree[i]===1?'':'s'):'';this.ink.style.cursor=i>=0?'pointer':'grab';this.dirty=true;this.drawSoon();}
 title(i){return this.titles?this.titles[i]:'';}
 // ---------- controls the ordinary atlas panel drives
 settings(patch){
  // ADAMCAP3: a force slider sends the whole settings object every time. Colours are repainted for every note only when a display setting
  // really changed, never because a force moved (that repaint was the main-thread stall on the whole-vault map).
  if(patch.display){const was=this.display,next={...was,...patch.display},changed=Object.keys(next).some(k=>next[k]!==was[k]);this.display=next;if(changed){if(this.queuePaint)this.queuePaint();else this.paintNodes();}}
  if(patch.customGroups){const key=JSON.stringify(patch.customGroups),same=key===this.customGroupsKey;this.customGroups=patch.customGroups;this.customGroupsKey=key;if(!same&&this.display.colorBy==='custom'){if(this.queuePaint)this.queuePaint();else this.paintNodes();}}
  if(patch.bigForces){const next=sanitizeForces({...this.forces,...patch.bigForces},this.forces),changed=['center','repel','link','distance'].some(k=>next[k]!==this.forces[k]);this.forces=next;if(changed&&this.worker)this.sendForces(this.forces);}
  this.dirty=true;this.drawSoon();
 }
 highlight(predicate){
  if(!predicate){this.match=null;this.dirty=true;this.drawSoon();return 0;}
  const set=new Set();for(let i=0;i<this.n;i++){if(predicate({id:this.ids[i],title:this.title(i),path:this.title(i),folder:this.folders[this.folder[i]],degree:this.degree[i]}))set.add(i);if(set.size>20000)break;}
  this.match=set;this.dirty=true;this.drawSoon();return set.size;
 }
 select(id){this.selected=this.index.has(id)?this.index.get(id):-1;this.dirty=true;this.drawSoon();}
 // Shortest chain of real links, found on the loaded map (breadth first on the compressed adjacency).
 path(fromId,toId){
  const a=this.index.get(fromId),b=this.index.get(toId);if(a===undefined||b===undefined)return null;
  const prev=new Int32Array(this.n).fill(-2);prev[a]=-1;let frontier=[a];
  while(frontier.length&&prev[b]===-2){const next=[];for(const u of frontier)for(let k=this.adjStart[u];k<this.adjStart[u+1];k++){const v=this.adj[k];if(prev[v]===-2){prev[v]=u;next.push(v);}}frontier=next;}
  if(prev[b]===-2)return null;const out=[];for(let v=b;v!==-1;v=prev[v])out.push(v);out.reverse();this.trail={nodes:out,at:performance.now()};this.dirty=true;this.drawSoon();return out.map(i=>this.ids[i]);
 }
 // ---------- Animate: the vault appearing, oldest note first
 play(seconds=34){
  if(!this.loaded)return false;
  const base=seconds,l=this.lapse={base,duration:base/this.display.animateSpeed,progress:0,playing:true,start:performance.now(),from:0,done:false};
  this.emitLapse();this.dirty=true;this.drawSoon();return true;
 }
 retime(){const l=this.lapse;if(!l)return;const now=performance.now();l.duration=l.base/this.display.animateSpeed;l.start=now;l.from=l.progress;}
 pause(){if(this.lapse?.playing){this.lapse.playing=false;this.emitLapse();}}
 resume(){const l=this.lapse;if(!l||l.playing)return;if(l.progress>=1)return this.play();l.playing=true;l.start=performance.now();l.from=l.progress;this.emitLapse();this.drawSoon();}
 stopLapse(){if(!this.lapse)return;this.lapse=null;this.emitLapse();this.dirty=true;this.drawSoon();}
 scrub(p){if(!this.lapse)this.play();const l=this.lapse;if(!l)return;l.playing=false;l.progress=clamp(p);l.done=l.progress>=1;this.emitLapse();this.dirty=true;this.drawSoon();}
 emitLapse(){
  const l=this.lapse;this.atlas?.canvas&&(this.atlas.canvas.dataset.lapse=l?(l.playing?'playing':l.progress>=1?'done':'paused'):'');
  if(this.atlas)this.atlas.lapse=l;
  if(!this.atlas?.onlapse)return;
  if(!l){this.atlas.onlapse(null);return;}
  const count=Math.max(1,Math.round(l.progress*this.n)),idx=this.timeOrder[Math.min(this.n-1,count-1)];
  this.atlas.onlapse({playing:l.playing,done:l.progress>=1,progress:l.progress,count,total:this.n,date:this.mtime[idx]*1000});
 }
 // ---------- drawing
 drawSoon(){if(this.active&&!this.frame)this.frame=requestAnimationFrame(t=>{this.frame=0;this.draw(t);});}
 // ADAMLOOK auto-exposure: a map this dense piles its links and notes into solid white (a 100,925-note map at 3440 px). After the layout settles, measure what share of the lit pixels is solid and
 // lower the brightness of the links and notes until the starburst cells and the dark gaps between them show. A thin map keeps exposure 1.
 // The desktop look (width >= 700): the 390 px phone keeps the organic look approved 28 Oct 13:07 exactly as it was.
 deskLook(){return (this.w||0)>=DESK_MIN_WIDTH;}
 opaqueShare(){
  const w=this.gl.width>>1,h=this.gl.height>>1;if(w<8||h<8)return 0;
  const c=this.expCanvas||(this.expCanvas=document.createElement('canvas'));if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
  const x=c.getContext('2d',{willReadFrequently:true});x.imageSmoothingEnabled=false;x.clearRect(0,0,w,h);x.drawImage(this.gl,0,0,w,h);
  const d=x.getImageData(0,0,w,h).data;let lit=0,solid=0;for(let i=3;i<d.length;i+=4){const a=d[i];if(a<14)continue;lit++;if(a>=235)solid++;}
  return lit?solid/lit:0;
 }
 autoExpose(gl,lapse,dim,k){
  // Stay pending (expDue stays true) while the view is zoomed in, an Animate reveal is partway (lapse < 1) or a hover / search / trace dims the map: measure only the plain fitted picture.
  if(this.view.z>(this.fitZoom||1)*1.25||dim!==1||lapse<1)return;this.expDue=false;
  let e=this.exposure||1,share=this.opaqueShare(),tries=0;
  const target=this.light?EXPOSE_TARGET_LIGHT:EXPOSE_TARGET;while(share>target&&e>EXPOSE_MIN&&tries++<8){e=Math.max(EXPOSE_MIN,e*Math.max(.55,Math.min(.9,target/share+.15)));this.exposure=e;this.glPass(gl,lapse,dim,k);share=this.opaqueShare();}
  this.exposureShare=share;this.dirty=true;
 }
 // ADAMLOOK (a dense whole-vault map drew as one blown-out white disc): the links and notes are one GL pass so auto-exposure can re-run just that pass.
 glPass(gl,lapse,dim,k){
  const ex=this.look==='mycelium'&&this.deskLook()?(this.exposure||1):1;
  gl.viewport(0,0,this.gl.width,this.gl.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  // links
  gl.useProgram(this.edgeProg);gl.uniform2f(this.eu.uView,this.w,this.h);gl.uniform3f(this.eu.uCam,this.view.x,this.view.y,this.view.z);gl.uniform1f(this.eu.uLapse,lapse);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.edgePosBuf);gl.enableVertexAttribArray(this.ea.aPos);gl.vertexAttribPointer(this.ea.aPos,2,gl.FLOAT,false,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.edgeTimeBuf);gl.enableVertexAttribArray(this.ea.aT);gl.vertexAttribPointer(this.ea.aT,1,gl.FLOAT,false,0,0);
  const lc=this.light?[.25,.27,.38]:[.78,.78,.88],base=clamp(.085*(this.look==='mycelium'?TUNE.eb:1)*Math.pow(k,.9)*(this.view.z>(this.fitZoom||1)*3?1.4:1),.02,.9);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.edgeColorBuf);gl.enableVertexAttribArray(this.ea.aColor);gl.vertexAttribPointer(this.ea.aColor,3,gl.FLOAT,false,0,0);gl.uniform1f(this.eu.uTint,this.display.linkTint?1:0);
  gl.uniform4f(this.eu.uColor,lc[0],lc[1],lc[2],base*dim*(this.structural?1.8:1)*ex);if(!this.hideEdges)gl.drawArrays(gl.LINES,0,this.m*2);gl.uniform1f(this.eu.uTint,0);gl.disableVertexAttribArray(this.ea.aColor);
  // notes
  gl.useProgram(this.nodeProg);this.nodeUniforms(lapse,dim*Math.min(1,ex*1.6));this.bindNodeAttribs();gl.uniform4f(this.nu.uOverride,0,0,0,0);gl.uniform1f(this.nu.uBoost,1);gl.drawArrays(gl.POINTS,0,this.n);
 }
 draw(now){
  if(this.glLost||!this.ctx)return;
  if(!this.active||!this.loaded||!this.ctx||!this.w)return;
  const gl=this.ctx,l=this.lapse;
  if(l&&l.playing){l.progress=clamp(l.from+(now-l.start)/1000/l.duration*(1-l.from));if(l.progress>=1){l.playing=false;l.done=true;}if(!l.tick||now-l.tick>90){l.tick=now;this.emitLapse();}this.dirty=true;}
  if(this.goal&&this.autoFit){const k=this.asleep?.2:.12;this.view.x+=(this.goal.x-this.view.x)*k;this.view.y+=(this.goal.y-this.view.y)*k;this.view.z+=(this.goal.z-this.view.z)*k;if(Math.abs(this.goal.z-this.view.z)>.0005)this.dirty=true;}
  if(this.moved){this.moved=false;this.uploadPositions();if(this.autoFit&&!this.userMoved)this.fit();}
  const lapse=l?l.progress:2,focus=this.hover>=0||this.match||this.trail,dim=focus?.2:1;
  const k=this.display.linkThickness;
  this.glPass(gl,lapse,dim,k);
  if(this.expDue&&this.asleep&&this.look==='mycelium'&&this.deskLook())this.autoExpose(gl,lapse,dim,k);
  // focus layer: hovered note + neighbours, search matches, traced path
  if(focus)this.drawFocus(lapse);
  this.drawInk(now);
  this.dirty=false;this.stats.frames++;if(now-this.stats.last>1000){this.stats.fps=Math.round(this.stats.frames*1000/(now-this.stats.last));this.stats.frames=0;this.stats.last=now;this.gl.dataset.fps=this.stats.fps;}
  this.gl.dataset.nodes=this.n;this.gl.dataset.links=this.m;this.gl.dataset.alpha=this.alpha.toFixed(3);this.gl.dataset.layout=this.asleep?'settled':'moving';
  if(this.dirty||l?.playing||!this.asleep||this.goal&&this.autoFit&&Math.abs(this.goal.z-this.view.z)>.0005)this.drawSoon();
 }
 nodeUniforms(lapse,alpha){
  const gl=this.ctx;gl.uniform2f(this.nu.uView,this.w,this.h);gl.uniform3f(this.nu.uCam,this.view.x,this.view.y,this.view.z);gl.uniform1f(this.nu.uDpr,this.dpr);
  gl.uniform1f(this.nu.uGlow,this.display.glow?1:0);gl.uniform1f(this.nu.uSc,this.sc());gl.uniform1f(this.nu.uSizeK,this.display.nodeSize);gl.uniform1f(this.nu.uLapse,lapse);gl.uniform1f(this.nu.uMinPx,.7);gl.uniform1f(this.nu.uAlpha,alpha);
 }
 bindNodeAttribs(){
  const gl=this.ctx,a=this.na;
  gl.bindBuffer(gl.ARRAY_BUFFER,this.posBuf);gl.enableVertexAttribArray(a.aPos);gl.vertexAttribPointer(a.aPos,2,gl.FLOAT,false,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.sizeBuf);gl.enableVertexAttribArray(a.aSize);gl.vertexAttribPointer(a.aSize,1,gl.FLOAT,false,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.colorBuf);gl.enableVertexAttribArray(a.aColor);gl.vertexAttribPointer(a.aColor,4,gl.UNSIGNED_BYTE,true,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.timeBuf);gl.enableVertexAttribArray(a.aT);gl.vertexAttribPointer(a.aT,1,gl.FLOAT,false,0,0);
 }
 uploadPositions(){
  const gl=this.ctx,p=this.pos,e=this.epos,ed=this.edges;
  for(let k=0;k<this.m;k++){const a=ed[2*k]*2,b=ed[2*k+1]*2,o=k*4;e[o]=p[a];e[o+1]=p[a+1];e[o+2]=p[b];e[o+3]=p[b+1];}
  gl.bindBuffer(gl.ARRAY_BUFFER,this.posBuf);gl.bufferSubData(gl.ARRAY_BUFFER,0,p);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.edgePosBuf);gl.bufferSubData(gl.ARRAY_BUFFER,0,e);
 }
 focusSet(){
  const old=this.focusCache;if(old&&old.hover===this.hover&&old.match===this.match&&old.trail===this.trail&&old.version===this.visibleVersion)return old;
  const set=new Set(),edges=[];
  if(this.hover>=0){const u=this.hover;set.add(u);for(let k=this.adjStart[u];k<this.adjStart[u+1];k++){set.add(this.adj[k]);if(this.nodeVisible[u]&&this.nodeVisible[this.adj[k]]&&edges.length<4096)edges.push(this.adjEdge[k]);}}
  if(this.trail)for(const i of this.trail.nodes)set.add(i);if(this.match)for(const i of this.match)set.add(i);
  return this.focusCache={hover:this.hover,match:this.match,trail:this.trail,version:this.visibleVersion,edges:Uint32Array.from(edges),nodes:Uint32Array.from(set),trailPoints:new Float32Array(Math.max(0,(this.trail?.nodes.length||1)-1)*4)};
 }
 drawFocus(lapse){
  const gl=this.ctx,cache=this.focusSet(),edges=cache.edges,accent=this.accent;
  if(this.hover>=0&&edges.length){
   const buf=this.focusEdges;for(let q=0;q<edges.length;q++){const e=edges[q]*4;buf[q*4]=this.epos[e];buf[q*4+1]=this.epos[e+1];buf[q*4+2]=this.epos[e+2];buf[q*4+3]=this.epos[e+3];}
   gl.useProgram(this.edgeProg);gl.bindBuffer(gl.ARRAY_BUFFER,this.hoverEdgeBuf);gl.bufferData(gl.ARRAY_BUFFER,buf,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(this.ea.aPos);gl.vertexAttribPointer(this.ea.aPos,2,gl.FLOAT,false,0,0);gl.disableVertexAttribArray(this.ea.aT);gl.vertexAttrib1f(this.ea.aT,0);
   gl.uniform4f(this.eu.uColor,accent?.[0]??.71,accent?.[1]??.61,accent?.[2]??.91,.85);gl.drawArrays(gl.LINES,0,edges.length*2);
  }
  if(this.trail&&this.trail.nodes.length>1){
   const t=this.trail.nodes,buf=cache.trailPoints;let count=0;for(let q=0;q<t.length-1;q++)if(this.nodeVisible[t[q]]&&this.nodeVisible[t[q+1]]){buf[count++]=this.pos[2*t[q]];buf[count++]=this.pos[2*t[q]+1];buf[count++]=this.pos[2*t[q+1]];buf[count++]=this.pos[2*t[q+1]+1];}
   gl.useProgram(this.edgeProg);gl.bindBuffer(gl.ARRAY_BUFFER,this.hoverEdgeBuf);gl.bufferData(gl.ARRAY_BUFFER,buf,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(this.ea.aPos);gl.vertexAttribPointer(this.ea.aPos,2,gl.FLOAT,false,0,0);gl.disableVertexAttribArray(this.ea.aT);gl.vertexAttrib1f(this.ea.aT,0);gl.uniform4f(this.eu.uColor,1,.85,.4,1);gl.drawArrays(gl.LINES,0,count/2);
  }
  const list=cache.nodes;if(!list.length)return;gl.useProgram(this.nodeProg);this.nodeUniforms(lapse,1);this.bindNodeAttribs();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.hoverNodeBuf);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,list,gl.DYNAMIC_DRAW);
  gl.uniform4f(this.nu.uOverride,accent?.[0]??.71,accent?.[1]??.61,accent?.[2]??.91,1);gl.uniform1f(this.nu.uBoost,1.5);gl.drawElements(gl.POINTS,list.length,gl.UNSIGNED_INT,0);
  if(this.hover>=0){gl.uniform4f(this.nu.uOverride,1,1,1,1);gl.uniform1f(this.nu.uBoost,2);this.singleHover[0]=this.hover;gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,this.singleHover,gl.DYNAMIC_DRAW);gl.drawElements(gl.POINTS,1,gl.UNSIGNED_INT,0);}
 }
 rebuildLabels(now,budget){
  this.labelBuiltAt=now;this.labelKey=1;this.labelViewX=this.view.x;this.labelViewY=this.view.y;this.labelZoom=this.view.z;this.labelPosVersion=this.posVersion;this.labelCount=0;
  const z=this.view.z,rel=z/(this.fitZoom||1),limit=Math.min(budget.labels,this.labelX.length),start=.35+clamp(this.display.textFade)*2.1,rows=Math.ceil(this.h/22)+3;
  // Names are placed by their real width: a name never lands on another name, and none sits under the top controls or the bottom bar.
  if(!this.labelRows||this.labelRows.length!==rows)this.labelRows=Array.from({length:rows},()=>[]);else for(const r of this.labelRows)r.length=0;
  if(!this.labelX0||this.labelX0.length<this.labelX.length){this.labelX0=new Float32Array(this.labelX.length);this.labelX1=new Float32Array(this.labelX.length);}
  const topBand=46,bottomBand=84;
  for(let k=0;k<this.degreeOrder.length&&this.labelCount<limit;k++){
   const i=this.degreeOrder[k];if(!this.nodeVisible[i]||this.kind[i]===3)continue;
   const x=this.pos[i*2]*z+this.view.x,y=this.pos[i*2+1]*z+this.view.y;if(x<0||y<topBand||x>this.w||y>this.h-bottomBand)continue;
   const a=clamp((rel*.55*this.labelImportance[i]-start)/.55);if(a<=.02)break;
   const x0=x+screenRadius(this.radius(i),this.display.nodeSize,this.sc())+4,x1=x0+(this.titleWidths?this.titleWidths[i]:this.shortTitles[i].length*9.7)+8;if(x1>this.w)continue;
   const row=(y/22|0)+1;let clash=false;for(const bx of this.programBoxes||[]){if(x1>bx.x-6&&x0<bx.x+bx.width+6&&y+12>bx.y-2&&y-12<bx.y+bx.height+2){clash=true;break;}}
   for(let rr=row-1;rr<=row+1&&!clash;rr++){if(rr<0||rr>=rows)continue;for(const q of this.labelRows[rr]){if(Math.abs(this.labelY[q]-y)<22&&x0<this.labelX1[q]+8&&x1>this.labelX0[q]-8){clash=true;break;}}}
   if(clash)continue;const q=this.labelCount++;this.labelIds[q]=i;this.labelAlphas[q]=a;this.labelX[q]=x;this.labelY[q]=y;this.labelX0[q]=x0;this.labelX1[q]=x1;this.labelRows[row].push(q);
  }
 }
 inkLabel(c,i,a,budget){
  if(!this.visible(i)||this.kind[i]===3)return false;
  const x=this.pos[2*i]*this.view.z+this.view.x,y=this.pos[2*i+1]*this.view.z+this.view.y;if(x<-40||y<-40||x>this.w+40||y>this.h+40)return false;
  const r=screenRadius(this.radius(i),this.display.nodeSize,this.inkScale),name=this.shortTitles[i];c.globalAlpha=a;if(budget.halo)c.strokeText(name,x+r+4,y);c.fillText(name,x+r+4,y);return true;
 }
 inkRing(c,i){const x=this.pos[2*i]*this.view.z+this.view.x,y=this.pos[2*i+1]*this.view.z+this.view.y,r=screenRadius(this.radius(i),this.display.nodeSize,this.inkScale)+4;c.beginPath();c.arc(x,y,r,0,7);c.lineWidth=1.6;c.strokeStyle=this.inkAccent;c.stroke();}
 // Only reusable arrays and scalar state on the frame path.
 drawInk(now=performance.now()){
  const c=this.ink.getContext('2d'),dpr=this.dpr,budget=interactionBudget(now,this.interactingUntil),z=this.view.z;this.inkScale=this.sc();c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,this.w,this.h);
  const alpha=arrowAlpha(z/(this.fitZoom||1));let count=0;
  if(!this.hideEdges&&this.display.arrows!=='off'&&alpha>0){
   const state=this.arrowState;state.mode=budget.arrows||this.display.arrows;state.alpha=alpha;state.hover=this.hover;state.edges=this.edges;state.adjStart=this.adjStart;state.adjEdge=this.adjEdge;state.pos=this.pos;state.visible=this.nodeVisible;state.rank=this.rank;state.lapse=this.lapse?this.lapse.progress:2;state.zoom=z;state.limit=budget.arrowLimit;
   state.x0=-this.view.x/z;state.y0=-this.view.y/z;state.x1=(this.w-this.view.x)/z;state.y1=(this.h-this.view.y)/z;
   count=arrowCandidates(state,this.arrowIds);c.globalAlpha=alpha;c.fillStyle=this.light?'#536079':'#a8b6cf';c.beginPath();
   for(let q=0;q<count;q++){const e=this.arrowIds[q],a=this.edges[e*2],b=this.edges[e*2+1],ax=this.pos[a*2]*z+this.view.x,ay=this.pos[a*2+1]*z+this.view.y,bx=this.pos[b*2]*z+this.view.x,by=this.pos[b*2+1]*z+this.view.y,dx=bx-ax,dy=by-ay,len=Math.sqrt(dx*dx+dy*dy),ux=dx/len,uy=dy/len;c.moveTo(bx-ux*3,by-uy*3);c.lineTo(bx-ux*8-uy*2,by-uy*8+ux*2);c.lineTo(bx-ux*8+uy*2,by-uy*8-ux*2);c.closePath();}c.fill();
  }this.ink.dataset.arrows=String(count);c.globalAlpha=1;if(!this.titles)return;
  const programCount=this.prepareProgramLabels(c,now,budget);if(this.programBuiltAt===now)this.labelKey=null;
  const rel=z/(this.fitZoom||1),changed=this.labelKey===null||this.labelViewX!==this.view.x||this.labelViewY!==this.view.y||this.labelZoom!==z||this.labelPosVersion!==this.posVersion;
  if(rel>1.6&&!this.hideLabels&&changed&&labelRebuildDue(now,this.labelBuiltAt,budget.interacting))this.rebuildLabels(now,budget);
  c.font='17.34px system-ui';c.textBaseline='middle';c.lineWidth=3;c.strokeStyle=this.inkBack;c.fillStyle=this.inkColor;
  let remaining=budget.labels;
  if(this.hover>=0&&this.inkLabel(c,this.hover,1,budget))remaining--;
  if(this.selected>=0&&this.selected!==this.hover&&this.inkLabel(c,this.selected,1,budget))remaining--;
  // Reserve room for program names; cache rebuilds, not frames, allocate their boxes.
  const programLimit=Math.min(programCount,remaining);remaining-=programLimit;
  if(rel>1.6&&!this.hideLabels)for(let k=0;k<this.labelCount&&remaining>0;k++){const i=this.labelIds[k];if(i===this.hover||i===this.selected)continue;if(this.inkLabel(c,i,this.labelAlphas[k],budget))remaining--;}
  this.drawProgramLabels(c,budget,programLimit);c.globalAlpha=1;
  for(const id of this.pins.keys()){const i=this.index.get(Number(id));if(i!==undefined&&this.visible(i))this.inkRing(c,i);}
  if(this.selected>=0&&this.visible(this.selected))this.inkRing(c,this.selected);
  if(this.hover>=0&&!budget.interacting){const x=this.pos[2*this.hover]*z+this.view.x,y=this.pos[2*this.hover+1]*z+this.view.y;c.font='17.34px system-ui';c.fillStyle=this.inkColor;c.globalAlpha=.6;const cp=captionPlacement(x+this.radius(this.hover)*this.inkScale+4,y,c.measureText(this.hoverCaption).width,this.w,this.h);c.fillText(this.hoverCaption,cp.x,cp.y);c.globalAlpha=1;}
 }
 prepareProgramLabels(c,now,budget){
  const changed=this.programX!==this.view.x||this.programY!==this.view.y||this.programZ!==this.view.z||this.programPos!==this.posVersion||this.programHover!==this.hover||this.programSelected!==this.selected||this.programHidden!==this.hideLabels||this.programBuiltAt===-Infinity;
  if(changed&&(now-this.programBuiltAt>=100||this.programHover!==this.hover||this.programSelected!==this.selected)){
   this.programBoxes=this.rebuildProgramLabels(c);this.programBuiltAt=now;this.programX=this.view.x;this.programY=this.view.y;this.programZ=this.view.z;this.programPos=this.posVersion;this.programHover=this.hover;this.programSelected=this.selected;this.programHidden=this.hideLabels;
  }return this.programBoxes.length;
 }
 drawProgramLabels(c,budget,limit){c.font='600 17.34px system-ui';c.textBaseline='middle';c.globalAlpha=1;c.lineJoin='round';c.lineWidth=3.5;c.strokeStyle='#10121b';c.fillStyle='#f3f5ff';let count=0;for(const box of this.programBoxes){if(count>=limit)break;if(budget.halo)c.strokeText(box.text,box.x+4,box.y+box.height/2);c.fillText(box.text,box.x+4,box.y+box.height/2);count++;}this.ink.dataset.programLabels=String(count);}
 orbGlyph(i){const p=this.programs?.find(q=>q.hub===i);return p?.family?ORB_GLYPH[p.family]:'';}
 capabilityBadge(i){const p=this.programs?.find(q=>q.hub===i);return p?.capabilityCount?' · '+p.capabilityCount:'';}
 rebuildProgramLabels(c){
  const order=this.programOrder||[],priority=new Set();for(const i of [this.hover,this.selected])if(i>=0&&this.kind[i]>=3){const hub=order.find(h=>this.island[h]===this.island[i]);if(hub!==undefined)priority.add(hub);}
  const allowed=new Set(this.hideLabels||(this.look==='mycelium'&&this.view.z<(this.fitZoom||0)*2.2)?[]:programLabelIndices(order.length,this.w).map(k=>order[k]));for(const i of priority)allowed.add(i);
  const bottom=this.bottomPadding||ATLAS_BOTTOM_PADDING,bounds=atlasViewport(this.w,this.h,this.programLabelWidth||160,bottom),hostRect=this.host.getBoundingClientRect(),blocked=[];
  for(const selector of ['.graph-top','.atlas-heading']){const element=this.host.querySelector(selector);if(!element)continue;const r=element.getBoundingClientRect();blocked.push({x:r.left-hostRect.left-4,y:r.top-hostRect.top-4,width:r.width+8,height:r.height+8});}
  c.font='600 17.34px system-ui';c.textBaseline='middle';const candidates=[];
  for(const i of order){if(!allowed.has(i)||!this.visible(i))continue;let full=this.orbGlyph(i)+this.title(i)+this.capabilityBadge(i),text=full,width=c.measureText(text).width+8;const maxWidth=bounds.right-bounds.left;
   while(width>maxWidth&&text.length>1){text=text.slice(0,-2);width=c.measureText(text+'\u2026').width+8;}if(text!==full)text+='\u2026';
   candidates.push({id:i,text,width,height:28,x:this.pos[i*2]*this.view.z+this.view.x,y:this.pos[i*2+1]*this.view.z+this.view.y,priority:priority.has(i)});
  }
  return placeProgramLabels(candidates,bounds,blocked);
 }
 // ---------- going in and out of use
 show(){
  this.active=true;if(this.atlas)this.atlas.bigActive=true;this.gl.style.display=this.ink.style.display='block';this.atlas?.canvas&&(this.atlas.canvas.style.display='none');
  this.resize();if(this.worker===null&&this.loaded)this.startWorker();this.dirty=true;this.drawSoon();
 }
 hide(){
  this.active=false;if(this.atlas)this.atlas.bigActive=false;this.gl.style.display=this.ink.style.display='none';this.atlas?.canvas&&(this.atlas.canvas.style.display='');
  clearTimeout(this.detailTimer);this.detailTimer=0;this.stopWorker();this.stopLapse();this.match=null;this.hover=-1;this.trail=null;this.atlas&&(this.atlas.lapse=null);
 }
 theme(light,accent){this.light=light;if(accent)this.accent=accent;this.exposure=1;this.expDue=true;this.paintNodes();}
 // Borrow the ordinary atlas's controls: while the whole-vault map is showing, these calls go to it.
 attach(atlas){
  this.atlas=atlas;const self=this;
  const setData=atlas.setData.bind(atlas);atlas.setData=(...args)=>{if(self.active)self.hide();return setData(...args);};
  for(const name of ['cell','timeline','unpinAll','play','pause','resume','stopLapse','scrub','retime','highlight','select','fit','zoom','settings']){
   const original=atlas[name].bind(atlas);
   atlas[name]=function(...args){const r=original(...args);return self.active&&typeof self[name]==='function'?self[name](...args):r;};
  }
 }
}
