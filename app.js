const $ = id => document.getElementById(id);

const API_HOSTS = {
  west: "https://west.albion-online-data.com",
  europe: "https://europe.albion-online-data.com",
  east: "https://east.albion-online-data.com"
};
const ITEMS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json";
const CITIES = ["Caerleon","Bridgewatch","Fort Sterling","Lymhurst","Martlock","Thetford","Brecilien","Black Market"];
const STORE = {
  settings: "amp-settings-v2",
  favorites: "amp-favorites-v2",
  recent: "amp-recent-v2"
};

let items = [];
let selected = null;
let lastPrices = [];
let lastRoute = null;
let installPrompt = null;
let debounceTimer = null;
let fetchSeq = 0;

const safeJSON = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const getStore = (key, fallback) => safeJSON(localStorage.getItem(key), fallback);
const setStore = (key, value) => localStorage.setItem(key, JSON.stringify(value));

function esc(s=""){
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function money(n){
  return Number(n || 0).toLocaleString("es-UY", {maximumFractionDigits:0});
}
function pct(n){
  return `${Number(n || 0).toLocaleString("es-UY",{maximumFractionDigits:1})}%`;
}
function baseId(id){
  return String(id || "").replace(/@\d+$/, "");
}
function currentItemId(){
  if(!selected) return "";
  const e = Number($("enchantment").value);
  return baseId(selected.id) + (e > 0 ? `@${e}` : "");
}
function imageUrl(id, quality=1, size=128){
  return `https://render.albiononline.com/v1/item/${encodeURIComponent(id)}.png?quality=${quality}&size=${size}`;
}
function localizedName(obj){
  const names = obj.LocalizedNames || obj.localizedNames || {};
  return names["ES-ES"] || names["es-ES"] || names["ES"] || names["EN-US"] || names["en-US"] || obj.UniqueName || obj.uniqueName || "Objeto";
}
function normalizeItem(obj){
  const id = obj.UniqueName || obj.uniqueName || obj.Index || obj.index;
  if(!id) return null;
  return {id, name: localizedName(obj)};
}
function ageInfo(dateStr){
  if(!dateStr || String(dateStr).startsWith("0001-")) return {label:"Sin datos", cls:"very-stale", hours:Infinity};
  const iso = /z$/i.test(dateStr) ? dateStr : `${dateStr}Z`;
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return {label:"Fecha desconocida", cls:"very-stale", hours:Infinity};
  const hours = Math.max(0,(Date.now()-d.getTime())/36e5);
  if(hours < 1) return {label:`Hace ${Math.max(1,Math.round(hours*60))} min`, cls:"", hours};
  if(hours < 24) return {label:`Hace ${Math.round(hours)} h`, cls:"", hours};
  if(hours < 72) return {label:`Hace ${Math.round(hours/24)} d`, cls:"stale", hours};
  return {label:`Hace ${Math.round(hours/24)} d`, cls:"very-stale", hours};
}
function showError(msg){
  $("error").textContent = msg;
  $("error").classList.toggle("hidden", !msg);
}
function saveSettings(){
  setStore(STORE.settings, {
    server:$("server").value,
    sort:$("sort").value,
    enchantment:$("enchantment").value,
    quality:$("quality").value,
    quantity:$("quantity").value,
    marketFee:$("marketFee").value
  });
}
function loadSettings(){
  const s = getStore(STORE.settings, {});
  for(const id of ["server","sort","enchantment","quality","quantity","marketFee"]){
    if(s[id] != null && $(id)) $(id).value = s[id];
  }
}

async function loadItems(){
  try{
    const cacheKey = "albion-items-lite-v2";
    const cached = sessionStorage.getItem(cacheKey);
    if(cached){
      items = JSON.parse(cached);
      $("searchStatus").textContent = `${items.length.toLocaleString("es-UY")} objetos listos.`;
      return;
    }
    const res = await fetch(ITEMS_URL, {cache:"force-cache"});
    if(!res.ok) throw new Error("No se pudo descargar el catálogo.");
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : (raw.items || raw.Items || []);
    items = list.map(normalizeItem).filter(Boolean).filter(x => !x.id.includes("_UNTRADEABLE"));
    try{ sessionStorage.setItem(cacheKey, JSON.stringify(items)); }catch(_){}
    $("searchStatus").textContent = `${items.length.toLocaleString("es-UY")} objetos listos.`;
  }catch(e){
    $("searchStatus").textContent = "No pude cargar nombres. Puedes pegar un ID como T6_ORE.";
  }
}

function searchScore(x,q){
  const name = x.name.toLocaleLowerCase("es");
  const id = x.id.toLowerCase();
  if(name === q) return 0;
  if(name.startsWith(q)) return 1;
  if(name.includes(q)) return 2;
  if(id.startsWith(q)) return 3;
  return 4;
}
function renderSuggestions(query){
  const box = $("suggestions");
  const q = query.trim().toLocaleLowerCase("es");
  if(q.length < 2){ box.classList.add("hidden"); return; }

  let matches = items
    .filter(x => x.name.toLocaleLowerCase("es").includes(q) || x.id.toLowerCase().includes(q))
    .sort((a,b)=>searchScore(a,q)-searchScore(b,q))
    .slice(0,18);

  if(!matches.length && /^[A-Z0-9_@]+$/i.test(query.trim())){
    matches = [{id:query.trim().toUpperCase(),name:"Usar ID ingresado"}];
  }
  if(!matches.length){
    box.innerHTML = `<div class="suggestion"><div><strong>Sin resultados</strong><small>Prueba otro nombre o un ID del objeto</small></div></div>`;
    box.classList.remove("hidden");
    return;
  }

  box.innerHTML = matches.map((x,i)=>`
    <div class="suggestion" data-i="${i}">
      <img src="${imageUrl(baseId(x.id),1,64)}" alt="" loading="lazy">
      <div><strong>${esc(x.name)}</strong><small>${esc(x.id)}</small></div>
    </div>`).join("");

  box.querySelectorAll(".suggestion[data-i]").forEach(el=>{
    el.addEventListener("click",()=>{
      selectItem(matches[Number(el.dataset.i)]);
      box.classList.add("hidden");
    });
  });
  box.classList.remove("hidden");
}

function favoriteKey(item=selected){
  if(!item) return "";
  return `${baseId(item.id)}|${$("enchantment").value}|${$("quality").value}`;
}
function isFavorite(){
  const key = favoriteKey();
  return getStore(STORE.favorites, []).some(x=>x.key===key);
}
function refreshFavoriteButton(){
  if(!selected) return;
  const on = isFavorite();
  $("favoriteBtn").textContent = on ? "★" : "☆";
  $("favoriteBtn").title = on ? "Quitar de favoritos" : "Agregar a favoritos";
}
function toggleFavorite(){
  if(!selected) return;
  const key = favoriteKey();
  let favs = getStore(STORE.favorites, []);
  const idx = favs.findIndex(x=>x.key===key);
  if(idx >= 0) favs.splice(idx,1);
  else favs.unshift({
    key, id:baseId(selected.id), name:selected.name,
    enchantment:$("enchantment").value, quality:$("quality").value
  });
  setStore(STORE.favorites, favs.slice(0,24));
  refreshFavoriteButton();
  renderQuickLists();
}
function addRecent(){
  if(!selected) return;
  const key = favoriteKey();
  let list = getStore(STORE.recent, []).filter(x=>x.key!==key);
  list.unshift({
    key,id:baseId(selected.id),name:selected.name,
    enchantment:$("enchantment").value,quality:$("quality").value
  });
  setStore(STORE.recent,list.slice(0,12));
  renderQuickLists();
}
function chipHTML(x,i,type){
  const iid = x.id + (Number(x.enchantment)>0 ? `@${x.enchantment}` : "");
  return `<button class="chip" data-type="${type}" data-i="${i}">
    <img src="${imageUrl(iid,Number(x.quality),48)}" alt="" loading="lazy">
    <span>${esc(x.name)} ${x.enchantment>0?`.`+x.enchantment:""}</span>
  </button>`;
}
function renderQuickLists(){
  const favs = getStore(STORE.favorites, []);
  const recent = getStore(STORE.recent, []);
  $("favoriteSection").classList.toggle("hidden", !favs.length);
  $("recentSection").classList.toggle("hidden", !recent.length);
  $("favorites").innerHTML = favs.map((x,i)=>chipHTML(x,i,"fav")).join("");
  $("recents").innerHTML = recent.map((x,i)=>chipHTML(x,i,"recent")).join("");

  document.querySelectorAll(".chip").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const list = btn.dataset.type==="fav" ? getStore(STORE.favorites,[]) : getStore(STORE.recent,[]);
      const x = list[Number(btn.dataset.i)];
      if(!x) return;
      $("enchantment").value = x.enchantment;
      $("quality").value = x.quality;
      saveSettings();
      selectItem({id:x.id,name:x.name});
      fetchPrices();
    });
  });
}

function selectItem(item){
  selected = {id:baseId(item.id),name:item.name};
  $("search").value = item.name;
  $("itemName").textContent = item.name;
  $("itemId").textContent = currentItemId();
  $("itemImg").src = imageUrl(currentItemId(),Number($("quality").value),128);
  $("selectedItem").classList.remove("hidden");
  $("searchPrices").disabled = false;
  $("historySection").classList.add("hidden");
  $("historyStats").classList.add("hidden");
  $("chartEmpty").classList.remove("hidden");
  clearChart();
  refreshFavoriteButton();
  showError("");
}

async function fetchPrices(){
  if(!selected) return;
  const seq = ++fetchSeq;
  showError("");
  $("searchPrices").disabled = true;
  $("searchPrices").textContent = "Consultando…";

  const host = API_HOSTS[$("server").value];
  const id = currentItemId();
  const q = $("quality").value;
  $("itemId").textContent = id;
  $("itemImg").src = imageUrl(id,Number(q),128);

  const url = `${host}/api/v2/stats/prices/${encodeURIComponent(id)}.json?locations=${encodeURIComponent(CITIES.join(","))}&qualities=${q}`;
  try{
    const res = await fetch(url,{cache:"no-store"});
    if(!res.ok) throw new Error(`Error HTTP ${res.status}`);
    const data = await res.json();
    if(seq !== fetchSeq) return;
    renderPrices(data);
    addRecent();
    saveSettings();
  }catch(e){
    if(seq === fetchSeq) showError("No pude obtener los precios. Revisa tu conexión o intenta de nuevo.");
  }finally{
    if(seq === fetchSeq){
      $("searchPrices").disabled = false;
      $("searchPrices").textContent = "Ver precios";
    }
  }
}

function normalizePrices(data){
  return CITIES.map(city=>{
    const rows = data.filter(r=>r.city===city);
    if(!rows.length) return {city,sell:0,buy:0,sellDate:null,buyDate:null};
    const row = rows[0];
    return {
      city,
      sell:Number(row.sell_price_min||0),
      buy:Number(row.buy_price_max||0),
      sellDate:row.sell_price_min_date,
      buyDate:row.buy_price_max_date
    };
  });
}
function sortPrices(arr){
  const mode = $("sort").value;
  const copy = [...arr];
  if(mode==="sellAsc") return copy.sort((a,b)=>(a.sell||Infinity)-(b.sell||Infinity));
  if(mode==="buyDesc") return copy.sort((a,b)=>b.buy-a.buy);
  if(mode==="fresh") return copy.sort((a,b)=>{
    const aa=Math.min(ageInfo(a.sellDate).hours,ageInfo(a.buyDate).hours);
    const bb=Math.min(ageInfo(b.sellDate).hours,ageInfo(b.buyDate).hours);
    return aa-bb;
  });
  return copy;
}
function bestRoute(arr){
  let best = null;
  for(const from of arr){
    if(!from.sell) continue;
    for(const to of arr){
      if(from.city===to.city || !to.buy) continue;
      const gross = to.buy-from.sell;
      const margin = gross/from.sell*100;
      if(!best || margin>best.margin) best={from,to,gross,margin};
    }
  }
  return best;
}
function updateRouteProfit(){
  if(!lastRoute) return;
  const qty = Math.max(1,Number($("quantity").value)||1);
  const fee = Math.max(0,Number($("marketFee").value)||0)/100;
  const revenue = lastRoute.to.buy*(1-fee);
  const profitEach = revenue-lastRoute.from.sell;
  const total = profitEach*qty;
  $("routeProfit").textContent = `${total>=0?"+":""}${money(total)} 🪙`;
  $("routeProfit").classList.toggle("negative",total<0);
  const netMargin = lastRoute.from.sell ? profitEach/lastRoute.from.sell*100 : 0;
  $("routeBadge").textContent = `Neto ${netMargin>=0?"+":""}${pct(netMargin)}`;
  $("routeBadge").className = `badge ${netMargin>=0?"good":"bad"}`;
  saveSettings();
}
function renderPrices(data){
  lastPrices = normalizePrices(data);
  const buys = lastPrices.filter(x=>x.sell>0).sort((a,b)=>a.sell-b.sell);
  const sells = lastPrices.filter(x=>x.buy>0).sort((a,b)=>b.buy-a.buy);
  const bestBuy = buys[0];
  const bestSell = sells[0];

  $("bestBuyPrice").textContent = bestBuy ? `${money(bestBuy.sell)} 🪙` : "Sin datos";
  $("bestBuyCity").textContent = bestBuy?.city || "—";
  $("bestSellPrice").textContent = bestSell ? `${money(bestSell.buy)} 🪙` : "Sin datos";
  $("bestSellCity").textContent = bestSell?.city || "—";
  $("summary").classList.remove("hidden");

  lastRoute = bestRoute(lastPrices);
  if(lastRoute){
    $("routeText").innerHTML = `<strong>${esc(lastRoute.from.city)}</strong> → <strong>${esc(lastRoute.to.city)}</strong><br>
      Comprar a ${money(lastRoute.from.sell)} 🪙 · vender instantáneo a ${money(lastRoute.to.buy)} 🪙`;
    $("routeSection").classList.remove("hidden");
    updateRouteProfit();
  }else{
    $("routeSection").classList.add("hidden");
  }

  const sorted = sortPrices(lastPrices);
  $("results").innerHTML = sorted.map(x=>{
    const sellAge=ageInfo(x.sellDate), buyAge=ageInfo(x.buyDate);
    const latest=sellAge.hours<=buyAge.hours?sellAge:buyAge;
    const markers=[];
    if(bestBuy && x.city===bestBuy.city) markers.push(`<span class="marker">comprar</span>`);
    if(bestSell && x.city===bestSell.city) markers.push(`<span class="marker">vender</span>`);
    return `<article class="city-card ${bestBuy&&x.city===bestBuy.city?"best-buy":""} ${bestSell&&x.city===bestSell.city?"best-sell":""}">
      <div class="city-head">
        <div class="city-name"><strong>${esc(x.city)}</strong>${markers.join("")}</div>
        <span class="fresh ${latest.cls}">${latest.label}</span>
      </div>
      <div class="price-grid">
        <div class="price-box">
          <span>Venta más barata</span>
          <strong>${x.sell?money(x.sell)+" 🪙":"—"}</strong>
          <small class="fresh ${sellAge.cls}">${sellAge.label}</small>
        </div>
        <div class="price-box">
          <span>Compra más alta</span>
          <strong>${x.buy?money(x.buy)+" 🪙":"—"}</strong>
          <small class="fresh ${buyAge.cls}">${buyAge.label}</small>
        </div>
      </div>
    </article>`;
  }).join("");

  $("updatedAt").textContent = `Consulta realizada: ${new Date().toLocaleString("es-UY")}`;
  $("resultsSection").classList.remove("hidden");

  $("historyCity").innerHTML = CITIES.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("historyCity").value = bestBuy?.city || "Caerleon";
  $("historySection").classList.remove("hidden");
}

function dateISO(d){
  return d.toISOString().slice(0,10);
}
async function fetchHistory(){
  if(!selected) return;
  const btn=$("historyBtn");
  btn.disabled=true; btn.textContent="Cargando…";
  $("chartEmpty").textContent="Cargando historial…";
  $("chartEmpty").classList.remove("hidden");

  const days=Number($("historyDays").value);
  const end=new Date();
  const start=new Date(Date.now()-days*86400000);
  const host=API_HOSTS[$("server").value];
  const id=currentItemId();
  const city=$("historyCity").value;
  const q=$("quality").value;
  const url=`${host}/api/v2/stats/history/${encodeURIComponent(id)}.json?date=${dateISO(start)}&end_date=${dateISO(end)}&locations=${encodeURIComponent(city)}&qualities=${q}&time-scale=24`;

  try{
    const res=await fetch(url,{cache:"no-store"});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw=await res.json();
    const series=extractHistorySeries(raw,city);
    if(!series.length) throw new Error("Sin datos");
    drawChart(series);
    renderHistoryStats(series);
    $("chartEmpty").classList.add("hidden");
  }catch(e){
    clearChart();
    $("historyStats").classList.add("hidden");
    $("chartEmpty").textContent="No hay historial suficiente para esta combinación de objeto, ciudad y calidad.";
  }finally{
    btn.disabled=false; btn.textContent="Cargar";
  }
}
function extractHistorySeries(raw,city){
  const groups=Array.isArray(raw)?raw:[];
  let group=groups.find(x=>(x.location||x.city)===city) || groups[0];
  let data=group?.data || [];
  if(!Array.isArray(data)) data=[];
  return data.map(x=>({
    date:new Date(x.timestamp),
    price:Number(x.avg_price||x.average_price||0),
    count:Number(x.item_count||x.volume||0)
  })).filter(x=>x.price>0 && !Number.isNaN(x.date.getTime())).sort((a,b)=>a.date-b.date);
}
function renderHistoryStats(series){
  const prices=series.map(x=>x.price);
  const avg=prices.reduce((a,b)=>a+b,0)/prices.length;
  const min=Math.min(...prices), max=Math.max(...prices);
  $("historyStats").innerHTML=`
    <div class="stat"><span>Promedio</span><strong>${money(avg)} 🪙</strong></div>
    <div class="stat"><span>Mínimo</span><strong>${money(min)} 🪙</strong></div>
    <div class="stat"><span>Máximo</span><strong>${money(max)} 🪙</strong></div>`;
  $("historyStats").classList.remove("hidden");
}
function clearChart(){
  const c=$("historyChart"), ctx=c.getContext("2d");
  ctx.clearRect(0,0,c.width,c.height);
}
function drawChart(series){
  const c=$("historyChart"), ctx=c.getContext("2d");
  const dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  const rect=c.getBoundingClientRect();
  c.width=Math.max(500,Math.round(rect.width*dpr));
  c.height=Math.round(240*dpr);
  ctx.clearRect(0,0,c.width,c.height);

  const pad={l:54*dpr,r:14*dpr,t:18*dpr,b:34*dpr};
  const W=c.width-pad.l-pad.r, H=c.height-pad.t-pad.b;
  const vals=series.map(x=>x.price);
  let min=Math.min(...vals), max=Math.max(...vals);
  if(min===max){ min*=.95; max*=1.05; }
  const span=Math.max(1,max-min);
  min-=span*.08; max+=span*.08;

  const x=i=>pad.l+(series.length===1?W/2:(i/(series.length-1))*W);
  const y=v=>pad.t+(max-v)/(max-min)*H;

  ctx.lineWidth=1*dpr;
  ctx.strokeStyle="rgba(169,157,139,.18)";
  ctx.fillStyle="#a99d8b";
  ctx.font=`${10*dpr}px system-ui`;

  for(let i=0;i<=4;i++){
    const yy=pad.t+(i/4)*H;
    ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(c.width-pad.r,yy);ctx.stroke();
    const val=max-(i/4)*(max-min);
    ctx.fillText(money(val),4*dpr,yy+3*dpr);
  }

  ctx.strokeStyle="#d7a64b";
  ctx.lineWidth=2.2*dpr;
  ctx.beginPath();
  series.forEach((p,i)=>{
    const xx=x(i), yy=y(p.price);
    if(i===0) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
  });
  ctx.stroke();

  ctx.fillStyle="#f0c66b";
  const last=series[series.length-1];
  ctx.beginPath();ctx.arc(x(series.length-1),y(last.price),4*dpr,0,Math.PI*2);ctx.fill();

  ctx.fillStyle="#a99d8b";
  const labels=Math.min(4,series.length);
  for(let j=0;j<labels;j++){
    const i=Math.round(j*(series.length-1)/Math.max(1,labels-1));
    const label=series[i].date.toLocaleDateString("es-UY",{day:"2-digit",month:"2-digit"});
    ctx.fillText(label,Math.min(c.width-pad.r-34*dpr,Math.max(pad.l-8*dpr,x(i)-14*dpr)),c.height-10*dpr);
  }
}

$("search").addEventListener("input",e=>{
  selected=null;
  $("selectedItem").classList.add("hidden");
  $("searchPrices").disabled=true;
  clearTimeout(debounceTimer);
  debounceTimer=setTimeout(()=>renderSuggestions(e.target.value),130);
});
$("quality").addEventListener("change",()=>{
  saveSettings();
  if(selected){
    $("itemImg").src=imageUrl(currentItemId(),Number($("quality").value),128);
    refreshFavoriteButton();
  }
});
$("enchantment").addEventListener("change",()=>{
  saveSettings();
  if(selected){
    $("itemId").textContent=currentItemId();
    $("itemImg").src=imageUrl(currentItemId(),Number($("quality").value),128);
    refreshFavoriteButton();
  }
});
$("server").addEventListener("change",saveSettings);
$("sort").addEventListener("change",()=>{ saveSettings(); if(lastPrices.length) renderPrices(lastPrices.map(x=>({
  city:x.city,sell_price_min:x.sell,buy_price_max:x.buy,sell_price_min_date:x.sellDate,buy_price_max_date:x.buyDate
}))); });
$("quantity").addEventListener("input",updateRouteProfit);
$("marketFee").addEventListener("input",updateRouteProfit);
$("searchPrices").addEventListener("click",fetchPrices);
$("refreshBtn").addEventListener("click",fetchPrices);
$("historyBtn").addEventListener("click",fetchHistory);
$("favoriteBtn").addEventListener("click",toggleFavorite);
$("clearFavorites").addEventListener("click",()=>{localStorage.removeItem(STORE.favorites);renderQuickLists();refreshFavoriteButton();});
$("clearRecent").addEventListener("click",()=>{localStorage.removeItem(STORE.recent);renderQuickLists();});

$("shareBtn").addEventListener("click",async()=>{
  const text=selected?`${selected.name} ${currentItemId()} — Albion Market Pocket`:"Albion Market Pocket";
  try{
    if(navigator.share) await navigator.share({title:"Albion Market Pocket",text,url:location.href});
    else{
      await navigator.clipboard.writeText(location.href);
      $("shareBtn").textContent="✓";
      setTimeout(()=>$("shareBtn").textContent="↗",1200);
    }
  }catch(_){}
});

document.addEventListener("click",e=>{
  if(!e.target.closest(".search-field")) $("suggestions").classList.add("hidden");
});

window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();installPrompt=e;$("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click",async()=>{
  if(!installPrompt)return;
  installPrompt.prompt();await installPrompt.userChoice;
  installPrompt=null;$("installBtn").classList.add("hidden");
});

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
}

loadSettings();
renderQuickLists();
loadItems();
