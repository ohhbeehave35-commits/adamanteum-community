import {cappedReheat} from './atlas-settings.js';
// Whole-vault layout: typed arrays only, no per-note objects, so 100,000 notes and 500,000 links settle in seconds.
// Notes push each other apart through a density grid (every note is deposited into a coarse grid, the grid is smoothed,
// and each note is pushed down the density slope), which keeps the spread as even as Obsidian's repel force while
// costing one pass over the notes instead of a pass over every pair. Links are springs; a pull to the centre keeps the
// whole thing together. The result is the same picture Obsidian draws: a dense, evenly spread cell.
// Obsidian's own units and defaults (centre 0-1, repel 0-20, link force 0-1, link distance 30-500), as owner has them set.
export const BIG_DEFAULTS=Object.freeze({center:.46,repel:11.23,link:.24,distance:254});
// ADAMCAP3: the four force sliders can only ever hand the layout numbers inside Obsidian's own ranges. A value that is missing, not a number
// or out of range is pulled back (to the nearest end, or to the default when it is not a number), so no saved setting or odd slider
// event can reach the simulation as NaN or Infinity.
export const FORCE_RANGES=Object.freeze({center:[0,1],repel:[0,20],link:[0,1],distance:[30,500]});
export function sanitizeForces(f={},base=BIG_DEFAULTS){
 const out={};
 for(const [k,[lo,hi]] of Object.entries(FORCE_RANGES)){
  const raw=f&&f[k],v=typeof raw==='number'?raw:Number.NaN;
  out[k]=Number.isNaN(v)?(Number.isFinite(base?.[k])?base[k]:BIG_DEFAULTS[k]):Math.min(hi,Math.max(lo,v));
 }
 return out;
}
// Pure placement helper: each independently simulated program sits beyond the main vault.
export function placeIslands(x,y,island,split=0){
 const groups=new Map();let extent=1;
 for(let i=0;i<x.length;i++){const k=island[i]||0;if(!k){extent=Math.max(extent,Math.hypot(x[i],y[i]));continue;}if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);}
 const all=[...groups.keys()].sort((a,b)=>a-b),centres=new Map();
 for(const k of all){const ids=groups.get(k),cx=ids.reduce((s,i)=>s+x[i],0)/ids.length,cy=ids.reduce((s,i)=>s+y[i],0)/ids.length;let radius=1;for(const i of ids)radius=Math.max(radius,Math.hypot(x[i]-cx,y[i]-cy));centres.set(k,{x:cx,y:cy,radius});}
 // ADAMCAP4: islands numbered above `split` (adapter, connector and extension orbs) sit on a second, outer ring. The inner ring is worked out from the
 // program islands alone, exactly as before, so adding orbs never moves a program island.
 const inner=split>0?all.filter(k=>k<=split):all,outer=split>0?all.filter(k=>k>split):[];
 const largestOf=ks=>ks.reduce((m,k)=>Math.max(m,centres.get(k).radius),1);
 const largest=largestOf(inner),ring=Math.max(extent*3,extent+largest*2+10,(largest+5)/Math.sin(Math.PI/Math.max(2,inner.length)));
 const put=(keys,radius,offset)=>keys.forEach((k,j)=>{const old=centres.get(k),angle=2*Math.PI*(j+offset)/keys.length-Math.PI/2,cx=Math.cos(angle)*radius,cy=Math.sin(angle)*radius;for(const i of groups.get(k)){x[i]+=cx-old.x;y[i]+=cy-old.y;}centres.set(k,{x:cx,y:cy,radius:old.radius});});
 put(inner,ring,0);
 let outerRing=0;
 if(outer.length){const big=largestOf(outer);outerRing=Math.max(ring+largest+big*2+40,(big+5)/Math.sin(Math.PI/Math.max(2,outer.length)));put(outer,outerRing,.5);}
 return {extent,ring,outerRing,centres};
}
export function bigConstants(f={}){
 const s={...BIG_DEFAULTS,...f};
 // Calibrated so owner's settings give the even dandelion cell; each control scales one constant in proportion.
 return {pull:.00216*s.center/.46,push:2.25*s.repel/11.23,spring:.535*s.link/.24,rest:1.975*s.distance/254};
}
export class BigSim{
 constructor(n,edges,forces={},island=[],opts={}){
  this.n=n;this.edges=edges;this.m=edges.length>>1;this.forces=sanitizeForces({...BIG_DEFAULTS,...forces});this.spread=Math.sqrt(Math.max(1,n))*1.1;this.recoveries=0;this.ringSplit=Number(opts?.ringSplit)>0?Number(opts.ringSplit):0;
  this.x=new Float32Array(n);this.y=new Float32Array(n);this.vx=new Float32Array(n);this.vy=new Float32Array(n);
  this.degree=new Uint32Array(n);
  for(let i=0;i<this.m;i++){this.degree[edges[2*i]]++;this.degree[edges[2*i+1]]++;}
  this.strength=new Float32Array(this.m);
  for(let i=0;i<this.m;i++){this.strength[i]=1/Math.min(this.degree[edges[2*i]],this.degree[edges[2*i+1]]);}
  this.bias=new Float32Array(this.m);
  for(let i=0;i<this.m;i++){const a=this.degree[edges[2*i]],b=this.degree[edges[2*i+1]];this.bias[i]=a/(a+b);}
  this.G=192;this.rho=new Float32Array(this.G*this.G);this.tmp=new Float32Array(this.G*this.G);
  this.alpha=1;this.alphaMin=.004;this.alphaDecay=1-Math.pow(this.alphaMin,1/220);this.alphaTarget=0;this.pinned=new Map();
  this.scatter();
  if(island.some(k=>k>0)){
   this.island=island;this.parts=[];const groups=new Map(),local=new Uint32Array(n);
   for(let i=0;i<n;i++){const k=island[i]||0;if(!groups.has(k))groups.set(k,{ids:[],edges:[]});const g=groups.get(k);local[i]=g.ids.length;g.ids.push(i);}
   for(let e=0;e<edges.length;e+=2){const a=edges[e],b=edges[e+1];if((island[a]||0)===(island[b]||0))groups.get(island[a]||0).edges.push(local[a],local[b]);}
   for(const [k,g] of groups){const sim=new BigSim(g.ids.length,Uint32Array.from(g.edges),forces);if(k>0){sim.G=32;sim.rho=new Float32Array(32*32);sim.tmp=new Float32Array(32*32);}this.parts.push({...g,k,sim});}
   this.compose();
  }
 }
 compose(){for(const p of this.parts)for(let j=0;j<p.ids.length;j++){this.x[p.ids[j]]=p.sim.x[j];this.y[p.ids[j]]=p.sim.y[j];}if(!this.offsets){placeIslands(this.x,this.y,this.island,this.ringSplit);this.offsets=new Map(this.parts.map(p=>[p.k,[this.x[p.ids[0]]-p.sim.x[0],this.y[p.ids[0]]-p.sim.y[0]]]));}else for(const p of this.parts){const [dx,dy]=this.offsets.get(p.k);for(const i of p.ids){this.x[i]+=dx;this.y[i]+=dy;}}this.alpha=Math.max(...this.parts.map(p=>p.sim.alpha));}
 // Start every note on a spiral whose radius follows its link count, linked notes near each other by id order:
 // hubs near the middle, loose notes outside. Settling then only has to fix the details.
 scatter(){
  const n=this.n,golden=Math.PI*(3-Math.sqrt(5));
  const order=new Uint32Array(n);for(let i=0;i<n;i++)order[i]=i;
  order.sort((a,b)=>this.degree[b]-this.degree[a]||a-b);
  const spread=Math.sqrt(n)*1.1;
  for(let k=0;k<n;k++){const i=order[k],r=spread*Math.sqrt((k+.5)/n),a=k*golden;this.x[i]=Math.cos(a)*r;this.y[i]=Math.sin(a)*r;}
 }
 setForces(f){this.forces=sanitizeForces({...this.forces,...(f&&typeof f==='object'?f:{})},this.forces);for(const p of this.parts||[])p.sim.setForces(f);this.reheat(.18);}
 reheat(a=.6){a=cappedReheat(a);this.alpha=Math.max(this.alpha,a);for(const p of this.parts||[])p.sim.reheat(a);}
 pin(i,x,y){if(!Number.isInteger(i)||i<0||i>=this.n||!Number.isFinite(x)||!Number.isFinite(y))return;if(this.parts){const p=this.parts.find(p=>p.ids.includes(i)),j=p.ids.indexOf(i),[dx,dy]=this.offsets.get(p.k);p.sim.pin(j,x-dx,y-dy);this.compose();return;}this.pinned.set(i,[x,y]);this.x[i]=x;this.y[i]=y;this.vx[i]=0;this.vy[i]=0;this.reheat(.3);}
 unpin(i){for(const p of this.parts||[]){const j=p.ids.indexOf(i);if(j>=0){p.sim.unpin(j);p.sim.reheat(.18);}}this.pinned.delete(i);}
 get asleep(){return this.alpha<this.alphaMin&&this.alphaTarget===0;}
 bounds(){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;const {x,y,n}=this;
  for(let i=0;i<n;i++){const a=x[i],b=y[i];if(a<x0)x0=a;if(a>x1)x1=a;if(b<y0)y0=b;if(b>y1)y1=b;}
  return {x0,y0,x1,y1};
 }
 // Start the layout again from the spiral, at rest, and warm it gently. Counted so a test (and the health line) can see it happened.
 recover(){this.scatter();this.vx.fill(0);this.vy.fill(0);this.alpha=Math.max(this.alpha,.5);this.recoveries++;for(const [i,p] of this.pinned){this.x[i]=p[0];this.y[i]=p[1];}}
 tick(){
  if(this.parts){for(const p of this.parts)if(!p.sim.asleep)p.sim.tick();this.compose();return;}
  const {n,m,x,y,vx,vy,edges,strength,bias,G,rho,tmp}=this,k=bigConstants(this.forces),alpha=this.alpha;
  // 1) density grid
  const b=this.bounds();
  // A layout that has gone non-finite (or is empty) is started again from the spiral instead of being drawn: nothing downstream ever sees NaN.
  if(n>0&&!(Number.isFinite(b.x0)&&Number.isFinite(b.x1)&&Number.isFinite(b.y0)&&Number.isFinite(b.y1))){this.recover();return;}
  const pad=(b.x1-b.x0+b.y1-b.y0)*.02+1,x0=b.x0-pad,y0=b.y0-pad,size=Math.max(b.x1-b.x0,b.y1-b.y0)+2*pad,cell=size/G;
  rho.fill(0);
  for(let i=0;i<n;i++){
   const gx=(x[i]-x0)/cell-.5,gy=(y[i]-y0)/cell-.5,ix=Math.floor(gx),iy=Math.floor(gy),fx=gx-ix,fy=gy-iy;
   if(ix<0||iy<0||ix>=G-1||iy>=G-1)continue;
   const o=iy*G+ix;rho[o]+=(1-fx)*(1-fy);rho[o+1]+=fx*(1-fy);rho[o+G]+=(1-fx)*fy;rho[o+G+1]+=fx*fy;
  }
  // 2) smooth it (two box passes each way) so one note does not push on itself and the push is long-range
  for(let pass=0;pass<3;pass++){
   for(let r=0;r<G;r++){const row=r*G;for(let c=0;c<G;c++){tmp[row+c]=(rho[row+Math.max(0,c-1)]+rho[row+c]*2+rho[row+Math.min(G-1,c+1)])*.25;}}
   for(let r=0;r<G;r++){const row=r*G,up=Math.max(0,r-1)*G,down=Math.min(G-1,r+1)*G;for(let c=0;c<G;c++){rho[row+c]=(tmp[up+c]+tmp[row+c]*2+tmp[down+c])*.25;}}
  }
  // 3) push down the density slope
  const scale=k.push*alpha*cell*.5;
  for(let i=0;i<n;i++){
   const gx=(x[i]-x0)/cell-.5,gy=(y[i]-y0)/cell-.5;let ix=Math.floor(gx),iy=Math.floor(gy);
   if(ix<1)ix=1;else if(ix>G-3)ix=G-3;if(iy<1)iy=1;else if(iy>G-3)iy=G-3;
   const o=iy*G+ix,dx=rho[o+1]-rho[o-1],dy=rho[o+G]-rho[o-G];
   vx[i]-=dx*scale;vy[i]-=dy*scale;
  }
  // 4) link springs (d3's strength and bias, so a hub does not drag its leaves into a point)
  const rest=k.rest,spring=k.spring*alpha;
  for(let e=0;e<m;e++){
   const a=edges[2*e],c=edges[2*e+1];let dx=x[c]+vx[c]-x[a]-vx[a],dy=y[c]+vy[c]-y[a]-vy[a];
   let d=Math.sqrt(dx*dx+dy*dy)||1e-6;const f=(d-rest)/d*Math.min(.9,spring*strength[e]);dx*=f;dy*=f;const w=bias[e];
   vx[c]-=dx*w;vy[c]-=dy*w;vx[a]+=dx*(1-w);vy[a]+=dy*(1-w);
  }
  // 5) pull to the centre, then move
  const pull=k.pull*alpha,decay=.62,vmax=Math.max(60,4*this.spread),lim=Math.max(600,12*this.spread);
  for(let i=0;i<n;i++){
   vx[i]-=x[i]*pull;vy[i]-=y[i]*pull;vx[i]*=decay;vy[i]*=decay;
   // Safety rails far outside anything the approved settings reach: one step never moves a note more than vmax, and no note leaves the box.
   if(vx[i]>vmax)vx[i]=vmax;else if(vx[i]<-vmax)vx[i]=-vmax;if(vy[i]>vmax)vy[i]=vmax;else if(vy[i]<-vmax)vy[i]=-vmax;
   let nx=x[i]+vx[i],ny=y[i]+vy[i];if(nx>lim)nx=lim;else if(nx<-lim)nx=-lim;if(ny>lim)ny=lim;else if(ny<-lim)ny=-lim;x[i]=nx;y[i]=ny;
  }
  for(const [i,p] of this.pinned){x[i]=p[0];y[i]=p[1];vx[i]=0;vy[i]=0;}
  this.alpha+=(this.alphaTarget-this.alpha)*this.alphaDecay;
 }
 // Run ticks until the time slice is used up; returns how many ran.
 run(ms){const t=performance.now();let ticks=0;do{this.tick();ticks++;}while(!this.asleep&&performance.now()-t<ms);return ticks;}
}
