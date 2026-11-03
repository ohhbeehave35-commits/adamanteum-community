// Force layout for the atlas: link springs, Barnes-Hut repulsion, centre pull, optional folder clustering.
// Pure and DOM-free so it can be tested in Node. Same family of forces Obsidian's graph (d3-force) uses.
export const FORCE_DEFAULTS=Object.freeze({center:.06,repel:.9,link:.4,distance:.5,cluster:0});
// Slider (0..1) -> physical constants. Kept in one place so the panel, the tests and the benchmark agree.
export function forceConstants(f={}){
 const s={...FORCE_DEFAULTS,...f};
 return {centerK:.01+s.center*.14,charge:6+s.repel*60,linkK:.15+s.link*1.1,linkDistance:12+s.distance*90,clusterK:s.cluster*.16};
}
export class Simulation{
 constructor(nodes=[],links=[],forces={}){
  this.alpha=1;this.alphaMin=.0015;this.alphaDecay=1-Math.pow(this.alphaMin,1/260);this.alphaTarget=0;this.velocityDecay=.55;this.theta2=.81;
  this.forces={...FORCE_DEFAULTS,...forces};this.setGraph(nodes,links);
 }
 setForces(f){Object.assign(this.forces,f);this.reheat(.5);}
 // links are [a,b] node pairs. Strength follows d3: shared by the lower-degree end so hubs do not collapse.
 setGraph(nodes,links){
  this.nodes=nodes;this.links=links;const count=new Map();
  for(const [a,b] of links){count.set(a,(count.get(a)||0)+1);count.set(b,(count.get(b)||0)+1);}
  this.linkStrength=links.map(([a,b])=>1/Math.min(count.get(a),count.get(b)));
  this.linkBias=links.map(([a,b])=>count.get(a)/(count.get(a)+count.get(b)));
  this.size=nodes.length;
  const cap=Math.max(16,this.size*5);
  if(!this.order||this.order.length<this.size){this.order=new Int32Array(this.size+64);this.scratch=new Int32Array(this.size+64);}
  if(!this.tx||this.cap<cap){const room=Math.ceil(cap*1.25);this.tx=new Float64Array(room);this.ty=new Float64Array(room);this.tm=new Float64Array(room);this.tw=new Float64Array(room);this.tlo=new Int32Array(room);this.thi=new Int32Array(room);this.tc=new Int32Array(room*4);this.cap=room;}
  for(const n of nodes){if(n.vx===undefined){n.vx=0;n.vy=0;}if(!Number.isFinite(n.x))n.x=(Math.random()-.5)*50;if(!Number.isFinite(n.y))n.y=(Math.random()-.5)*50;}
  this.nodeCharge=nodes.map(n=>1+.18*Math.log2(1+(n.degree||0)));
  this.anchors=null;
 }
 reheat(a=1){this.alpha=Math.max(this.alpha,a);}
 get asleep(){return this.alpha<this.alphaMin&&this.alphaTarget<=0;}
 // Build the quad tree: in-place four-way partition of the index list, mass and centre of mass bottom-up.
 build(){
  const n=this.nodes,N=this.size;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let i=0;i<N;i++){const p=n[i];if(p.x<minX)minX=p.x;if(p.x>maxX)maxX=p.x;if(p.y<minY)minY=p.y;if(p.y>maxY)maxY=p.y;this.order[i]=i;}
  this.used=0;if(!N)return -1;const w=Math.max(maxX-minX,maxY-minY,1)+1;
  return this.cell(0,N,minX,minY,w,0);
 }
 cell(lo,hi,x0,y0,w,depth){
  const id=this.used++;if(id>=this.cap-1)return id;const n=this.nodes;
  this.tlo[id]=lo;this.thi[id]=hi;this.tw[id]=w;this.tc[id*4]=this.tc[id*4+1]=this.tc[id*4+2]=this.tc[id*4+3]=-1;
  let m=0,cx=0,cy=0;
  for(let k=lo;k<hi;k++){const i=this.order[k],c=this.nodeCharge[i];m+=c;cx+=n[i].x*c;cy+=n[i].y*c;}
  this.tm[id]=m;this.tx[id]=cx/m;this.ty[id]=cy/m;
  if(hi-lo<=1||depth>30)return id;
  const half=w/2,mx=x0+half,my=y0+half,counts=[0,0,0,0];
  for(let k=lo;k<hi;k++){const p=n[this.order[k]];counts[(p.x>=mx?1:0)+(p.y>=my?2:0)]++;}
  const start=[lo,lo+counts[0],lo+counts[0]+counts[1],lo+counts[0]+counts[1]+counts[2]],fill=start.slice();
  for(let k=lo;k<hi;k++){const i=this.order[k],p=n[i];this.scratch[fill[(p.x>=mx?1:0)+(p.y>=my?2:0)]++]=i;}
  for(let k=lo;k<hi;k++)this.order[k]=this.scratch[k];
  for(let q=0;q<4;q++)if(counts[q])this.tc[id*4+q]=this.cell(start[q],start[q]+counts[q],x0+(q&1?half:0),y0+(q&2?half:0),half,depth+1);
  return id;
 }
 repel(strength,alpha){
  const root=this.build();if(root<0)return;const n=this.nodes,stack=new Int32Array(128),dmax2=1e6;
  for(let i=0;i<this.size;i++){
   const p=n[i];let sp=0;stack[sp++]=root;
   while(sp){
    const id=stack[--sp];let dx=this.tx[id]-p.x,dy=this.ty[id]-p.y,d2=dx*dx+dy*dy;
    const leaf=this.thi[id]-this.tlo[id]<=1||this.tc[id*4]+this.tc[id*4+1]+this.tc[id*4+2]+this.tc[id*4+3]===-4;
    if(leaf){
     for(let k=this.tlo[id];k<this.thi[id];k++){const j=this.order[k];if(j===i)continue;const q=n[j];dx=q.x-p.x;dy=q.y-p.y;d2=dx*dx+dy*dy;if(d2>=dmax2)continue;if(d2<1){dx=(Math.random()-.5)*.1;dy=(Math.random()-.5)*.1;d2=dx*dx+dy*dy+1;}const w=strength*this.nodeCharge[j]*alpha/d2;p.vx-=dx*w;p.vy-=dy*w;}
     continue;
    }
    if(this.tw[id]*this.tw[id]/d2<this.theta2){if(d2<dmax2){if(d2<1)d2=1;const w=strength*this.tm[id]*alpha/d2;p.vx-=dx*w;p.vy-=dy*w;}continue;}
    for(let q=0;q<4;q++){const c=this.tc[id*4+q];if(c>=0)stack[sp++]=c;}
   }
  }
 }
 // One physics step. Returns the new alpha.
 tick(){
  const k=forceConstants(this.forces),a=this.alpha,n=this.nodes;
  this.alpha+=(this.alphaTarget-this.alpha)*this.alphaDecay;
  for(let i=0;i<this.links.length;i++){
   const [s,t]=this.links[i];let x=t.x+t.vx-s.x-s.vx,y=t.y+t.vy-s.y-s.vy,l=Math.hypot(x,y)||1e-6;
   const f=(l-k.linkDistance)/l*a*k.linkK*this.linkStrength[i]*.5;x*=f;y*=f;const b=this.linkBias[i];
   t.vx-=x*b;t.vy-=y*b;s.vx+=x*(1-b);s.vy+=y*(1-b);
  }
  this.repel(k.charge,a);
  const cl=k.clusterK;
  if(cl>0&&this.anchors)for(const p of n){const an=this.anchors[p.g];if(an){p.vx+=(an.x-p.x)*cl*a;p.vy+=(an.y-p.y)*cl*a;}}
  for(const p of n){
   p.vx-=p.x*k.centerK*a;p.vy-=p.y*k.centerK*a;
   if(p.fx!=null){p.x=p.fx;p.y=p.fy;p.vx=p.vy=0;continue;}
   p.vx*=1-this.velocityDecay;p.vy*=1-this.velocityDecay;p.x+=p.vx;p.y+=p.vy;
  }
  return this.alpha;
 }
 // Folder anchors on a sunflower spiral so clusters get distinct homes. radius scales with group size.
 setAnchors(groupCount,spread=1){
  const a=[];for(let g=0;g<groupCount;g++){const r=(30+Math.sqrt(g+.5)*58)*spread,t=g*2.399963;a.push({x:Math.cos(t)*r,y:Math.sin(t)*r});}
  this.anchors=a;
 }
 // Run until calm (or a step cap); used for reduced motion and for tests.
 settle(steps=300){let i=0;while(i++<steps&&this.alpha>this.alphaMin)this.tick();return i;}
}
// Largest total distance any node moved in one step; the test and the benchmark use it as "kinetic energy".
export function kinetic(nodes){let e=0;for(const n of nodes)e+=n.vx*n.vx+n.vy*n.vy;return e;}
