import {APP_SHELL,handleOfflineApi} from './offline-index.js';
// WRONGLOOK1 (owner 25 Oct 21:40): v3 on purpose. Browsers that kept the old 'adamanteum-shell-v1' copy served it first (caches.match looks through every cache, oldest first), so his app kept the old screens after every upgrade. Activate now deletes every cache but this one, and lookups only read this one.
const CACHE='adamanteum-shell-v12';
const INDEX='/api/offline-index';

self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name!==CACHE).map(name=>caches.delete(name)))).then(()=>self.clients.claim()));
});

async function jsonResponse(result){
 return new Response(JSON.stringify(result.body),{status:result.status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}
async function snapshot(){
 const cached=await caches.match(INDEX,{cacheName:CACHE});
 if(!cached)return null;
 try{return await cached.json();}catch{return null;}
}
async function fromIndex(request){
 const saved=await snapshot();
 const result=handleOfflineApi(request.url,saved);
 return jsonResponse(result);
}
async function networkThenIndex(request){
 try{
  const response=await fetch(request);
  if(response.ok||response.status===403)return response; // a refusal (acceptance required) is shown as it is, never replaced by saved vault data
 }catch{}
 return fromIndex(request);
}
async function cacheIndex(request){
 try{
  const response=await fetch(request);
  if(response.ok){
   const copy=response.clone();
   const cache=await caches.open(CACHE);
   await cache.put(INDEX,copy);
  }
  return response;
 }catch{
  return (await caches.match(INDEX,{cacheName:CACHE}))||jsonResponse({status:503,body:{error:'offline: search needs the index',offline:true}});
 }
}

self.addEventListener('message',event=>{
 if(event.data&&event.data.type==='save-offline-index')event.waitUntil(cacheIndex(INDEX).catch(()=>{}));
});

self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.pathname.startsWith('/api/programs'))return;
 if(url.pathname==='/api/search'||url.pathname==='/api/doc'){
  event.respondWith(networkThenIndex(request));
  return;
 }
 if(url.pathname===INDEX){
  event.respondWith(cacheIndex(request));
  return;
 }
 if(url.pathname.startsWith('/api/'))return;
 // The front page is network-first: the server decides whether the acceptance page or the app is served, and the acceptance page is never saved as the app.
 if(url.pathname==='/'||url.pathname==='/index.html'){
  event.respondWith(fetch(request).then(response=>{if(response.ok&&!response.headers.get('x-acceptance-version')){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;}).catch(()=>caches.match(request,{cacheName:CACHE})));
  return;
 }
 // Saved copy first so the app opens offline; refresh the saved copy in the background so an upgraded server is picked up on the next open.
 event.respondWith(caches.match(request,{cacheName:CACHE}).then(cached=>{
  const fresh=fetch(request).then(response=>{
   if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}
   return response;
  });
  if(cached){fresh.catch(()=>{});return cached;}
  return fresh;
 }));
});
