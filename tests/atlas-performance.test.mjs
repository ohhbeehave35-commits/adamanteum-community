import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {interactionBudget,labelRebuildDue,arrowCandidates,INTERACTION_MS,MAX_ARROWS,atlasViewport} from '../dist/atlas-settings.js';
import {BigAtlas} from '../dist/bigatlas.js';
const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8');
test('interaction budget is allocation-free, expires at 160ms, and restores full detail',()=>{
 assert.equal(INTERACTION_MS,160);const moving=interactionBudget(0,160),rest=interactionBudget(160,160);
 assert.equal(moving,interactionBudget(159,160));assert.equal(moving.labels,60);assert.equal(moving.halo,false);assert.equal(moving.arrows,'auto');assert.ok(moving.arrowLimit<=MAX_ARROWS);
 assert.equal(rest,interactionBudget(400,160));assert.equal(rest.labels,260);assert.equal(rest.halo,true);assert.equal(rest.arrows,null);
 assert.equal(labelRebuildDue(99,0,true),false);assert.equal(labelRebuildDue(100,0,true),true);assert.equal(labelRebuildDue(1,0,false),true);
});
test('auto arrow candidates touch only hovered-node adjacency; zero alpha touches no edges',()=>{
 const edges=new Proxy([2,3,0,1,4,5],{get(a,k){if(k==='0'||k==='1'||k==='4'||k==='5')assert.fail('unrelated edge read');return a[k];}});
 const s={mode:'auto',alpha:1,hover:0,edges,adjStart:Uint32Array.of(0,1,2),adjEdge:Uint32Array.of(1,1),pos:Float32Array.of(0,0,30,0),x0:-100,y0:-100,x1:100,y1:100,zoom:1},out=new Uint32Array(5);
 assert.equal(arrowCandidates(s,out),1);assert.equal(out[0],1);
 assert.equal(arrowCandidates({...s,hover:-1},out),0);assert.equal(arrowCandidates({mode:'on',alpha:0},out),0);
});
test('on arrow candidates reject offscreen edges before visibility and enforce output cap',()=>{
 const edges=new Uint32Array(300000*2);for(let e=0;e<300000;e++){edges[e*2]=e<100000?2:0;edges[e*2+1]=e<100000?3:1;}
 const visible=new Proxy([1,1],{get(a,k){assert.ok(k==='0'||k==='1','offscreen visibility was read');return a[k];}});
 const s={mode:'on',alpha:1,hover:-1,edges,pos:Float32Array.of(0,0,30,0,500,500,550,550),visible,x0:-100,y0:-100,x1:100,y1:100,zoom:1};
 const out=new Uint32Array(MAX_ARROWS+100);assert.equal(arrowCandidates(s,out),MAX_ARROWS);assert.equal(out[0],100000);assert.equal(out[MAX_ARROWS-1],124999);
 assert.equal(arrowCandidates({...s,limit:512},out),512);assert.equal(arrowCandidates(s,new Uint32Array(3)),3);
});
test('arrow selection preserves visibility, replay time, short-edge and direction rules',()=>{
 const s={mode:'on',alpha:1,edges:Uint32Array.of(0,1),pos:Float32Array.of(0,0,30,0),visible:Uint8Array.of(1,1),rank:Float32Array.of(.1,.9),lapse:1,x0:-10,y0:-10,x1:40,y1:10,zoom:1},out=new Uint32Array(5);
 assert.equal(arrowCandidates(s,out),1);assert.equal(arrowCandidates({...s,lapse:.5},out),0);assert.equal(arrowCandidates({...s,visible:Uint8Array.of(1,0)},out),0);assert.equal(arrowCandidates({...s,x1:20},out),0);assert.equal(arrowCandidates({...s,zoom:.1},out),0);
});
test('wheel and drag reset one trailing full-detail redraw, never one timer per event',t=>{
 let clock=0,next=0,draws=0;const timers=new Map();t.mock.method(performance,'now',()=>clock);t.mock.method(globalThis,'setTimeout',(fn,ms)=>{assert.equal(ms,160);timers.set(++next,fn);return next;});t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 const big=Object.create(BigAtlas.prototype);Object.assign(big,{detailTimer:0,drawSoon(){draws++;}});
 for(clock=0;clock<400;clock+=10){big.markInteraction();assert.equal(timers.size,1);assert.equal(big.interactingUntil,clock+160);}
 const fn=timers.values().next().value;timers.clear();clock=550;fn();assert.equal(draws,1);assert.equal(big.labelKey,null);assert.equal(big.programBuiltAt,-Infinity);assert.equal(big.detailTimer,0);
 const source=read('dist/bigatlas.js');assert.match(source,/pointerdown',e=>\{this.markInteraction/);assert.match(source,/wheel',e=>\{this.markInteraction/);assert.match(source,/this.markInteraction\(\);if\(this.pointers.size===2\)/);
});
test('motion canvas renders at most sixty labels without halos and reuses lists for 100ms',()=>{
 let fills=0,strokes=0;const c={setTransform(){},clearRect(){},fillText(){fills++;},strokeText(){strokes++;}};
 const big=Object.create(BigAtlas.prototype),n=1000;Object.assign(big,{ink:{getContext:()=>c,dataset:{}},dpr:1,w:1440,h:900,view:{x:0,y:0,z:1},fitZoom:.2,hideEdges:true,display:{nodeSize:1,textFade:0,orphans:true},interactingUntil:160,titles:Array(n).fill('Note'),shortTitles:Array(n).fill('Note'),pos:new Float32Array(n*2),degree:new Uint32Array(n).fill(99),degreeOrder:Uint32Array.from({length:n},(_,i)=>i),labelImportance:new Float32Array(n).fill(3),kind:new Uint8Array(n),nodeVisible:new Uint8Array(n).fill(1),labelIds:new Uint32Array(260),labelAlphas:new Float32Array(260),labelX:new Float32Array(260),labelY:new Float32Array(260),labelCells:new Int32Array(2000),labelBuiltAt:-Infinity,labelKey:null,hover:-1,selected:-1,pins:new Map(),prepareProgramLabels:()=>0,drawProgramLabels(){}});
 for(let i=0;i<n;i++){big.pos[i*2]=10+i%14*100;big.pos[i*2+1]=10+Math.floor(i/14)*20;}
 big.drawInk(0);assert.equal(fills,60);assert.equal(strokes,0);const built=big.labelBuiltAt;
 fills=0;big.view.x=2;big.drawInk(50);assert.equal(big.labelBuiltAt,built);assert.ok(fills<=60);
 big.drawInk(100);assert.equal(big.labelBuiltAt,100);fills=strokes=0;big.labelKey=null;big.drawInk(160);assert.ok(fills>60&&fills<=260);assert.equal(strokes,fills);
});
test('focus membership buffers survive position-only redraws and invalidate on hover change',()=>{
 const big=Object.create(BigAtlas.prototype);Object.assign(big,{hover:0,match:null,trail:null,visibleVersion:1,nodeVisible:Uint8Array.of(1,1),adjStart:Uint32Array.of(0,1,2),adj:Uint32Array.of(1,0),adjEdge:Uint32Array.of(0,0)});
 const first=big.focusSet();big.posVersion=22;assert.equal(big.focusSet(),first);assert.equal(big.focusSet().nodes,first.nodes);big.hover=1;assert.notEqual(big.focusSet(),first);
 const source=read('dist/bigatlas.js'),ink=source.slice(source.indexOf(' drawInk('),source.indexOf(' prepareProgramLabels(')),focus=source.slice(source.indexOf(' drawFocus('),source.indexOf(' rebuildLabels('));
 assert.doesNotMatch(ink+focus,/new (?:Float32Array|Uint32Array|Set)|getComputedStyle|getPropertyValue/);assert.match(source,/attributeFilter:\['data-theme'\]/);assert.match(source,/this.degreeOrder.sort/);assert.doesNotMatch(source.slice(source.indexOf(' rebuildLabels('),source.indexOf(' inkLabel(')),/\.sort\(/);
});
test('desktop title and controls share the 10px row with a 44px fit band; narrow maps wrap',()=>{
 const css=read('dist/phone.css');assert.match(css,/@media\(min-width:601px\)\{\s*body \.atlas \.atlas-heading\{top:10px;right:420px;min-height:30px;height:30px/);assert.match(css,/\.graph-top\{top:10px;right:12px;left:auto;height:30px;align-items:center\}/);assert.match(css,/@container\(max-width:940px\)/);assert.equal(atlasViewport(850,800).top,44);assert.equal(atlasViewport(1980,1100).top,44);assert.ok(atlasViewport(390,928).top>44);
});

test('the Living Atlas heading never sits under the graph controls: a 860 px map uses two rows, wider maps keep a 420 px clear gap',()=>{
 const css=read('dist/phone.css');
 assert.match(css,/@container\(max-width:940px\)\{\s*body \.atlas \.atlas-heading\{top:10px;right:12px/);
 assert.match(css,/atlas-heading\{top:10px;right:420px/);
});
