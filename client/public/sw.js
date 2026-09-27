const CACHE="onefix-fictitious-beta-v2";
self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const shell=new URL("./index.html",self.registration.scope);
    const response=await fetch(shell,{cache:"no-store"});
    if(!response.ok)throw new Error("No se pudo preparar la aplicación sin conexión");
    const html=await response.text();
    const assets=[...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(([,url])=>new URL(url,shell))
      .filter(url=>url.origin===self.location.origin&&url.pathname.includes("/assets/"));
    const cache=await caches.open(CACHE);
    await cache.addAll([shell,...assets]);
  })());
  self.skipWaiting();
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET"||request.url.includes("/api/")||request.url.includes("/__PORT_"))return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(request.mode==="navigate"){
    event.respondWith(fetch(request).then(async response=>{
      if(response.ok)await (await caches.open(CACHE)).put(new URL("./index.html",self.registration.scope),response.clone());
      return response;
    }).catch(()=>caches.match("./index.html")));
    return;
  }
  if(url.pathname.includes("/assets/")||url.pathname.endsWith(".js")||url.pathname.endsWith(".css")){
    event.respondWith(caches.open(CACHE).then(async cache=>{
      const cached=await cache.match(request);
      if(cached)return cached;
      const response=await fetch(request);
      if(response.ok) await cache.put(request,response.clone());
      return response;
    }));
  }
});
