import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation,forceConstants,kinetic,FORCE_DEFAULTS} from '../dist/physics.js';
let seed=11;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
function graph(n,extra=.6){
 const nodes=[],links=[];
 for(let i=0;i<n;i++)nodes.push({id:i,x:Math.cos(i*2.4)*Math.sqrt(i)*19,y:Math.sin(i*2.4)*Math.sqrt(i)*19,degree:0,g:i%5,vx:0,vy:0});
 for(let i=1;i<n;i++){const j=Math.floor(rnd()*i);links.push([nodes[i],nodes[j]]);nodes[i].degree++;nodes[j].degree++;if(rnd()<extra){const k=Math.floor(rnd()*n);if(k!==i){links.push([nodes[i],nodes[k]]);nodes[i].degree++;nodes[k].degree++;}}}
 return {nodes,links};
}
test('force sliders map to monotonic physical constants',()=>{
 assert.ok(forceConstants({repel:1}).charge>forceConstants({repel:0}).charge);
 assert.ok(forceConstants({distance:1}).linkDistance>forceConstants({distance:0}).linkDistance);
 assert.ok(forceConstants({center:1}).centerK>forceConstants({center:0}).centerK);
 assert.ok(forceConstants({link:1}).linkK>forceConstants({link:0}).linkK);
 assert.equal(forceConstants().linkDistance,forceConstants(FORCE_DEFAULTS).linkDistance);
});
test('layout really moves nodes, then comes to rest',()=>{
 const {nodes,links}=graph(300),start=nodes.map(n=>[n.x,n.y]),sim=new Simulation(nodes,links);
 let ticks=0;while(!sim.asleep&&ticks<800){sim.tick();ticks++;}
 assert.ok(sim.asleep,'layout must settle by itself');assert.ok(ticks>60,'settling is a visible motion, not a jump');assert.ok(ticks<500);
 const moved=nodes.filter((n,i)=>Math.hypot(n.x-start[i][0],n.y-start[i][1])>5).length;
 assert.ok(moved>nodes.length*.9,`only ${moved} of ${nodes.length} nodes moved`);
 assert.ok(nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));assert.ok(kinetic(nodes)<1);
});
test('unlinked nodes push apart; linked nodes pull to the link distance',()=>{
 const a={id:1,x:0,y:0,degree:0,vx:0,vy:0},b={id:2,x:6,y:0,degree:0,vx:0,vy:0},apart=new Simulation([a,b],[],{center:0});
 for(let i=0;i<60;i++)apart.tick();assert.ok(b.x-a.x>40,'repulsion must separate near nodes');
 const c={id:3,x:0,y:0,degree:1,vx:0,vy:0},d={id:4,x:600,y:0,degree:1,vx:0,vy:0},joined=new Simulation([c,d],[[c,d]],{center:0,repel:0});
 for(let i=0;i<400;i++)joined.tick();const distance=Math.hypot(d.x-c.x,d.y-c.y);assert.ok(distance<200&&distance>forceConstants({distance:FORCE_DEFAULTS.distance}).linkDistance*.5,`link settled at ${distance}`);
});
test('dragging a node pins it and its neighbourhood follows; releasing lets it settle',()=>{
 const {nodes,links}=graph(120),sim=new Simulation(nodes,links);sim.settle(500);
 const hub=[...nodes].sort((x,y)=>y.degree-x.degree)[0],neighbours=links.filter(([a,b])=>a===hub||b===hub).map(([a,b])=>a===hub?b:a);
 const before=neighbours.map(n=>Math.hypot(n.x-(hub.x+250),n.y-hub.y)),beforeX=neighbours.map(n=>n.x);
 hub.fx=hub.x+250;hub.fy=hub.y;sim.alphaTarget=.3;sim.reheat(.3);for(let i=0;i<120;i++)sim.tick();
 assert.equal(hub.x,hub.fx);assert.equal(hub.y,hub.fy);
 const after=neighbours.map(n=>Math.hypot(n.x-hub.x,n.y-hub.y));
 assert.ok(neighbours.filter((n,i)=>n.x>beforeX[i]+20).length>=Math.ceil(neighbours.length*.6),'most neighbours must follow the dragged node');
 assert.ok(after.reduce((s,v)=>s+v,0)<before.reduce((s,v)=>s+v,0),'neighbours end up nearer the new position');
 hub.fx=hub.fy=null;sim.alphaTarget=0;let ticks=0;while(!sim.asleep&&ticks<800){sim.tick();ticks++;}assert.ok(sim.asleep);
});
test('Barnes-Hut repulsion agrees with exact all-pairs repulsion',()=>{
 const {nodes}=graph(160,0),sim=new Simulation(nodes,[]),charge=forceConstants(FORCE_DEFAULTS).charge;
 for(const n of nodes){n.vx=n.vy=0;}sim.repel(charge,1);const approx=nodes.map(n=>[n.vx,n.vy]);
 let error=0,total=0;
 nodes.forEach((p,i)=>{let ex=0,ey=0;for(const [j,q] of nodes.entries()){if(i===j)continue;const dx=q.x-p.x,dy=q.y-p.y,d2=Math.max(1,dx*dx+dy*dy),w=charge*sim.nodeCharge[j]/d2;ex-=dx*w;ey-=dy*w;}error+=Math.hypot(approx[i][0]-ex,approx[i][1]-ey);total+=Math.hypot(ex,ey);});
 assert.ok(error/total<.12,`relative error ${(error/total).toFixed(3)}`);
});
test('a frame of physics for 500 nodes stays well inside a 60 fps budget',()=>{
 const {nodes,links}=graph(500),sim=new Simulation(nodes,links);sim.settle(30);
 const times=[];for(let i=0;i<40;i++){sim.reheat(.5);const t=performance.now();sim.tick();times.push(performance.now()-t);}
 times.sort((a,b)=>a-b);assert.ok(times[20]<8,`median tick ${times[20].toFixed(2)} ms`);
});
test('folder anchors pull each folder together when clustering is on',()=>{
 const spread=g=>{const by=new Map();for(const n of g.nodes){(by.get(n.g)||by.set(n.g,[]).get(n.g)).push(n);}let s=0;for(const list of by.values()){const cx=list.reduce((a,n)=>a+n.x,0)/list.length,cy=list.reduce((a,n)=>a+n.y,0)/list.length;s+=list.reduce((a,n)=>a+Math.hypot(n.x-cx,n.y-cy),0)/list.length;}return s/by.size;};
 seed=5;const plain=graph(250),clustered=graph(250);seed=5;
 new Simulation(plain.nodes,plain.links).settle(500);
 const sim=new Simulation(clustered.nodes,clustered.links,{cluster:.55});sim.setAnchors(5);sim.settle(500);
 assert.ok(spread(clustered)<spread(plain)*.85,`${spread(clustered).toFixed(0)} vs ${spread(plain).toFixed(0)}`);
});
