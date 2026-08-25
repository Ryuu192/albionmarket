const CACHE="albion-market-pocket-v2-5-1-clipboard-v1";
const OCR_CACHE="albion-market-pocket-ocr-v1";
const OCR_HOSTS=new Set(["cdn.jsdelivr.net","unpkg.com","tessdata.projectnaptha.com"]);
const ASSETS=[
  "./",
  "./index.html",
  "./styles.css?v=2.5.1",
  "./app.js?v=2.5.1",
  "./manifest.webmanifest?v=2.5.1",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE&&k!==OCR_CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  const u=new URL(event.request.url);
  if(u.origin!==self.location.origin){
    if(!OCR_HOSTS.has(u.hostname)) return;
    event.respondWith(
      caches.open(OCR_CACHE).then(async cache=>{
        const cached=await cache.match(event.request);
        if(cached) return cached;
        const response=await fetch(event.request);
        if(response.ok||response.type==="opaque") cache.put(event.request,response.clone());
        return response;
      })
    );
    return;
  }

  if(event.request.mode==="navigate"){
    event.respondWith(fetch(event.request,{cache:"no-store"}).catch(()=>caches.match("./index.html")));
    return;
  }

  event.respondWith(
    fetch(event.request,{cache:"no-store"}).then(response=>{
      if(response.ok){
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      }
      return response;
    }).catch(()=>caches.match(event.request))
  );
});
