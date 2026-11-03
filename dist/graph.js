import {screenRadius,MAX_ARROWS,arrowAlpha,nodeColor,paletteColors,readPins,savePins,throttleLatest} from './atlas-settings.js';
import {arrowGeometry} from './arrows.js';
import {cellLayout,drawCell} from './cell.js';
import {flowParticles} from './flow.js';
import {Simulation,FORCE_DEFAULTS} from './physics.js';
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const ease=t=>1-Math.pow(1-clamp(t),3);
const pop=t=>{t=clamp(t);const c=1.70158;return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2);};
export const DISPLAY_DEFAULTS=Object.freeze({animateSpeed:1,nodeSize:1,linkThickness:1,textFade:.45,arrows:'auto',orphans:true,attachments:true,clusterLabels:true,colorBy:'folder',palette:'Spectrum',linkTint:true,glow:true,ring:true});
// Pure helpers, exported so the tests and the panel use the same rules the canvas does.
export function nodeRadius(degree,scale=1){return (2.3+Math.min(8.5,Math.sqrt(degree||0)*.95))*scale;}
export function labelAlpha(zoom,degree,textFade){const start=.35+clamp(textFade)*2.1,effective=zoom*(1+.28*Math.log2(1+(degree||0)));return clamp((effective-start)/.55);}
export function edgeWeight(a,b){return clamp(Math.log2(1+Math.min(a.degree||0,b.degree||0))/4.5);}
export function neighborhood(edges,id){const set=new Set([id]);for(const e of edges){if(e.a.id===id)set.add(e.b.id);else if(e.b.id===id)set.add(e.a.id);}return set;}
// Shortest undirected path over the loaded edges; null when the two are not connected here.
export function shortestPath(edges,from,to){
 if(from===to)return [from];const adj=new Map();
 for(const e of edges){(adj.get(e.a.id)||adj.set(e.a.id,[]).get(e.a.id)).push(e.b.id);(adj.get(e.b.id)||adj.set(e.b.id,[]).get(e.b.id)).push(e.a.id);}
 const prev=new Map([[from,0]]);let frontier=[from];
 while(frontier.length){const next=[];for(const id of frontier)for(const other of adj.get(id)||[])if(!prev.has(other)){prev.set(other,id);if(other===to){const path=[to];let at=to;while(at!==from){at=prev.get(at);path.push(at);}return path.reverse();}next.push(other);}frontier=next;}
 return null;
}
// Which documents match a group or search query: free words in title/path, or path:, folder:, title: prefixes.
export function matchesQuery(n,query){
 const q=String(query||'').trim().toLowerCase();if(!q)return false;
 const terms=q.split(/\s+/).map(term=>/^(path|folder|title):/.test(term)||!/^[a-z]+:/.test(term)?term:'').filter(Boolean);
 return terms.length>0&&terms.every(term=>{const m=/^(path|folder|title):(.*)$/.exec(term);if(m)return m[2]===''||String(n[m[1]]||'').toLowerCase().includes(m[2]);return (n.title+' '+n.path).toLowerCase().includes(term);});
}
// Soft glows are drawn from one small cached sprite per colour instead of building a gradient every frame.
const sprites=new Map();
function glowSprite(color){
 let sprite=sprites.get(color);if(sprite)return sprite;
 sprite=document.createElement('canvas');sprite.width=sprite.height=96;
 const g=sprite.getContext?.('2d');if(!g)return null;const gradient=g.createRadialGradient(48,48,0,48,48,48);gradient.addColorStop(0,color+'ff');gradient.addColorStop(1,color+'00');g.fillStyle=gradient;g.fillRect(0,0,96,96);sprites.set(color,sprite);return sprite;
}
function drawGlow(c,color,x,y,r,alpha){const sprite=glowSprite(color);if(!sprite)return;c.globalAlpha*=alpha;c.drawImage(sprite,x-r,y-r,r*2,r*2);}
export class Atlas{
 constructor(canvas,callbacks){
  this.canvas=canvas;canvas.atlas=this;this.ctx=canvas.getContext('2d');this.callbacks=callbacks;this.nodes=[];this.edges=[];this.live=[];this.liveEdges=[];this.groups=[];this.colors=['#b49be8','#e7b66e','#74caba','#e58da9','#8baada','#bace7a','#d198e0'];this.view={x:0,y:0,z:1};this.goal={...this.view};this.selected=0;this.hover=0;this.frame=0;
  this.display={...DISPLAY_DEFAULTS};this.forces={...FORCE_DEFAULTS};this.customGroups=[];this.match=null;this.autoFit=true;this.frames=0;this.sim=new Simulation([],[],this.forces);this.focusMix=0;this.trail=null;this.lapse=null;this.motionOverride=false;this.worker=null;this.workerVersion=0;this.workerAsleep=true;this.workerAlpha=0;this.pendingAlpha=1;
  this.tooltip=canvas.parentElement.querySelector('#tooltip')||document.createElement('div');this.tooltip.classList.add('atlas-tooltip');this.tooltip.hidden=true;if(!this.tooltip.parentElement)canvas.parentElement.append(this.tooltip);
  new ResizeObserver(()=>this.resize()).observe(canvas);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.drawSoon();});
  this.pins=new Map();this.vault='';this.sendForces=throttleLatest(forces=>{if(this.usingWorker())this.worker.postMessage({type:'forces',forces,alpha:.18});});this.pointers=new Map();
  canvas.onpointerdown=e=>{
   canvas.setPointerCapture(e.pointerId);this.tooltip.hidden=true;this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
   if(this.pointers.size===2){this.pinch=this.pinchState();this.drag=null;this.grab=null;return;}
   const n=this.static?null:this.hit(e);this.drag={x:e.clientX,y:e.clientY,vx:this.goal.x,vy:this.goal.y,moved:false};
   if(n){this.grab=n;this.drag.node=n;}
  };
  canvas.onpointermove=e=>{
   if(this.pointers.has(e.pointerId))this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
   if(this.pinch&&this.pointers.size===2){const s=this.pinchState(),rect=canvas.getBoundingClientRect();this.autoFit=false;this.zoom(s.d/this.pinch.d,s.x-rect.left,s.y-rect.top);this.pinch=s;return;}
   if(this.drag){
    const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;
    if(!this.drag.moved&&Math.hypot(dx,dy)>4)this.drag.moved=true;
    if(this.grab&&this.drag.moved){const w=this.toWorld(e);this.grab.fx=w.x;this.grab.fy=w.y;if(this.usingWorker()){this.grab.x=w.x;this.grab.y=w.y;this.worker.postMessage({type:'pin',i:this.grab.wi,x:w.x,y:w.y});this.workerAsleep=false;}this.sim.alphaTarget=.18;this.sim.reheat(.18);this.canvas.dataset.dragging=this.grab.id;this.canvas.style.cursor='grabbing';this.hover=this.grab.id;this.drawSoon();return;}
    if(!this.grab){this.goal.x=this.drag.vx+dx;this.goal.y=this.drag.vy+dy;if(this.drag.moved)this.autoFit=false;if(this.reduced)Object.assign(this.view,this.goal);this.drawSoon();}
    return;
   }
   const n=this.hit(e);this.hover=n?.id||0;canvas.style.cursor=n?'pointer':'grab';const tip=this.tooltip;tip.hidden=!n;
   if(n){tip.textContent=n.title;tip.style.left=Math.max(0,Math.min(e.offsetX+15,this.w-250))+'px';tip.style.top=Math.max(0,Math.min(e.offsetY+15,this.h-60))+'px';}
   this.drawSoon();
  };
  const finish=e=>{
   this.pointers.delete(e.pointerId);if(this.pinch){if(this.pointers.size<2)this.pinch=null;return;}
   const d=this.drag;this.drag=null;
   if(this.grab){const n=this.grab;this.grab=null;if(d?.moved){this.pins.set(n.id,[n.fx,n.fy]);savePins(globalThis.localStorage,this.vault,this.pins);}this.sim.alphaTarget=0;this.canvas.dataset.dragging='';canvas.style.cursor='pointer';if(!d?.moved){if(e.shiftKey&&this.selected&&this.selected!==n.id)this.callbacks.trace?.(this.selected,n.id);else this.callbacks.select(n.id);}this.drawSoon();return;}
   if(d&&!d.moved){const n=this.hit(e);if(n){if(e.shiftKey&&this.selected&&this.selected!==n.id)this.callbacks.trace?.(this.selected,n.id);else this.callbacks.select(n.id);}else if(this.trail){this.clearTrail();}}
  };
  canvas.onpointerup=finish;
  canvas.onpointercancel=e=>{this.pointers.delete(e.pointerId);this.pinch=null;if(this.grab){this.grab.fx=this.grab.fy=null;this.grab=null;this.sim.alphaTarget=0;}this.drag=null;};
  canvas.ondblclick=e=>{const n=this.hit(e);if(n&&this.pins.has(n.id)){this.pins.delete(n.id);n.fx=n.fy=null;if(this.usingWorker())this.worker.postMessage({type:'unpin',i:n.wi});savePins(globalThis.localStorage,this.vault,this.pins);this.wake(.18);}else if(n)this.callbacks.expand(n.id);};
  canvas.onwheel=e=>{e.preventDefault();this.autoFit=false;this.zoom(Math.exp(-e.deltaY*.0015),e.offsetX,e.offsetY);};
  canvas.onpointerleave=()=>{if(this.drag)return;this.hover=0;this.tooltip.hidden=true;this.drawSoon();};
 }
 pinchState(){const [a,b]=[...this.pointers.values()];return {d:Math.hypot(a.x-b.x,a.y-b.y)||1,x:(a.x+b.x)/2,y:(a.y+b.y)/2};}
 get reduced(){return matchMedia('(prefers-reduced-motion: reduce)').matches&&!this.motionOverride;}
 get static(){return this.cellular||this.timelineMode;}
 toWorld(e){const r=this.canvas.getBoundingClientRect();return {x:(e.clientX-r.left-this.view.x)/this.view.z,y:(e.clientY-r.top-this.view.y)/this.view.z};}
 resize(){const rect=this.canvas.getBoundingClientRect();this.w=rect.width;this.h=rect.height;this.dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=this.w*this.dpr;this.canvas.height=this.h*this.dpr;if(this.nodes.length)this.fit();else this.drawSoon();}
 setVault(key){if(this.vault===key)return;this.vault=key;this.pins=readPins(globalThis.localStorage,key);for(const n of this.nodes){const p=this.pins.get(n.id);if(p){n.fx=n.x=p[0];n.fy=n.y=p[1];}}}
 unpinAll(){for(const n of this.nodes){n.fx=n.fy=null;if(this.usingWorker())this.worker.postMessage({type:'unpin',i:n.wi});}this.pins.clear();savePins(globalThis.localStorage,this.vault,this.pins);this.wake(.18);}
 palette(){return paletteColors(this.display.palette,document.body.dataset.theme==='ivory');}
 legacyPalette(){const theme=document.body.dataset.theme;return theme==='ivory'?['#566592','#9b596b','#347d76','#85619b','#3e7897','#758137','#a76d37']:theme==='terminal'?['#92b9d0','#d6ae75','#8295c8','#7eb9b4','#bd9bb9','#bcc7d2','#bba98a']:['#a1aed0','#cfa0ad','#87bfb7','#b5a6c9','#91b2c9','#b8bd91','#cfb394'];}
 colorOf(n){
  const light=document.body.dataset.theme==='ivory';
  if(n.tag)return light?'#2f8a4b':'#7ad98f';
  if(this.display.colorBy==='none')return light?'#6b7385':'#9aa3b8';
  if(this.display.colorBy==='custom'){for(const g of this.customGroups)if(matchesQuery(n,g.query))return g.color;return light?'#9aa1b3':'#6b7287';}
  return nodeColor({folder:this.groups.indexOf(n.folder),age:n.ageRank||0,degree:n.degree},this.display,light);
 }
 refresh(){const style=getComputedStyle(document.body);this.colors=this.palette();this.light=document.body.dataset.theme==='ivory';this.bg=style.getPropertyValue('--graph').trim()||'#100e18';this.accent=style.getPropertyValue('--accent').trim()||'#a4c7de';const dated=[...this.nodes].sort((a,b)=>(a.mtime||0)-(b.mtime||0));dated.forEach((n,i)=>n.ageRank=i/Math.max(1,dated.length));for(const n of this.nodes)n.color=this.colorOf(n);this.drawSoon();}
 settings(patch={}){
  const filterChanged=patch.display&&['orphans','attachments'].some(k=>k in patch.display&&patch.display[k]!==this.display[k]);
  if(patch.display){Object.assign(this.display,patch.display);for(const n of this.nodes)n.radius=nodeRadius(n.degree,this.display.nodeSize);}
  if(patch.forces&&Object.keys(patch.forces).some(k=>patch.forces[k]!==this.forces[k])){Object.assign(this.forces,patch.forces);this.sim.forces=this.forces;if(this.usingWorker()){this.sendForces({...this.forces});this.workerAsleep=false;}else if(!this.static){this.wake(.18);}}
  if(patch.customGroups)this.customGroups=patch.customGroups;
  if(filterChanged)this.rebuildLive();this.refresh();this.onsettings?.();
 }
 wake(alpha=.6){if(this.static)return;if(this.usingWorker()){if(this.reduced)this.postGraph();else this.worker.postMessage({type:'reheat',alpha});this.workerAsleep=false;this.canvas.dataset.layout='settling';this.drawSoon();return;}if(this.reduced&&!this.drag){this.sim.reheat(alpha);this.sim.settle();this.canvas.dataset.layout='settled';this.drawSoon();return;}this.sim.reheat(alpha);this.canvas.dataset.layout='settling';this.drawSoon();}
 setCluster(on){this.forces.cluster=on?.55:0;this.sim.forces=this.forces;const spread=1+Math.min(1.2,this.live.length/700);if(this.usingWorker()){this.worker.postMessage({type:'forces',forces:{...this.forces},anchors:on?{count:this.groups.length,spread}:null,alpha:.8});this.workerAsleep=false;return;}if(on)this.sim.setAnchors(this.groups.length,spread);this.wake(.8);}
 // ---- big maps: the layout runs in a worker
 usingWorker(){return !!this.worker&&this.live.length>1500&&!this.static;}
 ensureWorker(){
  if(this.worker)return;
  this.worker=new Worker('/layout-worker.js',{type:'module'});
  this.worker.onmessage=({data})=>{
   if(data.type!=='pos'||data.version!==this.workerVersion||this.static)return;
   const live=this.live,pos=data.positions;if(pos.length!==live.length*2)return;
   for(let i=0;i<live.length;i++){const n=live[i];if(n===this.grab)continue;n.x=pos[i*2];n.y=pos[i*2+1];}
   this.workerAlpha=data.alpha;this.workerAsleep=data.asleep;
   if(data.asleep&&this.reduced&&this.autoFit){this.fit();Object.assign(this.view,this.goal);}
   this.drawSoon();
  };
 }
 postGraph(){
  this.ensureWorker();this.live.forEach((n,i)=>{n.wi=i;});const version=++this.workerVersion,spread=1+Math.min(1.2,this.live.length/700);
  this.worker.postMessage({type:'graph',version,nodes:this.live.map(n=>({x:n.x,y:n.y,degree:n.degree,g:n.g})),links:this.liveEdges.map(e=>[e.a.wi,e.b.wi]),forces:{...this.forces},alpha:this.pendingAlpha,anchors:this.forces.cluster?{count:this.groups.length,spread}:null,settle:this.reduced});
  for(const n of this.live)if(n.fx!==null&&n.fy!==null)this.worker.postMessage({type:'pin',i:n.wi,x:n.fx,y:n.fy});this.workerAsleep=false;this.workerAlpha=this.pendingAlpha;this.canvas.dataset.layout='settling';
 }
 stopWorker(){if(this.worker){this.worker.terminate();this.worker=null;}this.workerAsleep=true;}
 alphaNow(){return this.usingWorker()?this.workerAlpha:this.sim.alpha;}
 calm(){return this.static||(this.usingWorker()?this.workerAsleep:this.sim.asleep);}
 shape(mode){if(this.timelineMode)this.timeline();const previous=this.cellular?'cell':'';if(previous)for(const n of this.nodes){n.x=n.shapePreviousX??n.x;n.y=n.shapePreviousY??n.y;}this.cellular=mode==='cell'&&previous!==mode;this.applyShape();this.fit();if(!this.static)this.wake(.4);}
 cell(){this.shape('cell');}
 applyShape(){if(this.cellular){this.stopLapse();for(const n of this.nodes){n.shapePreviousX=n.x;n.shapePreviousY=n.y;}this.cellShape=cellLayout(this.nodes);}this.canvas.dataset.view=this.cellular?'cell':'constellation';this.canvas.dataset.layout='settled';}
 pulse(ids){if(!this.pulses)this.pulses=new Map();const until=performance.now()+2200;for(const id of ids)if(this.nodes.some(n=>n.id===id))this.pulses.set(id,until);this.drawSoon();setTimeout(()=>this.drawSoon(),2250);}
 // The old "flow along links" overlay. Kept as an option; the Animate button now plays the growth time-lapse.
 animate(enabled){this.animating=!!enabled;this.drawSoon();}
 drawFlow(c,active){
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches&&!this.motionOverride;
  const running=this.animating&&!reduced&&!document.hidden&&!this.hideEdges&&!this.timelineMode&&!this.undirected&&this.edges.length>0;
  this.canvas.dataset.animation=running?'running':this.animating?'paused':'off';
  this.canvas.dataset.flowParticles='0';if(!running)return false;
  const particles=flowParticles(this.liveEdges||this.edges,performance.now(),{active,straight:true});
  c.save();c.strokeStyle=this.light?'#467082':'#c3e1ec';c.fillStyle=this.light?'#2d566b':'#e3f4ff';c.lineWidth=1.8/this.view.z;
  for(const p of particles){
   c.globalAlpha=.8*Math.sin(Math.PI*p.phase);c.beginPath();c.moveTo(p.tail.x,p.tail.y);c.lineTo(p.head.x,p.head.y);c.stroke();
   c.beginPath();c.arc(p.head.x,p.head.y,2.3/this.view.z,0,Math.PI*2);c.fill();
  }
  c.restore();this.canvas.dataset.flowParticles=String(particles.length);return particles.length>0;
 }
 drawActivity(c){
  if(!this.pulses)return false;
  const now=performance.now(),reduce=this.reduced;
  let active=0;
  for(const [id,until] of this.pulses){if(until<=now){this.pulses.delete(id);continue;}const n=this.nodes.find(n=>n.id===id);if(!n)continue;active++;const fraction=1-(until-now)/2200,x=n.x*this.view.z+this.view.x,y=n.y*this.view.z+this.view.y;c.beginPath();c.arc(x,y,reduce?12:8+fraction*30,0,Math.PI*2);c.strokeStyle=`rgba(104,255,217,${(1-fraction)*.85})`;c.lineWidth=2;c.stroke();c.beginPath();c.arc(x,y,4,0,Math.PI*2);c.fillStyle='#c5fff0';c.fill();}
  this.canvas.dataset.activeNodes=String(active);return active>0&&!reduce;
 }
 timeline(){
  if(this.cellular)this.cell();
  this.stopLapse();
  this.timelineMode=!this.timelineMode;
  if(this.timelineMode){
   const min=Math.min(...this.nodes.map(n=>n.mtime)),max=Math.max(...this.nodes.map(n=>n.mtime));
   this.timelineRange=[min,max];
   for(const [i,n] of this.nodes.entries()){n.networkX=n.x;n.networkY=n.y;n.x=(n.mtime-min)/Math.max(1,max-min)*2200-1100+Math.sin(i*2.4)*12;n.y=this.groups.indexOf(n.folder)*100+Math.cos(i*2.4)*26;}
  }else{for(const n of this.nodes){n.x=n.networkX;n.y=n.networkY;}this.wake(.3);}
  this.canvas.dataset.map=this.timelineMode?'modified-time':'connections';
  this.canvas.dataset.layout='settled';this.fit();
 }
 // ---- growth time-lapse (the Animate button): documents appear oldest to newest while the layout reacts.
 lapseOrder(){return [...this.nodes].sort((a,b)=>a.mtime-b.mtime||a.id-b.id);}
 play(seconds){
  if(this.static||!this.nodes.length)return false;
  this.clearTrail();
  const order=this.lapseOrder(),base=(seconds||clamp(order.length*.028,7,18))*1000,duration=base/(this.display.animateSpeed||1);
  for(const n of this.nodes){n.shown=false;n.fade=1;n.placed=this.usingWorker();n.born=0;}
  const nbr=new Map();for(const e of this.edges){(nbr.get(e.a.id)||nbr.set(e.a.id,[]).get(e.a.id)).push(e.b);(nbr.get(e.b.id)||nbr.set(e.b.id,[]).get(e.b.id)).push(e.a);}
  this.lapse={order,base,duration,progress:0,start:performance.now(),playing:true,count:0,done:false,nbr};
  this.autoFit=true;this.sim.alphaTarget=.08;this.applyLapse(0);this.emitLapse();this.drawSoon();return true;
 }
 retime(){const l=this.lapse;if(!l)return;const now=performance.now();l.duration=l.base/(this.display.animateSpeed||1);if(l.playing)l.start=now-l.progress*l.duration;}
 pause(){if(this.lapse&&this.lapse.playing){this.lapse.playing=false;this.sim.alphaTarget=0;this.emitLapse();}}
 resume(){if(this.lapse&&!this.lapse.playing){if(this.lapse.progress>=1)return this.play();this.lapse.playing=true;this.lapse.start=performance.now()-this.lapse.progress*this.lapse.duration;this.sim.alphaTarget=.08;this.emitLapse();this.drawSoon();}}
 stopLapse(){if(!this.lapse)return;this.lapse=null;this.sim.alphaTarget=0;for(const n of this.nodes)n.shown=true;this.rebuildLive();this.wake(.3);this.emitLapse();}
 scrub(progress){if(!this.lapse)this.play();if(!this.lapse)return;this.lapse.playing=false;this.sim.alphaTarget=.05;this.lapse.progress=clamp(progress);this.applyLapse(this.lapse.progress);this.emitLapse();this.drawSoon();}
 applyLapse(progress){
  const l=this.lapse,total=l.order.length,count=Math.min(total,Math.round(progress*total)),now=performance.now();
  if(count===l.count&&l.built)return;
  const byId=new Map(this.nodes.map(n=>[n.id,n]));
  for(let i=0;i<total;i++){
   const n=l.order[i],show=i<count;
   if(show&&!n.shown){
    n.shown=true;n.born=now;
    if(!n.placed){
     const near=(l.nbr.get(n.id)||[]).filter(m=>m.shown&&m.placed);
     let anchor=near.length?near[Math.floor(Math.random()*near.length)]:null;if(!anchor)for(let j=0;j<i;j++){const m=l.order[j];if(m.placed&&m.shown){anchor=m;break;}}
     const t=Math.random()*Math.PI*2;
     if(anchor){n.x=anchor.x+Math.cos(t)*10;n.y=anchor.y+Math.sin(t)*10;}else{n.x=Math.cos(t)*20;n.y=Math.sin(t)*20;}
     n.vx=n.vy=0;n.placed=true;
    }
   }else if(!show)n.shown=false;
  }
  l.count=count;l.built=true;l.last=count?l.order[count-1].mtime:l.order[0].mtime;
  this.rebuildLive();this.sim.reheat(.4);
 }
 emitLapse(){const l=this.lapse;this.canvas.dataset.lapse=l?(l.playing?'playing':l.progress>=1?'done':'paused'):'off';this.onlapse?.(l?{playing:l.playing,progress:l.progress,count:l.count,total:l.order.length,date:l.last,done:l.progress>=1}:null);}
 stepLapse(now){
  const l=this.lapse;if(!l||!l.playing)return;
  l.progress=clamp((now-l.start)/l.duration);this.applyLapse(l.progress);
  if(l.progress>=1){l.playing=false;this.sim.alphaTarget=0;this.sim.reheat(.5);}
  this.emitLapse();
 }
 // ---- path trace drawn on the live graph
 tracePath(from,to){
  const ids=shortestPath(this.liveEdges,from,to);if(!ids)return null;
  this.trail={ids,start:performance.now(),nodes:ids.map(id=>this.nodes.find(n=>n.id===id))};this.canvas.dataset.trail=String(ids.length);this.drawSoon();return ids;
 }
 clearTrail(){this.trail=null;this.canvas.dataset.trail='0';this.drawSoon();}
 // ---- search / group highlighting
 highlight(predicate){this.match=predicate?new Set(this.live.filter(predicate).map(n=>n.id)):null;this.canvas.dataset.matches=this.match?String(this.match.size):'';this.drawSoon();return this.match?this.match.size:0;}
 trace(c,e){c.moveTo(e.a.x,e.a.y);c.lineTo(e.b.x,e.b.y);}
 arrows(c,active){
  let count=0;const mode=this.display.arrows;
  if(this.hideEdges||this.timelineMode||this.undirected||mode==='off'){this.canvas.dataset.arrows='0';return;}
  if(mode==='auto'&&!active&&this.view.z<2.4){this.canvas.dataset.arrows='0';return;}
  c.fillStyle=this.accent;c.beginPath();
  for(const e of this.liveEdges){
   if(count>=MAX_ARROWS)break;
   const focused=e.a.id===active||e.b.id===active;
   if(active&&!focused)continue;
   const p=arrowGeometry(e.a,e.b,{zoom:this.view.z,straight:true,targetRadius:e.b.radius});
   if(!p)continue;
   const sx=p.x*this.view.z+this.view.x,sy=p.y*this.view.z+this.view.y;
   if(sx<0||sy<0||sx>this.w||sy>this.h)continue;
   c.moveTo(p.x,p.y);c.lineTo(p.left.x,p.left.y);c.lineTo(p.right.x,p.right.y);c.closePath();count++;
  }
  c.globalAlpha=active?1:arrowAlpha(this.view.z);c.fill();c.globalAlpha=1;this.canvas.dataset.arrows=String(count);
 }
 clouds(c){
  if(!this.display.glow)return;
  if(this.cellular){c.save();c.translate(this.view.x,this.view.y);c.scale(this.view.z,this.view.z);drawCell(c,this.cellShape,{light:this.light,zoom:this.view.z});c.restore();return;}
  if(this.light||this.structural||this.timelineMode)return;
  const groups=new Map();
  for(const n of this.live){const g=groups.get(n.folder)||{x:0,y:0,count:0,color:n.color};g.x+=n.x;g.y+=n.y;g.count++;groups.set(n.folder,g);}
  for(const g of groups.values()){if(g.count<5)continue;const x=g.x/g.count*this.view.z+this.view.x,y=g.y/g.count*this.view.z+this.view.y,r=Math.max(50,Math.min(250,Math.sqrt(g.count)*16*this.view.z));c.globalAlpha=1;drawGlow(c,g.color,x,y,r,.075);}c.globalAlpha=1;
 }
 // Cluster names sit at each folder's centre and give way to document labels as you zoom in.
 clusterNames(c){
  if(!this.display.clusterLabels||this.hideLabels||this.cellular||this.timelineMode||this.display.colorBy==='custom')return 0;
  const alpha=clamp((1.25-this.view.z)/.55)*(1-.8*this.focusMix);if(alpha<=.02)return 0;
  const groups=new Map();for(const n of this.live){const g=groups.get(n.folder)||{x:0,y:0,count:0,color:n.color};g.x+=n.x;g.y+=n.y;g.count++;groups.set(n.folder,g);}
  const list=[...groups.entries()].filter(([,g])=>g.count>=4).sort((a,b)=>b[1].count-a[1].count).slice(0,14),placed=[];let drawn=0;
  c.save();c.textAlign='center';c.textBaseline='middle';
  for(const [name,g] of list){
   const x=g.x/g.count*this.view.z+this.view.x,y=g.y/g.count*this.view.z+this.view.y,size=clamp(11+Math.sqrt(g.count)*.7,12,20),text=name.length>26?name.slice(0,24)+'…':name;
   c.font=`600 ${size}px "Segoe UI",system-ui,sans-serif`;const w=c.measureText(text).width;
   if(x<-w||x>this.w+w||y<0||y>this.h)continue;if(placed.some(r=>Math.abs(r.x-x)<(r.w+w)/2+10&&Math.abs(r.y-y)<size+8))continue;
   placed.push({x,y,w});c.globalAlpha=alpha*.9;c.lineWidth=4;c.strokeStyle=this.light?'#f4f2ec':this.bg;c.lineJoin='round';c.strokeText(text,x,y);c.fillStyle=this.light?'#34394a':'#eef0f6';c.fillText(text,x,y);drawn++;
  }
  c.restore();return drawn;
 }
 rebuildLive(){
  const shown=n=>n.shown!==false&&(this.display.attachments!==false||!(n.kind===1||n.attachment));let live=this.nodes.filter(shown);
  let edges=this.edges.filter(e=>shown(e.a)&&shown(e.b));
  if(this.display.orphans===false){const linked=new Set();for(const e of edges){linked.add(e.a.id);linked.add(e.b.id);}live=live.filter(n=>linked.has(n.id));}
  this.live=live;this.liveEdges=edges;
  for(const n of live)n.adj=[];const set=new Set(live.map(n=>n.id));edges=this.liveEdges=edges.filter(e=>set.has(e.a.id)&&set.has(e.b.id));
  for(const e of edges){e.a.adj.push(e.b);e.b.adj.push(e.a);e.w=edgeWeight(e.a,e.b);}
  if(!this.static){
   if(live.length>1500&&typeof Worker!=='undefined'){if(!this.lapse)this.postGraph();}
   else{if(this.worker)this.stopWorker();this.sim.setGraph(live,edges.map(e=>[e.a,e.b]));}
  }
  this.drawSoon();
 }
 setData(data){
  const version=this.version=(this.version||0)+1,previous=new Map(this.nodes.map(n=>[n.id,n]));
  this.lapse=null;this.sim.alphaTarget=0;this.emitLapse();this.trail=null;this.match=null;this.hover=0;
  this.groups=[...new Set(data.nodes.map(n=>n.folder))];const groupMap=new Map(this.groups.map((g,i)=>[g,i])),indexes=new Map();
  this.nodes=data.nodes.map(n=>{
   const g=groupMap.get(n.folder),i=indexes.get(n.folder)||0;indexes.set(n.folder,i+1);
   const old=previous.get(n.id),angle=g*2.399963,ring=120+Math.sqrt(g)*60,cx=this.groups.length===1?0:Math.cos(angle)*ring,cy=this.groups.length===1?0:Math.sin(angle)*ring,r=Math.sqrt(i)*19,a=i*2.399963;
   const node={...n,g,shown:true,fade:1,placed:true,x:old?old.x:cx+Math.cos(a)*r,y:old?old.y:cy+Math.sin(a)*r,vx:0,vy:0,fx:null,fy:null,radius:nodeRadius(n.degree,this.display.nodeSize),color:''};const pin=this.pins.get(n.id);if(pin){node.fx=node.x=pin[0];node.fy=node.y=pin[1];}
   node.color=this.colorOf(node);node.carried=!!old;return node;
  });
  const map=new Map(this.nodes.map(n=>[n.id,n]));this.edges=data.edges.map(e=>({a:map.get(e.source),b:map.get(e.target)})).filter(e=>e.a&&e.b);
  // Carried-over documents keep their place; new ones start beside a neighbour that was already there.
  if(previous.size)for(const n of this.nodes)if(!n.carried){const nb=this.edges.find(e=>(e.a===n&&e.b.carried)||(e.b===n&&e.a.carried));const o=nb?(nb.a===n?nb.b:nb.a):null;if(o){const t=Math.random()*6.283;n.x=o.x+Math.cos(t)*12;n.y=o.y+Math.sin(t)*12;}}
  this.pendingAlpha=previous.size?.6:1;
  this.refresh();this.rebuildLive();
  if(this.cellular){this.applyShape();this.fit();return;}
  this.sim.alpha=previous.size?.6:1;this.sim.alphaTarget=0;
  if(this.forces.cluster)this.sim.setAnchors(this.groups.length,1+Math.min(1.2,this.live.length/700));
  this.autoFit=true;this.fit();
  if(this.reduced){this.sim.settle(400);this.canvas.dataset.layout='settled';this.fit();Object.assign(this.view,this.goal);}else this.canvas.dataset.layout='settling';
 }
 fit(){
  if(!this.nodes.some(n=>n.id===this.selected))this.selected=0;
  const list=this.live.length?this.live:this.nodes;if(!list.length){this.drawSoon();return;}
  if(this.cellular){const r=this.cellShape.radius;this.goal={x:this.w/2,y:this.h/2,z:Math.max(.08,Math.min((this.w-80)/(r*2.5),(this.h-170)/(r*2.3),2))};this.drawSoon();return;}
  const xs=list.map(n=>n.x).sort((a,b)=>a-b),ys=list.map(n=>n.y).sort((a,b)=>a-b),cut=list.length>60?Math.floor(list.length*.012):0;
  const minX=xs[cut],maxX=xs[xs.length-1-cut],minY=ys[cut],maxY=ys[ys.length-1-cut];
  const wide=this.w>780,top=wide?Math.min(120,this.h*.15):0,bottom=wide?Math.min(190,this.h*.24):40,z=Math.min((this.w-90)/Math.max(100,maxX-minX),(this.h-top-bottom)/Math.max(100,maxY-minY),2);
  this.goal={x:this.w/2-(minX+maxX)/2*z,y:top+(this.h-top-bottom)/2-(minY+maxY)/2*z,z:Math.max(.08,z)};this.drawSoon();
 }
 zoom(factor,x=this.w/2,y=this.h/2){const z=Math.max(.08,Math.min(8,this.goal.z*factor)),ratio=z/this.goal.z;this.goal={x:x-(x-this.goal.x)*ratio,y:y-(y-this.goal.y)*ratio,z};if(this.reduced)Object.assign(this.view,this.goal);this.drawSoon();}
 select(id){this.selected=this.nodes.some(n=>n.id===id)?id:0;this.drawSoon();}
 hit(e){const z=this.view.z,x=(e.offsetX-this.view.x)/z,y=(e.offsetY-this.view.y)/z;let best=null,d=Infinity;for(const n of this.live){const nd=Math.hypot(n.x-x,n.y-y);if(nd<Math.max(n.radius*Math.pow(z,-.4)+1.5/z,10/z)&&nd<d){best=n;d=nd;}}return best;}
 drawSoon(){if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});}
 // One physics step per frame (two when the frame was cheap and the graph is still hot). Heavy graphs thin out.
 step(){
  if(this.usingWorker())return !this.workerAsleep;
  if(this.static||this.sim.asleep||!this.live.length)return false;
  const budget=this.lastFrameMs||0;this.sim.tick();
  if(this.live.length<420&&this.sim.alpha>.25&&budget<6)this.sim.tick();
  return true;
 }
 draw(){
  if(!this.w)return;const started=performance.now();this.frames++;
  if(!this.bg)this.refresh();
  const reduced=this.reduced;let hot=false;
  if(this.lapse)this.stepLapse(started);
  if(!reduced||this.drag||this.lapse){hot=this.step();}
  if(this.autoFit&&hot&&this.alphaNow()>.04&&this.frames%6===0&&!this.static)this.fit();
  let moving=false;
  for(const k of ['x','y','z']){const d=this.goal[k]-this.view[k];if(reduced){this.view[k]=this.goal[k];}else if(Math.abs(d)>(k==='z'?.001:.15)){this.view[k]+=d*.24;moving=true;}else this.view[k]=this.goal[k];}
  const c=this.ctx,z=this.view.z,dense=this.live.length>1400;
  c.setTransform(this.dpr,0,0,this.dpr,0,0);c.clearRect(0,0,this.w,this.h);
  // Focus: hovering a document lights it and its neighbours and lets everything else recede; a search does the same for matches.
  const hover=this.hover&&this.live.find(n=>n.id===this.hover),focusSet=hover?new Set([hover.id,...hover.adj.map(n=>n.id)]):this.trail?new Set(this.trail.ids):this.match;
  const target=focusSet?1:0;this.focusMix+=(target-this.focusMix)*(reduced?1:.22);if(Math.abs(target-this.focusMix)<.01)this.focusMix=target;else moving=true;
  let fading=false;
  for(const n of this.live){const t=focusSet&&!focusSet.has(n.id)?.14:1;if(Math.abs(n.fade-t)>.01){n.fade+=(t-n.fade)*(reduced?1:.25);fading=true;}else n.fade=t;}
  this.clouds(c);
  c.save();c.translate(this.view.x,this.view.y);c.scale(z,z);
  const mix=this.focusMix,light=this.light,base=light?'70,80,100':'160,176,204';
  if(!this.hideEdges&&!this.timelineMode){
   const thick=this.display.linkThickness,buckets=[[],[],[]];
   const merge=this.liveEdges.length>2500;for(const e of this.liveEdges){if(hover&&(e.a===hover||e.b===hover))continue;buckets[merge?1:e.w<.33?0:e.w<.66?1:2].push(e);}
   const sparse=this.liveEdges.length<60;
   if(this.display.linkTint){const tinted=new Map();for(const e of this.liveEdges){const color=e.a.color;if(!tinted.has(color))tinted.set(color,[]);tinted.get(color).push(e);}for(const [color,list] of tinted){c.beginPath();for(const e of list)this.trace(c,e);c.lineWidth=thick/z;c.strokeStyle=color;c.globalAlpha=.16*(1-.82*mix);c.stroke();}c.globalAlpha=1;}else buckets.forEach((list,i)=>{if(!list.length)return;c.beginPath();for(const e of list)this.trace(c,e);const w=[.7,1,1.4][i]*thick,a=(sparse?.55:[.16,.26,.38][i])*(1-.82*mix)*(light?1.6:1);c.lineWidth=w/z;c.strokeStyle=`rgba(${base},${Math.min(1,a)})`;c.stroke();});
   if(this.selected&&!hover){c.beginPath();for(const e of this.liveEdges)if(e.a.id===this.selected||e.b.id===this.selected)this.trace(c,e);c.lineWidth=1.3*thick/z;c.strokeStyle=this.accent+'a8';c.stroke();}
   if(hover){c.beginPath();for(const e of this.liveEdges)if(e.a===hover||e.b===hover)this.trace(c,e);c.strokeStyle=this.accent+'30';c.lineWidth=6/z;c.stroke();c.strokeStyle=this.accent+'e0';c.lineWidth=1.3*thick/z;c.stroke();}
   if(this.match&&this.match.size&&!hover){c.beginPath();for(const e of this.liveEdges)if(this.match.has(e.a.id)&&this.match.has(e.b.id))this.trace(c,e);c.strokeStyle=this.accent+'90';c.lineWidth=1.2*thick/z;c.stroke();}
  }
  this.arrows(c,hover?.id||this.selected);
  const flowing=this.drawFlow(c,hover?.id||this.selected);
  const trailActive=this.drawTrail(c,started);
  const labels=[],detail=this.live.length<=40,now=started,batches=new Map(),specials=[];let popping=false;
  for(const n of this.live){
   const sx=n.x*z+this.view.x,sy=n.y*z+this.view.y;if(sx<-30||sx>this.w+30||sy<-30||sy>this.h+30)continue;
   const emphasized=n.id===this.selected||(hover&&n.id===hover.id),matched=this.match?.has(n.id);
   let scale=1;if(n.born&&now-n.born<520){scale=pop((now-n.born)/520);popping=true;}
   const radius=screenRadius(Math.max(n.radius*Math.pow(z,-.4)*scale,(detail?4:2.2)/z),1,z)/z;c.globalAlpha=n.fade*(n.born&&now-n.born<260?(now-n.born)/260:1);
   const plain=!this.pins.has(n.id)&&!n.phantom&&!emphasized&&!matched&&n.degree<=35&&scale===1&&!(n.born&&now-n.born<520);
   if(plain){const q=Math.round(c.globalAlpha*20),key=n.color+'|'+q;let group=batches.get(key);if(!group)batches.set(key,group={color:n.color,alpha:q/20,list:[]});group.list.push(n.x,n.y,radius);}
   else specials.push({n,radius,emphasized,matched,alpha:c.globalAlpha});
   const inFocus=focusSet&&(hover||this.trail)?focusSet.has(n.id):false,la=detail?1:Math.max(labelAlpha(z,n.degree,this.display.textFade),inFocus?1:0,emphasized?1:0);
   if(la>.03)labels.push({n,la:la*(n.fade<1?Math.max(.2,n.fade):1)});
  }
  c.globalAlpha=1;// Ordinary notes go down as one or two paths per colour. At overview scale a note is only a couple of pixels wide, so those are filled as tiny squares, which the canvas draws far faster than circles.
  for(const {color,alpha,list} of batches.values()){
   c.globalAlpha=alpha;c.fillStyle=color;c.beginPath();let arcs=false;
   for(let i=0;i<list.length;i+=3){const r=list[i+2];if(r*z<=2.7)c.rect(list[i]-r,list[i+1]-r,r*2,r*2);else arcs=true;}
   c.fill();
   if(arcs){c.beginPath();for(let i=0;i<list.length;i+=3){const r=list[i+2];if(r*z>2.7){c.moveTo(list[i]+r,list[i+1]);c.arc(list[i],list[i+1],r,0,Math.PI*2);}}c.fill();}
  }
  for(const {n,radius,emphasized,matched,alpha} of specials){
   c.globalAlpha=alpha;
   if(this.display.glow&&!dense&&(emphasized||matched||n.degree>35)){const keep=c.globalAlpha;drawGlow(c,matched?this.accent:n.color,n.x,n.y,radius+10/z,.44);c.globalAlpha=keep;}
   c.beginPath();c.arc(n.x,n.y,radius,0,Math.PI*2);c.fillStyle=n.color;if(n.phantom){c.globalAlpha*=.55;c.setLineDash([3/z,3/z]);c.lineWidth=1.4/z;c.strokeStyle=n.color;c.stroke();c.setLineDash([]);}else c.fill();
   if(n.degree>35&&!dense){c.beginPath();c.arc(n.x,n.y,radius*.38,0,Math.PI*2);c.fillStyle=light?'#fff9':'#fffC';c.fill();}
   if(emphasized||matched||this.pins.has(n.id)){c.strokeStyle=matched&&!emphasized?this.accent:n.color;c.lineWidth=1.4/z;c.beginPath();c.arc(n.x,n.y,radius+4/z,0,Math.PI*2);c.stroke();}
  }
  c.globalAlpha=1;
  c.restore();
  if(this.timelineMode)labels.splice(0,labels.length,...labels.filter(l=>l.n.id===this.selected||(hover&&l.n.id===hover.id)));if(this.hideLabels)labels.length=0;
  const occupied=[],fontSize=detail?13:11.5;c.font=`${fontSize}px "Segoe UI",system-ui,sans-serif`;c.textAlign='center';c.lineJoin='round';
  labels.sort((a,b)=>(((b.n.id===this.selected)||(hover&&b.n.id===hover.id))-((a.n.id===this.selected)||(hover&&a.n.id===hover.id)))||b.la*(1+b.n.degree*.01)-a.la*(1+a.n.degree*.01));
  const maxLabels=dense?60:140;
  for(const {n,la} of labels){
   if(occupied.length>=maxLabels)break;
   const x=n.x*z+this.view.x,y=n.y*z+this.view.y+Math.max(n.radius*z,detail?4:0)+fontSize+3,maximum=detail?52:36,text=n.title.length>maximum?n.title.slice(0,maximum-2)+'…':n.title,width=c.measureText(text).width;
   const priority=n.id===this.selected||(hover&&n.id===hover.id);
   if(!priority&&occupied.some(r=>Math.abs(r.y-y)<fontSize+3&&Math.abs(r.x-x)<(r.width+width)/2+6))continue;
   if(x<-width||y<0||y>this.h-(detail?12:8))continue;occupied.push({x,y,width});
   c.globalAlpha=la;c.lineWidth=3.2;c.strokeStyle=this.light?'#f7f6f1':this.bg;c.strokeText(text,x,y);c.fillStyle=priority?(light?'#1f2030':'#ffffff'):(light?'#3f4651':'#d3d8e4');c.fillText(text,x,y);
  }
  c.globalAlpha=1;
  const clusters=this.clusterNames(c);
  this.canvas.dataset.labels=String(occupied.length);this.canvas.dataset.clusterLabels=String(clusters);
  if(this.timelineMode){c.textAlign='left';c.font='10px Segoe UI';c.fillStyle=light?'#7554d4':'#c1abd9';for(const [i,g] of this.groups.entries()){const y=i*100*z+this.view.y;if(y>100&&y<this.h-120)c.fillText(g,15,y);}const format=t=>new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});c.fillText('MODIFIED TIME  '+format(this.timelineRange[0])+' → '+format(this.timelineRange[1]),20,this.h-130);}
  const activeEvents=this.drawActivity(c);
  const ms=performance.now()-started;this.lastFrameMs=ms;
  this.canvas.dataset.drawMs=ms.toFixed(2);this.canvas.dataset.nodes=this.nodes.length;this.canvas.dataset.live=this.live.length;this.canvas.dataset.edges=this.edges.length;this.canvas.dataset.zoom=z.toFixed(3);
  const asleep=this.calm();if(asleep&&this.canvas.dataset.layout==='settling'){this.canvas.dataset.layout='settled';if(this.autoFit)this.fit();}
  this.canvas.dataset.alpha=this.alphaNow().toFixed(3);this.canvas.dataset.worker=this.usingWorker()?'on':'off';
  if(!document.hidden&&(moving||fading||popping||activeEvents||flowing||trailActive||hot||this.drag||(this.lapse&&this.lapse.playing)))this.drawSoon();
 }
 drawTrail(c,now){
  const t=this.trail;if(!t)return false;
  const total=t.ids.length-1,elapsed=(now-t.start)/(this.reduced?1:900),progress=clamp(elapsed)*total;
  c.save();c.lineCap='round';c.lineJoin='round';
  const nodes=t.nodes.filter(Boolean);if(nodes.length<2){c.restore();return false;}
  c.beginPath();c.moveTo(nodes[0].x,nodes[0].y);
  for(let i=1;i<nodes.length;i++){const f=clamp(progress-(i-1));if(f<=0)break;const a=nodes[i-1],b=nodes[i];c.lineTo(a.x+(b.x-a.x)*f,a.y+(b.y-a.y)*f);}
  c.strokeStyle=this.accent+'38';c.lineWidth=9/this.view.z;c.stroke();c.strokeStyle=this.accent;c.lineWidth=2.2/this.view.z;c.stroke();
  for(let i=0;i<nodes.length;i++){if(progress+.01<i)break;const n=nodes[i];c.beginPath();c.arc(n.x,n.y,n.radius+3.5/this.view.z,0,Math.PI*2);c.lineWidth=2/this.view.z;c.strokeStyle=this.accent;c.stroke();}
  c.restore();return elapsed<1;
 }
 // Frame-time probe: runs real physics + drawing back to back for N frames and reports percentiles.
 benchmark(frames=120){
  const times=[];this.sim.reheat(1);const saved=this.lapse;
  for(let i=0;i<frames;i++){const t=performance.now();this.sim.alpha=Math.max(this.sim.alpha,.35);if(this.frame){cancelAnimationFrame(this.frame);this.frame=0;}this.draw();times.push(performance.now()-t);}
  times.sort((a,b)=>a-b);const at=p=>times[Math.min(times.length-1,Math.floor(times.length*p))];this.lapse=saved;
  return {nodes:this.live.length,edges:this.liveEdges.length,frames,p50:+at(.5).toFixed(2),p95:+at(.95).toFixed(2),max:+times[times.length-1].toFixed(2),mean:+(times.reduce((a,b)=>a+b,0)/times.length).toFixed(2)};
 }
}
