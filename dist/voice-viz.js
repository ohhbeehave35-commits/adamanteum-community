// Assistant's voice visualizer for the atlas: a ring of bars that moves only while she is speaking.
// Her replies are read aloud by the browser's own speech voice (nothing leaves this computer). A browser does not
// expose the audio it speaks, so the ring follows the speech itself: it starts on the first word, kicks on every word
// boundary the voice reports, and settles the moment she stops. It never moves while she is silent.
const BARS=72;
export function chunks(text,max=200){
 const clean=String(text||'').replace(/```[\s\S]*?```/g,' code block ').replace(/https?:\/\/\S+/g,' link ').replace(/[*_#>`|]/g,'').replace(/\s+/g,' ').trim();
 const parts=clean.match(/[^.!?\n]+[.!?]*\s*/g)||[clean],out=[];let cur='';
 for(const part of parts){if((cur+part).length>max&&cur){out.push(cur.trim());cur='';}if(part.length>max){for(let i=0;i<part.length;i+=max)out.push(part.slice(i,i+max).trim());}else cur+=part;}
 if(cur.trim())out.push(cur.trim());return out.filter(Boolean);
}
export function createVoice({name='Assistant',onstate}={}){
 const views=new Set();let level=0,target=0,speaking=false,raf=0,t0=performance.now(),kick=0,session=0;
 const synth=typeof speechSynthesis!=='undefined'?speechSynthesis:null;
 const supported=!!synth&&typeof SpeechSynthesisUtterance!=='undefined';
 const setSpeaking=v=>{if(speaking===v)return;speaking=v;for(const view of views)view.root.dataset.state=v?'speaking':'idle';onstate?.(v);loop();};
 // one visual: a canvas, her name under it
 function view(host,{className=''}={}){
  const root=document.createElement('div');root.className='voice-viz '+className;root.dataset.state=speaking?'speaking':'idle';
  root.setAttribute('role','img');root.setAttribute('aria-label',`${name} voice visualizer`);
  const canvas=document.createElement('canvas'),tag=document.createElement('span');tag.className='voice-tag';tag.textContent=name;tag.setAttribute('aria-hidden','true');
  root.append(canvas,tag);host.append(root);const v={root,canvas,fit(){const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);if(canvas.width!==Math.round(r.width*d)||canvas.height!==Math.round(r.height*d)){canvas.width=Math.round(r.width*d);canvas.height=Math.round(r.height*d);}return {w:r.width,h:r.height,d};}};
  views.add(v);return v;
 }
 function paint(v,now){
  const {w,h,d}=v.fit();if(!w)return;const c=v.canvas.getContext('2d');c.setTransform(d,0,0,d,0,0);c.clearRect(0,0,w,h);
  const cx=w/2,cy=h/2,R=Math.min(w,h)*.27,max=Math.min(w,h)*.22,t=(now-t0)/1000;
  const accent=getComputedStyle(v.root).getPropertyValue('--accent').trim()||'#b49be8';
  // soft core
  const g=c.createRadialGradient(cx,cy,0,cx,cy,R*(.95+level*.5));g.addColorStop(0,accent+'cc');g.addColorStop(1,accent+'00');c.fillStyle=g;c.beginPath();c.arc(cx,cy,R*(.95+level*.5),0,7);c.fill();
  c.lineCap='round';c.lineWidth=Math.max(2,R*.075);c.strokeStyle=accent;
  for(let i=0;i<BARS;i++){
   const a=i/BARS*Math.PI*2-Math.PI/2,wob=.5+.5*Math.sin(t*7.3+i*.9)*Math.sin(t*3.1+i*.37)+.25*Math.sin(t*11+i*2.1);
   const len=R*.1+max*level*Math.min(1,.25+wob*.85),r0=R*1.08;
   c.globalAlpha=.35+.65*Math.min(1,level*1.4+.15);c.beginPath();c.moveTo(cx+Math.cos(a)*r0,cy+Math.sin(a)*r0);c.lineTo(cx+Math.cos(a)*(r0+len),cy+Math.sin(a)*(r0+len));c.stroke();
  }
  c.globalAlpha=1;
 }
 function loop(){if(raf)return;raf=requestAnimationFrame(function frame(now){
  raf=0;const t=(now-t0)/1000;
  // while speaking: a speech-like envelope plus a kick for each word; when silent: ease to nothing
  if(speaking){kick*=.86;target=.38+.22*Math.sin(t*5.3)*Math.sin(t*2.1+1)+.35*kick+.1*Math.sin(t*13);}else target=0;
  level+=(target-level)*(target>level?.4:.12);if(level<.002&&!speaking)level=0;
  for(const v of views)paint(v,now);
  if(speaking||level>0)raf=requestAnimationFrame(frame);
 });}
 function speak(text){
  session++;if(supported)synth.cancel();if(!supported)return false;const parts=chunks(text);if(!parts.length)return false;
  let index=0;const mine=++session;
  const next=()=>{
   if(mine!==session)return;
   if(index>=parts.length){setSpeaking(false);return;}
   const u=new SpeechSynthesisUtterance(parts[index++]);u.lang=document.documentElement.lang||'en-US';u.rate=1;
   u.onstart=()=>{if(mine===session)setSpeaking(true);};u.onboundary=()=>{if(mine===session)kick=1;};u.onend=next;u.onerror=()=>{if(mine===session)setSpeaking(false);};
   synth.speak(u);
  };
  next();return true;
 }
 function stop(){session++;if(supported)synth.cancel();setSpeaking(false);}
 return {supported,view,speak,stop,get speaking(){return speaking;},get level(){return level;}};
}
