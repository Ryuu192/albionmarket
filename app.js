const $ = id => document.getElementById(id);

const API_HOSTS = {
  west: "https://west.albion-online-data.com",
  europe: "https://europe.albion-online-data.com",
  east: "https://east.albion-online-data.com"
};
const ITEMS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json";
const CITIES = ["Caerleon","Bridgewatch","Fort Sterling","Lymhurst","Martlock","Thetford","Brecilien","Black Market"];
const TRANSPORT_ORIGINS = CITIES.filter(city=>city!=="Black Market");
const SERVER_NAMES = {west:"Américas",europe:"Europa",east:"Asia"};
const QUALITY_NAMES = {1:"Normal",2:"Bueno",3:"Notable",4:"Sobresaliente",5:"Obra maestra"};
const STORE = {
  settings: "amp-settings-v2",
  favorites: "amp-favorites-v2",
  recent: "amp-recent-v2",
  transport: "amp-transport-v1",
  transportConfig: "amp-transport-config-v2"
};

let items = [];
let selected = null;
let lastPrices = [];
let installPrompt = null;
let debounceTimer = null;
let transportInputTimer = null;
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
function compactItemCatalog(list){
  const unique = new Map();
  for(const obj of list){
    const item = normalizeItem(obj);
    if(!item) continue;
    const id = baseId(item.id);
    if(id.includes("_UNTRADEABLE")) continue;

    const score = (item.id === id ? 2 : 0) + (item.name !== "Objeto" ? 1 : 0);
    const previous = unique.get(id);
    if(!previous || score > previous.score){
      unique.set(id, {id, name:item.name, score});
    }
  }
  return [...unique.values()].map(({id,name})=>({id,name}));
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
    marketFee:$("plannerFee").value
  });
}
function loadSettings(){
  const s = getStore(STORE.settings, {});
  for(const id of ["server","sort","enchantment","quality","quantity"]){
    if(s[id] != null && $(id)) $(id).value = s[id];
  }
  if(s.marketFee != null) $("plannerFee").value = s.marketFee;
}
function viewFromHash(){
  return location.hash.toLowerCase()==="#transport"?"transport":"market";
}
function renderView(view=viewFromHash()){
  const active=view==="transport"?"transport":"market";
  document.querySelectorAll("[data-screen]").forEach(section=>{
    section.classList.toggle("view-hidden",section.dataset.screen!==active);
  });
  document.querySelectorAll("[data-view-target]").forEach(button=>{
    const on=button.dataset.viewTarget===active;
    button.classList.toggle("active",on);
    if(on) button.setAttribute("aria-current","page");
    else button.removeAttribute("aria-current");
  });
  if(active==="transport") renderTransportPlanner();
  window.scrollTo({top:0,behavior:"auto"});
}
function navigateToView(view,focusSearch=false){
  const target=view==="transport"?"transport":"market";
  const hash=`#${target}`;
  if(location.hash===hash) renderView(target);
  else location.hash=hash;
  if(focusSearch) setTimeout(()=>$("search").focus(),0);
}

async function loadItems(){
  try{
    const cacheKey = "albion-items-lite-v2-deduped-v1";
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
    items = compactItemCatalog(list);
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

function resetPriceView(){
  fetchSeq++;
  lastPrices = [];
  for(const id of ["summary","routeSection","resultsSection","historySection"]){
    $(id).classList.add("hidden");
  }
  $("addToTransport").disabled = true;
  $("historyStats").classList.add("hidden");
  $("chartEmpty").classList.remove("hidden");
  clearChart();
  $("searchPrices").disabled = !selected;
}

function selectItem(item){
  selected = {id:baseId(item.id),name:item.name};
  resetPriceView();
  $("search").value = item.name;
  $("itemName").textContent = item.name;
  $("itemId").textContent = currentItemId();
  $("itemImg").src = imageUrl(currentItemId(),Number($("quality").value),128);
  $("selectedItem").classList.remove("hidden");
  $("searchPrices").disabled = false;
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
function currentFee(){
  return Math.min(100,Math.max(0,Number($("plannerFee").value)||0));
}
function updateChestAddPreview(){
  const quantity=Math.max(1,Math.floor(Number($("quantity").value)||1));
  const citiesWithData=lastPrices.filter(row=>row.buy||row.sell).length;
  $("addToTransport").disabled=!selected||!citiesWithData;
  if(selected&&lastPrices.length){
    $("routeText").textContent=`${quantity} unidad${quantity===1?"":"es"} · precios disponibles en ${citiesWithData} mercado${citiesWithData===1?"":"s"}.`;
  }
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

  $("routeSection").classList.remove("hidden");
  updateChestAddPreview();

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

function getTransportItems(){
  const stored=getStore(STORE.transport,[]);
  if(!Array.isArray(stored)) return [];
  const merged=new Map();
  for(const item of stored.filter(x=>x&&x.uid&&x.id&&Array.isArray(x.prices))){
    const key=`${item.server}|${item.id}|${Number(item.quality)||1}`;
    const previous=merged.get(key);
    if(!previous){
      merged.set(key,{...item,quantity:Math.max(1,Math.floor(Number(item.quantity)||1))});
    }else{
      previous.quantity+=Math.max(1,Math.floor(Number(item.quantity)||1));
      if(Number(item.updatedAt||0)>Number(previous.updatedAt||0)){
        previous.prices=item.prices;
        previous.updatedAt=item.updatedAt;
      }
    }
  }
  return [...merged.values()];
}
function saveTransportItems(list){
  setStore(STORE.transport,list.slice(0,80));
}
function getActiveTransportItems(){
  const server=$("server").value;
  return getTransportItems().filter(item=>item.server===server);
}
function saveActiveTransportItems(activeList){
  const server=$("server").value;
  const otherServers=getTransportItems().filter(item=>item.server!==server);
  saveTransportItems([...activeList,...otherServers]);
}
function getTransportConfig(list=[]){
  const stored=getStore(STORE.transportConfig,{});
  const legacyOrigin=list.find(item=>TRANSPORT_ORIGINS.includes(item.from))?.from;
  return {
    origin:TRANSPORT_ORIGINS.includes(stored.origin)?stored.origin:(legacyOrigin||"Caerleon"),
    saleMode:stored.saleMode==="listing"?"listing":"instant"
  };
}
function saveTransportConfig(config){
  setStore(STORE.transportConfig,config);
}
function transportCityLabel(city){
  return city==="Black Market"?"Black Market (Caerleon)":city;
}
function transportQuote(item,city,saleMode,feePct){
  const quantity=Math.max(1,Math.floor(Number(item.quantity)||1));
  const row=item.prices.find(price=>price.city===city);
  const unitGross=Number(saleMode==="listing"?row?.sell:row?.buy)||0;
  const date=saleMode==="listing"?row?.sellDate:row?.buyDate;
  const unitNet=unitGross*(1-feePct/100);
  return {city,quantity,unitGross,unitNet,net:unitNet*quantity,date};
}
function evaluateTransport(list,config){
  const calculations=list.map(item=>({
    item,
    quantity:Math.max(1,Math.floor(Number(item.quantity)||1)),
    quotes:CITIES.map(city=>transportQuote(item,city,config.saleMode,currentFee()))
  }));
  const destinations=CITIES.map(city=>{
    const available=calculations.map(calc=>calc.quotes.find(quote=>quote.city===city)).filter(quote=>quote.unitGross>0);
    return {
      city,
      coverage:available.length,
      net:available.reduce((sum,quote)=>sum+quote.net,0),
      worstHours:available.reduce((hours,quote)=>Math.max(hours,ageInfo(quote.date).hours),0)
    };
  }).filter(destination=>destination.coverage>0).sort((a,b)=>b.coverage-a.coverage||b.net-a.net);
  const best=destinations[0]||null;
  const origin=destinations.find(destination=>destination.city===config.origin)||null;
  for(const calc of calculations){
    calc.recommended=best?calc.quotes.find(quote=>quote.city===best.city):null;
    calc.bestIndividual=calc.quotes.filter(quote=>quote.unitGross>0).sort((a,b)=>b.net-a.net)[0]||null;
  }
  return {calculations,destinations,best,origin};
}
function comparableDifference(destination,origin,totalItems){
  if(!origin||destination.coverage!==totalItems||origin.coverage!==totalItems) return null;
  return destination.net-origin.net;
}
function renderTransportPlanner(){
  const list=getActiveTransportItems();
  const section=$("transportPlanner");
  section.classList.remove("hidden");
  $("transportNavCount").textContent=list.length;
  $("transportNavCount").classList.toggle("hidden",!list.length);
  $("refreshTransportBtn").disabled=!list.length;
  $("clearTransportBtn").disabled=!list.length;

  const config=getTransportConfig(list);
  $("transportOrigin").innerHTML=TRANSPORT_ORIGINS.map(city=>`<option value="${esc(city)}">${esc(city)}</option>`).join("");
  $("transportOrigin").value=config.origin;
  $("transportSaleMode").value=config.saleMode;
  $("transportRoutesTitle").classList.toggle("hidden",!list.length);
  $("transportItemsTitle").classList.toggle("hidden",!list.length);

  if(!list.length){
    $("transportRecommendation").className="transport-recommendation empty";
    $("transportRecommendation").innerHTML=`<strong>Tu cofre está vacío</strong><small>Entra en Mercado, consulta un objeto y pulsa “Añadir este objeto al cofre”.</small>`;
    $("transportStatus").textContent="";
    $("transportSummary").innerHTML="";
    $("transportRoutes").innerHTML=`<div class="transport-empty">Cuando añadas objetos, aquí compararemos todas las ciudades.</div>`;
    $("transportItems").innerHTML="";
    return;
  }

  const {calculations,destinations,best,origin}=evaluateTransport(list,config);
  const totalUnits=calculations.reduce((sum,calc)=>sum+calc.quantity,0);
  const difference=best?comparableDifference(best,origin,list.length):null;
  const modeText=config.saleMode==="listing"?"publicando órdenes de venta":"vendiendo instantáneamente";

  if(best&&best.city===config.origin&&best.coverage===list.length){
    $("transportRecommendation").className="transport-recommendation good";
    $("transportRecommendation").innerHTML=`<strong>Conviene vender en ${esc(config.origin)} sin transportar</strong>
      <small>Es el mayor valor total para toda la carga ${esc(modeText)}: ${money(best.net)} 🪙 netas.</small>`;
  }else if(best){
    const complete=best.coverage===list.length;
    $("transportRecommendation").className=`transport-recommendation ${complete?"good":"bad"}`;
    $("transportRecommendation").innerHTML=`<strong>Destino recomendado: ${esc(transportCityLabel(best.city))}</strong>
      <small>Desde ${esc(config.origin)} · ${money(best.net)} 🪙 netas${difference==null?"":` · ${difference>=0?"+":""}${money(difference)} 🪙 frente a vender en el origen`}${complete?"":` · solo hay precios para ${best.coverage} de ${list.length} objetos`}.</small>`;
  }else{
    $("transportRecommendation").className="transport-recommendation bad";
    $("transportRecommendation").innerHTML=`<strong>Faltan precios para calcular el destino</strong><small>Actualiza los precios de la carga e inténtalo de nuevo.</small>`;
  }

  $("transportSummary").innerHTML=`
    <div class="stat"><span>Objetos / unidades</span><strong>${list.length} / ${money(totalUnits)}</strong></div>
    <div class="stat"><span>Valor recomendado</span><strong>${best?money(best.net)+" 🪙":"—"}</strong></div>
    <div class="stat"><span>Mejora vs origen</span><strong class="${difference==null?"":difference>=0?"good":"bad"}">${difference==null?"—":`${difference>=0?"+":""}${money(difference)} 🪙`}</strong></div>`;

  $("transportRoutes").innerHTML=destinations.length?destinations.map(destination=>{
    const isBest=best&&destination.city===best.city;
    const isOrigin=destination.city===config.origin;
    const age=Number.isFinite(destination.worstHours)?ageInfo(new Date(Date.now()-destination.worstHours*36e5).toISOString()):{label:"Sin datos",cls:"very-stale"};
    const cityDifference=comparableDifference(destination,origin,list.length);
    const routeLabel=isOrigin?`Vender en ${config.origin}`:`${config.origin} → ${transportCityLabel(destination.city)}`;
    return `<article class="transport-route-card ${isBest?"recommended":""} ${isOrigin?"origin":""}">
      <div class="transport-route-head">
        <strong>${esc(routeLabel)}</strong>
        ${isBest?`<span class="marker">mejor total</span>`:isOrigin?`<span class="marker">origen</span>`:`<small>${destination.coverage}/${list.length} objetos</small>`}
      </div>
      <div class="transport-route-metrics">
        <div class="transport-metric"><span>Valor neto</span><strong>${money(destination.net)} 🪙</strong></div>
        <div class="transport-metric"><span>Diferencia vs origen</span><strong class="${cityDifference==null?"":cityDifference>=0?"good":"bad"}">${cityDifference==null?"—":`${cityDifference>=0?"+":""}${money(cityDifference)} 🪙`}</strong></div>
        <div class="transport-metric"><span>Cobertura</span><strong>${destination.coverage}/${list.length} objetos</strong><small class="fresh ${age.cls}">${age.label}</small></div>
      </div>
    </article>`;
  }).join(""):`<div class="transport-empty">No hay ciudades con precios disponibles.</div>`;

  $("transportItems").innerHTML=calculations.map(calc=>{
    const item=calc.item;
    const recommended=calc.recommended?.unitGross?calc.recommended:null;
    const individual=calc.bestIndividual;
    const recommendedAge=recommended?ageInfo(recommended.date):{label:"Sin datos",cls:"very-stale"};
    const individualAge=individual?ageInfo(individual.date):{label:"Sin datos",cls:"very-stale"};
    return `<article class="transport-item" data-transport-id="${esc(item.uid)}">
      <div class="transport-item-head">
        <img src="${imageUrl(item.id,Number(item.quality),96)}" alt="" loading="lazy">
        <div class="transport-item-copy">
          <strong>${esc(item.name)}</strong>
          <small>${esc(item.id)} · ${esc(QUALITY_NAMES[item.quality]||`Calidad ${item.quality}`)} · cofre en ${esc(config.origin)}</small>
        </div>
        <button class="remove-item" data-action="remove" title="Quitar del cofre" aria-label="Quitar ${esc(item.name)}">×</button>
      </div>
      <div class="transport-item-grid chest-item-grid">
        <div class="field">
          <label for="qty-${esc(item.uid)}">Cantidad en el cofre</label>
          <input id="qty-${esc(item.uid)}" data-field="quantity" type="number" min="1" step="1" inputmode="numeric" value="${calc.quantity}">
        </div>
      </div>
      <div class="transport-item-metrics">
        <div class="transport-metric"><span>En ${esc(best?transportCityLabel(best.city):"destino")}</span><strong>${recommended?money(recommended.unitNet)+" 🪙/u":"—"}</strong><small class="fresh ${recommendedAge.cls}">${recommendedAge.label}</small></div>
        <div class="transport-metric"><span>Valor de estas unidades</span><strong>${recommended?money(recommended.net)+" 🪙":"—"}</strong><small>${recommended?money(calc.quantity)+" unidades":"Sin precio"}</small></div>
        <div class="transport-metric"><span>Mejor destino individual</span><strong>${individual?esc(transportCityLabel(individual.city)):"—"}</strong><small class="fresh ${individualAge.cls}">${individual?money(individual.unitNet)+" 🪙/u · "+individualAge.label:"Sin datos"}</small></div>
      </div>
    </article>`;
  }).join("");
}
function addCurrentToTransport(){
  if(!selected||!lastPrices.length) return;
  const list=getActiveTransportItems();
  const id=currentItemId();
  const quality=Number($("quality").value);
  const quantity=Math.max(1,Math.floor(Number($("quantity").value)||1));
  const server=$("server").value;
  const existing=list.find(x=>x.server===server&&x.id===id&&Number(x.quality)===quality);
  if(existing){
    existing.quantity=Math.max(1,Number(existing.quantity)||1)+quantity;
    existing.prices=lastPrices;
    existing.updatedAt=Date.now();
  }else{
    list.unshift({
      uid:`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
      server,id,name:selected.name,quality,quantity,
      prices:lastPrices,updatedAt:Date.now()
    });
  }
  saveActiveTransportItems(list);
  renderTransportPlanner();
  $("transportStatus").textContent=`${selected.name} añadido al cofre.`;
  navigateToView("transport");
}
function chunked(list,size){
  const chunks=[];
  for(let i=0;i<list.length;i+=size) chunks.push(list.slice(i,i+size));
  return chunks;
}
async function refreshTransportPrices(){
  const list=getActiveTransportItems();
  if(!list.length) return;
  const btn=$("refreshTransportBtn");
  btn.disabled=true;
  btn.textContent="Actualizando…";
  const groups=new Map();
  for(const item of list){
    const key=`${item.server}|${item.quality}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(item);
  }
  const totalBatches=[...groups.values()].reduce((sum,group)=>sum+Math.ceil(new Set(group.map(x=>x.id)).size/20),0);
  let completed=0,failed=0;
  try{
    for(const group of groups.values()){
      const server=group[0].server;
      const quality=Number(group[0].quality);
      const ids=[...new Set(group.map(x=>x.id))];
      for(const idChunk of chunked(ids,20)){
        $("transportStatus").textContent=`Actualizando lote ${completed+1} de ${totalBatches}…`;
        try{
          const path=idChunk.map(encodeURIComponent).join(",");
          const url=`${API_HOSTS[server]}/api/v2/stats/prices/${path}.json?locations=${encodeURIComponent(CITIES.join(","))}&qualities=${quality}`;
          const res=await fetch(url,{cache:"no-store"});
          if(!res.ok) throw new Error(`HTTP ${res.status}`);
          const data=await res.json();
          for(const item of group.filter(x=>idChunk.includes(x.id))){
            const rows=data.filter(row=>String(row.item_id||"").toUpperCase()===item.id.toUpperCase()&&Number(row.quality)===quality);
            item.prices=normalizePrices(rows);
            item.updatedAt=Date.now();
          }
        }catch(_){ failed++; }
        completed++;
      }
    }
    saveActiveTransportItems(list);
    renderTransportPlanner();
    $("transportStatus").textContent=failed?`Precios actualizados con ${failed} lote${failed===1?"":"s"} que no respondió.`:`Precios de toda la carga actualizados.`;
  }finally{
    btn.disabled=false;
    btn.textContent="Actualizar precios";
  }
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
  resetPriceView();
  $("selectedItem").classList.add("hidden");
  $("searchPrices").disabled=true;
  clearTimeout(debounceTimer);
  debounceTimer=setTimeout(()=>renderSuggestions(e.target.value),130);
});
document.querySelectorAll("[data-view-target]").forEach(button=>{
  button.addEventListener("click",()=>navigateToView(button.dataset.viewTarget));
});
window.addEventListener("hashchange",()=>renderView());
$("addTransportItemBtn").addEventListener("click",()=>navigateToView("market",true));
$("quality").addEventListener("change",()=>{
  saveSettings();
  if(selected){
    $("itemImg").src=imageUrl(currentItemId(),Number($("quality").value),128);
    refreshFavoriteButton();
    resetPriceView();
  }
});
$("enchantment").addEventListener("change",()=>{
  saveSettings();
  if(selected){
    $("itemId").textContent=currentItemId();
    $("itemImg").src=imageUrl(currentItemId(),Number($("quality").value),128);
    refreshFavoriteButton();
    resetPriceView();
  }
});
$("server").addEventListener("change",()=>{ saveSettings(); if(selected) resetPriceView(); renderTransportPlanner(); });
$("sort").addEventListener("change",()=>{ saveSettings(); if(lastPrices.length) renderPrices(lastPrices.map(x=>({
  city:x.city,sell_price_min:x.sell,buy_price_max:x.buy,sell_price_min_date:x.sellDate,buy_price_max_date:x.buyDate
}))); });
$("quantity").addEventListener("input",updateChestAddPreview);
$("plannerFee").addEventListener("input",()=>{
  saveSettings();
  renderTransportPlanner();
});
$("transportOrigin").addEventListener("change",()=>{
  const config=getTransportConfig(getActiveTransportItems());
  config.origin=$("transportOrigin").value;
  saveTransportConfig(config);
  renderTransportPlanner();
  $("transportStatus").textContent=`Cofre ubicado en ${config.origin}.`;
});
$("transportSaleMode").addEventListener("change",()=>{
  const config=getTransportConfig(getActiveTransportItems());
  config.saleMode=$("transportSaleMode").value;
  saveTransportConfig(config);
  renderTransportPlanner();
  $("transportStatus").textContent=config.saleMode==="listing"?"Comparando órdenes de venta publicadas.":"Comparando ventas instantáneas.";
});
$("searchPrices").addEventListener("click",fetchPrices);
$("refreshBtn").addEventListener("click",fetchPrices);
$("historyBtn").addEventListener("click",fetchHistory);
$("favoriteBtn").addEventListener("click",toggleFavorite);
$("addToTransport").addEventListener("click",addCurrentToTransport);
$("refreshTransportBtn").addEventListener("click",refreshTransportPrices);
$("clearTransportBtn").addEventListener("click",()=>{
  if(!confirm("¿Vaciar todos los objetos del cofre?")) return;
  saveActiveTransportItems([]);
  renderTransportPlanner();
});
$("transportItems").addEventListener("change",e=>{
  const card=e.target.closest("[data-transport-id]");
  const field=e.target.dataset.field;
  if(!card||!field) return;
  const list=getActiveTransportItems();
  const item=list.find(x=>x.uid===card.dataset.transportId);
  if(!item) return;
  if(field==="quantity"){
    clearTimeout(transportInputTimer);
    item.quantity=Math.max(1,Math.floor(Number(e.target.value)||1));
  }
  saveActiveTransportItems(list);
  renderTransportPlanner();
  $("transportStatus").textContent="Cofre actualizado.";
});
$("transportItems").addEventListener("input",e=>{
  if(e.target.dataset.field!=="quantity") return;
  const card=e.target.closest("[data-transport-id]");
  if(!card) return;
  const value=e.target.value;
  clearTimeout(transportInputTimer);
  transportInputTimer=setTimeout(()=>{
    const list=getActiveTransportItems();
    const item=list.find(x=>x.uid===card.dataset.transportId);
    if(!item) return;
    item.quantity=Math.max(1,Math.floor(Number(value)||1));
    saveActiveTransportItems(list);
    renderTransportPlanner();
    $("transportStatus").textContent="Cantidad actualizada.";
  },250);
});
$("transportItems").addEventListener("click",e=>{
  const remove=e.target.closest('[data-action="remove"]');
  if(!remove) return;
  const card=remove.closest("[data-transport-id]");
  const list=getActiveTransportItems().filter(x=>x.uid!==card.dataset.transportId);
  saveActiveTransportItems(list);
  renderTransportPlanner();
  if(list.length) $("transportStatus").textContent="Objeto quitado del cofre.";
});
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
renderTransportPlanner();
renderView();
loadItems();
