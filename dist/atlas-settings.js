// Shared rendering limits and persisted preferences for Adamanteum.
export const MAX_ARROWS=25000;
export function screenRadius(radius,scale=1,zoom=1){return Math.max(.35,Math.min(6,Number(radius)*Number(scale)*Number(zoom)||.35));}
export function arrowAlpha(zoom){return Math.max(0,Math.min(.65,(zoom-1)*.22));}
export function visibleEdge(ax,ay,bx,by,w,h){return Math.max(ax,bx)>=0&&Math.min(ax,bx)<=w&&Math.max(ay,by)>=0&&Math.min(ay,by)<=h;}
export function arrowBudget(count){return Math.max(0,Math.min(MAX_ARROWS,Math.floor(count)||0));}
export function cappedReheat(alpha){return Math.max(0,Math.min(.18,Number(alpha)||0));}
export function coalesceFrame(run,request=cb=>requestAnimationFrame(cb)){let pending=false,latest;return value=>{latest=value;if(pending)return;pending=true;request(()=>{pending=false;run(latest);});};}
export function throttleLatest(run,delay=100,schedule=setTimeout,now=()=>performance.now()){let last=-Infinity,timer=null,latest;return value=>{latest=value;const flush=()=>{timer=null;last=now();run(latest);};if(timer!==null)return;const wait=delay-(now()-last);if(wait<=0)flush();else timer=schedule(flush,wait);};}
export const PALETTES=Object.freeze({Spectrum:['#ef658e','#ffad47','#c2ca45','#42c79a','#43b9e8','#8581f5','#ca75ed','#e27751','#64b969','#5797ef','#ed82bd','#b4a269'],Ember:['#ed6455','#f59c45','#d7b74c','#d67a99','#b96dce','#e89273'],Aurora:['#54c6a6','#6bbadf','#9883ef','#d47cce','#72b96a','#e4ac70'],Ocean:['#48b7cb','#638fe4','#50bb9a','#8a89d8','#81b9ec','#669aaf'],Mono:['#94a3b8']});
const paletteCache=new Map();
export function paletteColors(name='Spectrum',light=false){const key=name+':'+light;if(paletteCache.has(key))return paletteCache.get(key);const colors=(PALETTES[name]||PALETTES.Spectrum).map(h=>light?'#'+h.slice(1).match(/../g).map(v=>Math.round(parseInt(v,16)*.64).toString(16).padStart(2,'0')).join(''):h);paletteCache.set(key,Object.freeze(colors));return colors;}
export function nodeColor({folder=0,age=0,degree=0,island=0,kind=0},display={},light=false){const pal=paletteColors(display.palette,light);let index=folder;if(display.colorBy==='age')index=Math.floor(Math.max(0,Math.min(.999,age))*pal.length);if(display.colorBy==='links')index=Math.floor(Math.log2(1+degree));if(display.colorBy==='none')return light?'#586174':'#a6b0c4';if(island)index=island-1;const base=pal[((index%pal.length)+pal.length)%pal.length];if(!island||kind===3)return base;return '#'+base.slice(1).match(/../g).map(v=>{const n=parseInt(v,16);return Math.round(kind===4?n+(255-n)*.35:kind===6?n+(255-n)*.55:n*.65+128*.35).toString(16).padStart(2,'0');}).join('');}
export function pinKey(vault){return 'Adamanteum:atlas:pins:'+encodeURIComponent(vault);}
export function readPins(storage,vault){try{const data=JSON.parse(storage.getItem(pinKey(vault))||'[]');return new Map(data.filter(p=>Array.isArray(p)&&p.length===2&&Array.isArray(p[1])&&p[1].length===2&&p[1].every(Number.isFinite)));}catch{return new Map();}}
export function savePins(storage,vault,pins){try{storage.setItem(pinKey(vault),JSON.stringify([...pins]));return true;}catch{return false;}}

// Map chrome and labels use CSS pixels, independently of device pixel ratio.
export const ATLAS_TOP_BAND=44;
export const ATLAS_BOTTOM_PADDING=120;
export function atlasViewport(width,height,labelWidth=0,bottom=ATLAS_BOTTOM_PADDING){
 // Bound reservations before subtraction, including dock overlap during scrolling.
 const reserve=(requested,dimension)=>Math.min(dimension*.18,Math.max(0,Number(requested)||0));
 const side=reserve(Math.max(24,labelWidth/2+12),width),top=reserve(width<=720?(width<=600?140:104):ATLAS_TOP_BAND,height),foot=reserve(bottom,height);
 const usableW=Math.max(width*.55,width-side*2),usableH=Math.max(height*.55,height-top-foot);
 return {left:side,right:side+usableW,top,bottom:top+usableH};
}
export function fitAtlas(width,height,extent,labelWidth=0,bottom=ATLAS_BOTTOM_PADDING){
 const area=atlasViewport(width,height,labelWidth,bottom),spanX=Math.max(1,extent.x1-extent.x0),spanY=Math.max(1,extent.y1-extent.y0);
 const usableW=area.right-area.left,usableH=area.bottom-area.top,plainScale=Math.min(width/spanX,height/spanY);
 const z=Math.max(plainScale*.4,Math.min(usableW/spanX,usableH/spanY));
 return {z,x:(area.left+area.right)/2-(extent.x0+extent.x1)/2*z,y:(area.top+area.bottom)/2-(extent.y0+extent.y1)/2*z,area,usableW,usableH,plainScale};
}
// ORGANIC-PHONE ("more organic"): a tall phone canvas gets the same treatment a wide desktop canvas does. Wide maps spread the program islands sideways (bigatlas islandAspect); a tall map spreads them (and opens the main mass) downwards in proportion to its shape. A wide or square canvas is 1 = unchanged, so the desktop look is untouched.
export function tallStretch(width,height){if(!width||!height)return 1;const raw=width/height;return raw>.87?1:Math.min(2.2,1/raw*.9);}
export function programLabelIndices(count,width){const cap=width<600?8:count,n=Math.min(count,cap);return Array.from({length:n},(_,i)=>Math.floor(i*count/n));}
export function boxesOverlap(a,b,gap=4){return a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y;}
// Priority labels claim space first, but output remains in program order. Ordinary
// labels are skipped on collision; priority labels search free vertical slots.
export function placeProgramLabels(labels,bounds,blocked=[]){
 const placed=new Map(),occupied=[...blocked],clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const place=item=>{const width=Math.min(item.width,bounds.right-bounds.left),height=Math.min(item.height||20,bounds.bottom-bounds.top);
  const base={...item,width,height,x:clamp(item.x-width/2,bounds.left,bounds.right-width),y:clamp(item.y-height-9,bounds.top,bounds.bottom-height)};
  let box=base;
  if(occupied.some(b=>boxesOverlap(box,b))){if(!item.priority)return;let free=null;
   for(let y=bounds.top;y<=bounds.bottom-height;y+=height+4){const candidate={...base,y};if(!occupied.some(b=>boxesOverlap(candidate,b))){free=candidate;break;}}
   box=free||base;
  }placed.set(item.id,box);occupied.push(box);
 };
 for(const item of labels.filter(l=>l.priority))place(item);
 for(const item of labels.filter(l=>!l.priority))place(item);
 return labels.filter(l=>placed.has(l.id)).map(l=>placed.get(l.id));
}

export const INTERACTION_MS=160;
const MOTION_BUDGET=Object.freeze({interacting:true,labels:60,halo:false,arrows:'auto',arrowLimit:512});
const REST_BUDGET=Object.freeze({interacting:false,labels:260,halo:true,arrows:null,arrowLimit:MAX_ARROWS});
export function interactionBudget(now,until){return now<until?MOTION_BUDGET:REST_BUDGET;}
export function labelRebuildDue(now,last,interacting){return !interacting||now-last>=100;}
// Writes edge ids into caller-owned storage. Auto never scans unrelated edges.
export function arrowCandidates(s,out){
 if(s.alpha<=0||s.mode==='off'||s.mode==='auto'&&s.hover<0)return 0;
 const auto=s.mode!=='on',start=auto?s.adjStart[s.hover]:0,end=auto?s.adjStart[s.hover+1]:s.edges.length/2;
 const limit=Math.min(MAX_ARROWS,out.length,s.limit??MAX_ARROWS);let count=0;
 for(let k=start;k<end&&count<limit;k++){
  const e=auto?s.adjEdge[k]:k,a=s.edges[e*2],b=s.edges[e*2+1],ax=s.pos[a*2],ay=s.pos[a*2+1],bx=s.pos[b*2],by=s.pos[b*2+1];
  // Numeric world-space viewport rejection precedes visibility/time checks.
  if(ax<s.x0&&bx<s.x0||ax>s.x1&&bx>s.x1||ay<s.y0&&by<s.y0||ay>s.y1&&by>s.y1||bx<s.x0||bx>s.x1||by<s.y0||by>s.y1)continue;
  if(s.visible&&(!s.visible[a]||!s.visible[b]))continue;
  if(s.rank&&(s.rank[a]>s.lapse||s.rank[b]>s.lapse))continue;
  const dx=bx-ax,dy=by-ay;if((dx*dx+dy*dy)*s.zoom*s.zoom<100)continue;
  out[count++]=e;
 }return count;
}
