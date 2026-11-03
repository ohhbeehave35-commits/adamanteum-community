// Whole-vault layout worker. The page only draws; this runs BigSim in slices of about 10 ms and posts positions.
import {BigSim} from './bigphysics.js';
let sim=null,timer=0,version=0,lastPost=0,sentAt=-Infinity,waiting=false;
// ADAMCAP3: at most one set of positions is on its way to the page at a time. The page answers each one with an 'ack' once it has used it;
// until then the worker keeps laying out but sends nothing new, so a busy page can never be buried under a queue of 800 KB messages (the
// memory climb and the freeze). A page that never answers (an older page) is not waited for more than a second.
function post(final=false){
 if(!sim)return;
 if(waiting&&!final&&performance.now()-sentAt<1000)return;
 const pos=new Float32Array(sim.n*2);
 for(let i=0;i<sim.n;i++){pos[2*i]=sim.x[i];pos[2*i+1]=sim.y[i];}
 postMessage({type:'pos',positions:pos,alpha:sim.alpha,asleep:sim.asleep,version,final},[pos.buffer]);
 lastPost=sentAt=performance.now();waiting=true;
}
function loop(){
 timer=0;if(!sim)return;
 if(sim.asleep){post(true);return;}
 sim.run(10);
 if(performance.now()-lastPost>=30)post();
 timer=setTimeout(loop,0);
}
const wake=()=>{if(!timer&&sim)timer=setTimeout(loop,0);};
onmessage=({data:m})=>{
 if(m.type==='init'){sim=new BigSim(m.n,m.edges,m.forces||{},m.island||[],{ringSplit:m.ringSplit||0});version=m.version||0;if(m.start)sim.alpha=m.start;if(m.settle){while(!sim.asleep)sim.run(50);post(true);}else{post();wake();}}
 else if(m.type==='ack'){waiting=false;if(sim&&!sim.asleep)wake();}
 else if(!sim)return;
 else if(m.type==='forces'){sim.setForces(m.forces);wake();}
 else if(m.type==='pin'){sim.pin(m.i,m.x,m.y);wake();}
 else if(m.type==='unpin'){sim.unpin(m.i);sim.reheat(.2);wake();}
 else if(m.type==='reheat'){sim.reheat(m.alpha||.6);wake();}
 else if(m.type==='stop'){clearTimeout(timer);timer=0;sim=null;}
};
