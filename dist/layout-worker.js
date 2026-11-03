// Layout for big maps runs here, off the page's main thread, so the screen never waits on physics.
// Messages in:  graph {nodes:[{x,y,degree,g}],links:[[i,j]],forces,alpha,anchors,settle}  forces {forces}  pin {i,x,y}  unpin {i}  reheat {alpha}  stop
// Messages out: pos {positions:Float32Array(x,y,...),alpha,asleep,version}
import {Simulation} from './physics.js';
let sim=null,nodes=[],timer=0,version=0;
function post(asleep){
 const positions=new Float32Array(nodes.length*2);
 for(let i=0;i<nodes.length;i++){positions[i*2]=nodes[i].x;positions[i*2+1]=nodes[i].y;}
 globalThis.postMessage({type:'pos',positions,alpha:sim.alpha,asleep,version},[positions.buffer]);
}
function step(){
 timer=0;if(!sim)return;
 const started=performance.now();let ticks=0;
 do{sim.tick();ticks++;}while(performance.now()-started<9&&!sim.asleep&&ticks<4);
 post(sim.asleep);
 if(!sim.asleep)timer=setTimeout(step,0);
}
function run(){if(!timer&&sim)timer=setTimeout(step,0);}
globalThis.onmessage=({data})=>{
 if(data.type==='graph'){
  clearTimeout(timer);timer=0;version=data.version||0;
  nodes=data.nodes.map(n=>({x:n.x,y:n.y,degree:n.degree,g:n.g,vx:0,vy:0,fx:null,fy:null}));
  sim=new Simulation(nodes,data.links.map(([a,b])=>[nodes[a],nodes[b]]),data.forces);
  sim.alpha=data.alpha??1;if(data.anchors)sim.setAnchors(data.anchors.count,data.anchors.spread);
  if(data.settle){sim.settle(400);post(true);return;}
  run();
 }else if(data.type==='forces'&&sim){Object.assign(sim.forces,data.forces);if(data.anchors)sim.setAnchors(data.anchors.count,data.anchors.spread);sim.reheat(data.alpha??.55);run();}
 else if(data.type==='pin'&&sim){const n=nodes[data.i];if(n){n.fx=data.x;n.fy=data.y;sim.alphaTarget=.3;sim.reheat(.3);run();}}
 else if(data.type==='unpin'&&sim){const n=nodes[data.i];if(n){n.fx=n.fy=null;}sim.alphaTarget=0;run();}
 else if(data.type==='reheat'&&sim){sim.reheat(data.alpha??.6);run();}
 else if(data.type==='stop'){clearTimeout(timer);timer=0;sim=null;nodes=[];}
};
