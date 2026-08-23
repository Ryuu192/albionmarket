const $ = (id) => document.getElementById(id);

const API_HOSTS = {
  west: "https://west.albion-online-data.com",
  europe: "https://europe.albion-online-data.com",
  east: "https://east.albion-online-data.com"
};

const ITEMS_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json";
const CITIES = ["Caerleon","Bridgewatch","Fort Sterling","Lymhurst","Martlock","Thetford","Brecilien","Black Market"];

let items = [];
let selected = null;
let installPrompt = null;
let debounceTimer = null;

function esc(s=""){
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function money(n){
  return Number(n || 0).toLocaleString("es-UY");
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
  if(!dateStr || dateStr.startsWith("0001-")) return {label:"Sin datos", cls:"very-stale", hours:Infinity};
  const d = new Date(dateStr.endsWith("Z") ? dateStr : dateStr + "Z");
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

async function loadItems(){
  try{
    const cacheKey = "albion-items-lite-v1";
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
    items = list.map(normalizeItem).filter(Boolean)
      .filter(x => !x.id.includes("_UNTRADEABLE"));
    try{
      // Guardamos una versión reducida; si excede el límite, simplemente no se cachea.
      sessionStorage.setItem(cacheKey, JSON.stringify(items));
    }catch(_){}
    $("searchStatus").textContent = `${items.length.toLocaleString("es-UY")} objetos listos.`;
  }catch(e){
    $("searchStatus").textContent = "No pude cargar nombres. Puedes pegar un ID como T6_ORE.";
  }
}

function renderSuggestions(query){
  const box = $("suggestions");
  const q = query.trim().toLocaleLowerCase("es");
  if(q.length < 2){
    box.classList.add("hidden");
    return;
  }

  let matches = items
    .filter(x => x.name.toLocaleLowerCase("es").includes(q) || x.id.toLowerCase().includes(q))
    .slice(0, 18);

  // Si el catálogo no cargó, permite usar directamente un ID.
  if(!matches.length && /^[A-Z0-9_@]+$/i.test(query.trim())){
    matches = [{id:query.trim().toUpperCase(), name:"Usar ID ingresado"}];
  }

  if(!matches.length){
    box.innerHTML = `<div class="suggestion"><div><strong>Sin resultados</strong><small>Prueba otro nombre o un ID del objeto</small></div></div>`;
    box.classList.remove("hidden");
    return;
  }

  box.innerHTML = matches.map((x,i)=>`
    <div class="suggestion" data-i="${i}">
      <img src="${imageUrl(baseId(x.id),1,64)}" alt="">
      <div>
        <strong>${esc(x.name)}</strong>
        <small>${esc(x.id)}</small>
      </div>
    </div>`).join("");

  [...box.querySelectorAll(".suggestion[data-i]")].forEach(el=>{
    el.addEventListener("click",()=>{
      selectItem(matches[Number(el.dataset.i)]);
      box.classList.add("hidden");
    });
  });
  box.classList.remove("hidden");
}

function selectItem(item){
  selected = item;
  $("search").value = item.name;
  $("itemName").textContent = item.name;
  $("itemId").textContent = baseId(item.id);
  $("itemImg").src = imageUrl(currentItemId() || baseId(item.id), Number($("quality").value), 128);
  $("selectedItem").classList.remove("hidden");
  $("searchPrices").disabled = false;
  showError("");
}

async function fetchPrices(){
  if(!selected) return;
  showError("");
  $("searchPrices").disabled = true;
  $("searchPrices").textContent = "Consultando…";

  const host = API_HOSTS[$("server").value];
  const id = currentItemId();
  const q = $("quality").value;
  $("itemImg").src = imageUrl(id, Number(q), 128);

  const url = `${host}/api/v2/stats/prices/${encodeURIComponent(id)}.json?locations=${encodeURIComponent(CITIES.join(","))}&qualities=${q}`;

  try{
    const res = await fetch(url, {cache:"no-store"});
    if(!res.ok) throw new Error(`Error HTTP ${res.status}`);
    const data = await res.json();
    renderPrices(data);
  }catch(e){
    showError("No pude obtener los precios. Revisa tu conexión o intenta de nuevo.");
  }finally{
    $("searchPrices").disabled = false;
    $("searchPrices").textContent = "Ver precios";
  }
}

function renderPrices(data){
  const byCity = CITIES.map(city=>{
    const rows = data.filter(r=>r.city === city);
    if(!rows.length) return {city, sell:0, buy:0, sellDate:null, buyDate:null};
    const row = rows[0];
    return {
      city,
      sell:Number(row.sell_price_min || 0),
      buy:Number(row.buy_price_max || 0),
      sellDate:row.sell_price_min_date,
      buyDate:row.buy_price_max_date
    };
  });

  const buys = byCity.filter(x=>x.sell>0).sort((a,b)=>a.sell-b.sell);
  const sells = byCity.filter(x=>x.buy>0).sort((a,b)=>b.buy-a.buy);

  $("bestBuyPrice").textContent = buys.length ? `${money(buys[0].sell)} 🪙` : "Sin datos";
  $("bestBuyCity").textContent = buys.length ? buys[0].city : "—";
  $("bestSellPrice").textContent = sells.length ? `${money(sells[0].buy)} 🪙` : "Sin datos";
  $("bestSellCity").textContent = sells.length ? sells[0].city : "—";
  $("summary").classList.remove("hidden");

  $("results").innerHTML = byCity.map(x=>{
    const sellAge = ageInfo(x.sellDate);
    const buyAge = ageInfo(x.buyDate);
    const latest = sellAge.hours <= buyAge.hours ? sellAge : buyAge;
    return `
      <article class="city-card">
        <div class="city-head">
          <strong>${esc(x.city)}</strong>
          <span class="fresh ${latest.cls}">${latest.label}</span>
        </div>
        <div class="price-grid">
          <div class="price-box">
            <span>Venta más barata</span>
            <strong>${x.sell ? money(x.sell)+" 🪙" : "—"}</strong>
          </div>
          <div class="price-box">
            <span>Compra más alta</span>
            <strong>${x.buy ? money(x.buy)+" 🪙" : "—"}</strong>
          </div>
        </div>
      </article>`;
  }).join("");

  $("updatedAt").textContent = `Consulta realizada: ${new Date().toLocaleString("es-UY")}`;
  $("resultsSection").classList.remove("hidden");
}

$("search").addEventListener("input", e=>{
  selected = null;
  $("selectedItem").classList.add("hidden");
  $("searchPrices").disabled = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(()=>renderSuggestions(e.target.value), 140);
});

$("quality").addEventListener("change",()=>{
  if(selected) $("itemImg").src = imageUrl(currentItemId(), Number($("quality").value), 128);
});
$("enchantment").addEventListener("change",()=>{
  if(selected) $("itemImg").src = imageUrl(currentItemId(), Number($("quality").value), 128);
});
$("searchPrices").addEventListener("click", fetchPrices);
$("refreshBtn").addEventListener("click", fetchPrices);

document.addEventListener("click", e=>{
  if(!e.target.closest(".search-field")) $("suggestions").classList.add("hidden");
});

window.addEventListener("beforeinstallprompt", e=>{
  e.preventDefault();
  installPrompt = e;
  $("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click", async()=>{
  if(!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("installBtn").classList.add("hidden");
});

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
}

loadItems();
