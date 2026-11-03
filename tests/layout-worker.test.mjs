import test from 'node:test';
import assert from 'node:assert/strict';
// The worker file talks through globalThis.postMessage / onmessage, so it can be driven here without a browser.
const sent=[];globalThis.postMessage=(m)=>sent.push(m);
await import('../dist/layout-worker.js');
const send=data=>globalThis.onmessage({data});
const graph=(n,version)=>({type:'graph',version,nodes:Array.from({length:n},(_,i)=>({x:Math.cos(i)*i,y:Math.sin(i)*i,degree:i%5+1,g:i%3})),links:Array.from({length:n-1},(_,i)=>[i,i+1]),forces:{center:.1,repel:.9,link:.4,distance:.5,cluster:0},alpha:1});
const until=async(fn,ms=8000)=>{const t=Date.now();while(!fn()){if(Date.now()-t>ms)throw Error('timed out');await new Promise(r=>setTimeout(r,5));}};
test('big-map layout runs off the page: positions stream back in slices and the layout comes to rest',async()=>{
 sent.length=0;send(graph(300,1));
 await until(()=>sent.some(m=>m.asleep));
 const first=sent[0],last=sent.at(-1);
 assert.equal(first.type,'pos');assert.equal(first.positions.length,600);assert.equal(first.version,1);assert.ok(sent.length>10,'many slices, not one blocking step');
 assert.ok(!first.asleep&&last.asleep);assert.ok(last.alpha<first.alpha);
 assert.ok(Array.from(last.positions).every(Number.isFinite));
 let moved=0;for(let i=0;i<300;i++)if(Math.hypot(last.positions[i*2]-first.positions[i*2],last.positions[i*2+1]-first.positions[i*2+1])>5)moved++;assert.ok(moved>150);
});
test('a pinned node holds still while the rest follow, and an unpin lets it settle; a new graph carries a new version',async()=>{
 sent.length=0;send(graph(200,2));await until(()=>sent.some(m=>m.asleep));
 sent.length=0;send({type:'pin',i:5,x:900,y:900});await until(()=>sent.length>20);
 const p=sent.at(-1).positions;assert.equal(p[10],900);assert.equal(p[11],900);
 send({type:'unpin',i:5});await until(()=>sent.some(m=>m.asleep&&m.version===2));
 sent.length=0;send(graph(50,3));await until(()=>sent.length>0);assert.equal(sent[0].version,3);
});
test('settle option answers once with the finished layout (reduced motion)',async()=>{
 sent.length=0;send({...graph(120,4),settle:true});await until(()=>sent.length>0);
 assert.equal(sent.length,1);assert.ok(sent[0].asleep);assert.equal(sent[0].version,4);
});
test('stop silences the worker',async()=>{
 send(graph(300,5));send({type:'stop'});sent.length=0;await new Promise(r=>setTimeout(r,120));assert.equal(sent.length,0);
});
