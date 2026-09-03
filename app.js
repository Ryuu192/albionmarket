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
  transportConfig: "amp-transport-config-v2",
  captureSession: "amp-capture-session-v1"
};

let items = [];
let selected = null;
let lastPrices = [];
let installPrompt = null;
let debounceTimer = null;
let transportInputTimer = null;
let fetchSeq = 0;
let captureDrafts = [];
let captureObjectUrl = "";
let captureOcrWorker = null;
let captureOcrWorkerPromise = null;
let captureOcrQueue = Promise.resolve();
let captureVisualIndexPromise = null;
let captureDetectionSequence = 0;
let itemLoadPromise = null;

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
    if(id.includes("_UNTRADEABLE")||id.includes("_NONTRADABLE")) continue;

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

function captureUid(){
  return `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
}
function setCaptureStatus(message,busy=false){
  $("captureStatus").textContent=message;
  $("captureStatus").classList.toggle("busy",busy);
}
function openChestImport(){
  navigateToView("transport");
  $("chestImportPanel").classList.remove("hidden");
  $("transportPlanner").classList.add("capture-open-hidden");
  setTimeout(()=>$("chestImportPanel").scrollIntoView({block:"start",behavior:"smooth"}),0);
}
function closeChestImport(){
  $("chestImportPanel").classList.add("hidden");
  $("transportPlanner").classList.remove("capture-open-hidden");
}
function clearCaptureDrafts(){
  captureDetectionSequence++;
  captureDrafts=[];
  renderCaptureDrafts();
  setCaptureStatus("Pulsa Detectar objetos o toca una casilla para añadirla manualmente.");
}
function saveCaptureDraftSession(){
  if(!captureDrafts.length){
    localStorage.removeItem(STORE.captureSession);
    return;
  }
  const drafts=captureDrafts.map(draft=>({
    ...draft,
    x:null,y:null,slotSize:Number(draft.slotSize)||72,matches:[],
    recognition:draft.recognition?.state==="busy"?null:draft.recognition,
    ocrState:draft.ocrState==="busy"?"error":draft.ocrState,
    ocrStatus:draft.ocrState==="busy"?"Lectura interrumpida; revisa la cantidad.":draft.ocrStatus
  }));
  try{setStore(STORE.captureSession,{savedAt:Date.now(),drafts});}catch(_){}
}
function restoreCaptureDraftSession(){
  const session=getStore(STORE.captureSession,null);
  if(!session?.drafts?.length) return;
  captureDrafts=session.drafts.slice(0,120).map(draft=>({
    ...newCaptureDraft(),...draft,uid:captureUid(),x:null,y:null,matches:[]
  }));
  $("captureWorkspace").classList.remove("hidden");
  renderCaptureDrafts();
  const saved=new Date(session.savedAt||Date.now()).toLocaleString("es-UY",{dateStyle:"short",timeStyle:"short"});
  setCaptureStatus(`Sesión recuperada (${saved}). Revisa los datos antes de importar.`);
}
function captureSlotSize(){
  return Math.max(44,Math.min(180,Number($("captureSlotSize").value)||72));
}
function handleCaptureFile(file){
  if(!file) return;
  if(!String(file.type).startsWith("image/")){
    setCaptureStatus("El archivo seleccionado no es una imagen compatible.");
    return;
  }
  if(file.size>40*1024*1024){
    setCaptureStatus("La captura supera 40 MB. Usa una imagen PNG, JPG o WebP más pequeña.");
    return;
  }

  captureDetectionSequence++;
  if(captureObjectUrl) URL.revokeObjectURL(captureObjectUrl);
  captureObjectUrl=URL.createObjectURL(file);
  const img=$("captureImage");
  img.onload=()=>{
    captureDrafts=[];
    $("captureWorkspace").classList.remove("hidden");
    renderCaptureDrafts();
    drawCaptureOverlay();
    setCaptureStatus(`Captura lista (${img.naturalWidth} × ${img.naturalHeight}). Detectando objetos…`,true);
    setTimeout(()=>autoDetectCapture(),40);
  };
  img.onerror=()=>setCaptureStatus("No pude abrir esa captura. Prueba con PNG, JPG o WebP.");
  img.src=captureObjectUrl;
}
function clipboardImage(event){
  const items=[...(event.clipboardData?.items||[])];
  const imageItem=items.find(item=>String(item.type).startsWith("image/"));
  if(imageItem){
    const file=imageItem.getAsFile();
    if(file) return file;
  }
  return [...(event.clipboardData?.files||[])].find(file=>String(file.type).startsWith("image/"))||null;
}
function handleCapturePaste(event){
  const file=clipboardImage(event);
  const pasteZone=$("clipboardPasteZone");
  if(!file){
    if(event.target.closest?.("#clipboardPasteZone")){
      event.preventDefault();
      setCaptureStatus("El portapapeles no contiene una imagen. Copia la captura y vuelve a pulsar Ctrl + V.");
    }
    return;
  }
  event.preventDefault();
  openChestImport();
  pasteZone.classList.add("pasted");
  setTimeout(()=>pasteZone.classList.remove("pasted"),900);
  setCaptureStatus("Captura pegada. Preparando la imagen…",true);
  handleCaptureFile(file);
}
function captureCoordinates(event){
  const stage=$("captureStage");
  const img=$("captureImage");
  const rect=stage.getBoundingClientRect();
  const cssX=event.clientX-rect.left+stage.scrollLeft;
  const cssY=event.clientY-rect.top+stage.scrollTop;
  const scale=img.naturalWidth/Math.max(1,img.clientWidth);
  return {x:cssX*scale,y:cssY*scale};
}
function cropCaptureDraft(draft){
  if(draft.x==null||!$("captureImage").naturalWidth) return "";
  const img=$("captureImage");
  const side=Math.max(30,Number(draft.slotSize)||captureSlotSize());
  const sx=Math.max(0,draft.x-side/2);
  const sy=Math.max(0,draft.y-side/2);
  const sw=Math.min(side,img.naturalWidth-sx);
  const sh=Math.min(side,img.naturalHeight-sy);
  const canvas=document.createElement("canvas");
  canvas.width=144;canvas.height=144;
  const ctx=canvas.getContext("2d");
  ctx.fillStyle="#08050d";ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.drawImage(img,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
  return canvas.toDataURL("image/jpeg",.88);
}
function recropCaptureDrafts(){
  const side=captureSlotSize();
  for(const draft of captureDrafts){
    if(draft.x==null) continue;
    draft.slotSize=side;
    draft.crop=cropCaptureDraft(draft);
  }
  renderCaptureDrafts();
}

function captureIntegral(values,width,height){
  const stride=width+1;
  const integral=new Float64Array(stride*(height+1));
  for(let y=0;y<height;y++){
    let row=0;
    const sourceOffset=y*width;
    const targetOffset=(y+1)*stride;
    const previousOffset=y*stride;
    for(let x=0;x<width;x++){
      row+=values[sourceOffset+x];
      integral[targetOffset+x+1]=integral[previousOffset+x+1]+row;
    }
  }
  return integral;
}
function captureIntegralRect(integral,stride,x,y,width,height){
  const x0=Math.max(0,Math.floor(x));
  const y0=Math.max(0,Math.floor(y));
  const x1=Math.min(stride-1,Math.ceil(x+width));
  const y1=Math.min(integral.length/stride-1,Math.ceil(y+height));
  return integral[y1*stride+x1]-integral[y0*stride+x1]-integral[y1*stride+x0]+integral[y0*stride+x0];
}
function captureAnalysisModel(){
  const image=$("captureImage");
  const scale=Math.min(1,1100/Math.max(1,image.naturalWidth));
  const width=Math.max(1,Math.round(image.naturalWidth*scale));
  const height=Math.max(1,Math.round(image.naturalHeight*scale));
  const canvas=document.createElement("canvas");
  canvas.width=width;canvas.height=height;
  const context=canvas.getContext("2d",{willReadFrequently:true});
  context.drawImage(image,0,0,width,height);
  const rgba=context.getImageData(0,0,width,height).data;
  const grey=new Float32Array(width*height);
  const greySquared=new Float32Array(width*height);
  const saturation=new Float32Array(width*height);
  const edge=new Float32Array(width*height);
  for(let index=0,pixel=0;index<grey.length;index++,pixel+=4){
    const red=rgba[pixel],green=rgba[pixel+1],blue=rgba[pixel+2];
    const value=.299*red+.587*green+.114*blue;
    grey[index]=value;
    greySquared[index]=value*value;
    saturation[index]=Math.max(red,green,blue)-Math.min(red,green,blue);
  }
  for(let y=1;y<height-1;y++){
    for(let x=1;x<width-1;x++){
      const index=y*width+x;
      edge[index]=Math.abs(grey[index+1]-grey[index-1])+Math.abs(grey[index+width]-grey[index-width]);
    }
  }
  return {
    width,height,scale,stride:width+1,
    grey:captureIntegral(grey,width,height),
    greySquared:captureIntegral(greySquared,width,height),
    saturation:captureIntegral(saturation,width,height),
    edge:captureIntegral(edge,width,height)
  };
}
function captureSlotMetrics(model,x,y,side){
  const half=side/2;
  const ring=Math.max(1,Math.round(side*.065));
  const horizontalArea=Math.max(1,side*ring);
  const verticalArea=Math.max(1,(side-ring*2)*ring);
  const topEdge=captureIntegralRect(model.edge,model.stride,x-half,y-half,side,ring)/horizontalArea;
  const bottomEdge=captureIntegralRect(model.edge,model.stride,x-half,y+half-ring,side,ring)/horizontalArea;
  const leftEdge=captureIntegralRect(model.edge,model.stride,x-half,y-half+ring,ring,side-ring*2)/verticalArea;
  const rightEdge=captureIntegralRect(model.edge,model.stride,x+half-ring,y-half+ring,ring,side-ring*2)/verticalArea;
  const borderMinimum=Math.min(topEdge,bottomEdge,leftEdge,rightEdge);
  const borderEdge=(topEdge+bottomEdge+leftEdge+rightEdge)*.14+borderMinimum*.44;
  const contentSide=side*.68;
  const contentX=x-contentSide/2;
  const contentY=y-contentSide/2;
  const area=contentSide*contentSide;
  const greySum=captureIntegralRect(model.grey,model.stride,contentX,contentY,contentSide,contentSide);
  const greySquaredSum=captureIntegralRect(model.greySquared,model.stride,contentX,contentY,contentSide,contentSide);
  const deviation=Math.sqrt(Math.max(0,greySquaredSum/area-(greySum/area)**2));
  const colour=captureIntegralRect(model.saturation,model.stride,contentX,contentY,contentSide,contentSide)/area;
  const occupancy=deviation+colour*.32;
  return {score:borderEdge*.82+Math.min(75,deviation)*.3+colour*.07,occupancy};
}
function detectCaptureSlots(){
  const model=captureAnalysisModel();
  const results=[];
  const minNative=44;
  const maxNative=Math.min(220,Math.max(80,$("captureImage").naturalWidth*.14));
  const wideScreenshot=$("captureImage").naturalWidth/Math.max(1,$("captureImage").naturalHeight)>1.35;
  const chestSearchRight=model.width*(wideScreenshot ? .48 : .98);
  const chestSearchTopRatio=wideScreenshot ? .26 : .2;
  for(let nativeSide=minNative;nativeSide<=maxNative;nativeSide+=4){
    const side=nativeSide*model.scale;
    if(side<20) continue;
    const step=Math.max(4,Math.round(side*.18));
    const raw=[];
    const chestSearchTop=Math.max(side/2,model.height*chestSearchTopRatio);
    const chestSearchBottom=Math.min(model.height-side/2,model.height*.92);
    for(let y=chestSearchTop;y<chestSearchBottom;y+=step){
      for(let x=side/2;x<chestSearchRight-side/2;x+=step){
        const metrics=captureSlotMetrics(model,x,y,side);
        if(metrics.occupancy<22) continue;
        raw.push({x,y,score:metrics.score,occupancy:metrics.occupancy});
      }
    }
    raw.sort((a,b)=>b.score-a.score);
    const candidates=[];
    for(const point of raw){
      if(candidates.length>=170) break;
      if(candidates.some(other=>Math.hypot(other.x-point.x,other.y-point.y)<side*.48)) continue;
      let best=point;
      for(let offsetY=-step;offsetY<=step;offsetY+=Math.max(1,Math.round(step/3))){
        for(let offsetX=-step;offsetX<=step;offsetX+=Math.max(1,Math.round(step/3))){
          const x=point.x+offsetX,y=point.y+offsetY;
          if(x<side/2||y<side/2||x>model.width-side/2||y>model.height-side/2) continue;
          const metrics=captureSlotMetrics(model,x,y,side);
          if(metrics.score>best.score) best={x,y,score:metrics.score,occupancy:metrics.occupancy};
        }
      }
      candidates.push(best);
    }
    let bestForSide=null;
    for(const origin of candidates){
      const cells=new Map();
      for(const point of candidates){
        const column=Math.round((point.x-origin.x)/side);
        const row=Math.round((point.y-origin.y)/side);
        const expectedX=origin.x+column*side;
        const expectedY=origin.y+row*side;
        if(Math.abs(point.x-expectedX)>side*.12||Math.abs(point.y-expectedY)>side*.12) continue;
        const key=`${column},${row}`;
        if(!cells.has(key)||cells.get(key).point.score<point.score){
          cells.set(key,{column,row,point});
        }
      }
      const remaining=new Set(cells.keys());
      while(remaining.size){
        const first=remaining.values().next().value;
        remaining.delete(first);
        const queue=[cells.get(first)];
        const component=[];
        while(queue.length){
          const cell=queue.pop();
          component.push(cell);
          for(const [columnOffset,rowOffset] of [[1,0],[-1,0],[0,1],[0,-1]]){
            const key=`${cell.column+columnOffset},${cell.row+rowOffset}`;
            if(!remaining.has(key)) continue;
            remaining.delete(key);
            queue.push(cells.get(key));
          }
        }
        if(component.length<4) continue;
        const columns=component.map(cell=>cell.column);
        const rows=component.map(cell=>cell.row);
        const columnCount=Math.max(...columns)-Math.min(...columns)+1;
        const rowCount=Math.max(...rows)-Math.min(...rows)+1;
        if(columnCount<2||rowCount<2) continue;
        const density=component.length/(columnCount*rowCount);
        if(density<.58) continue;
        const points=component.map(cell=>cell.point);
        const average=points.reduce((sum,point)=>sum+point.score,0)/points.length;
        const quality=average*Math.pow(points.length,.72)*Math.pow(nativeSide,.28)*(.55+density*.45);
        if(!bestForSide||quality>bestForSide.quality) bestForSide={nativeSide,side,points,grid:component,quality};
      }
    }
    if(bestForSide) results.push(bestForSide);
  }
  if(!results.length) return null;
  results.sort((left,right)=>right.quality-left.quality);
  const best=results[0];
  const fitAxis=(key,coordinate)=>{
    const values=best.grid.map(cell=>({index:cell[key],value:cell.point[coordinate]}));
    const indexAverage=values.reduce((sum,value)=>sum+value.index,0)/values.length;
    const valueAverage=values.reduce((sum,value)=>sum+value.value,0)/values.length;
    const variance=values.reduce((sum,value)=>sum+(value.index-indexAverage)**2,0);
    if(variance<.01) return null;
    const slope=values.reduce((sum,value)=>sum+(value.index-indexAverage)*(value.value-valueAverage),0)/variance;
    return {slope,intercept:valueAverage-slope*indexAverage};
  };
  const horizontalFit=fitAxis("column","x");
  const verticalFit=fitAxis("row","y");
  const fittedCandidates=[Math.abs(horizontalFit?.slope||0),Math.abs(verticalFit?.slope||0)].filter(value=>value>best.side*.72&&value<best.side*1.28);
  const fittedSide=fittedCandidates.length?fittedCandidates.reduce((sum,value)=>sum+value,0)/fittedCandidates.length:best.side;
  let originX=horizontalFit?.intercept??best.grid[0].point.x-best.grid[0].column*fittedSide;
  let originY=verticalFit?.intercept??best.grid[0].point.y-best.grid[0].row*fittedSide;
  const initialOriginX=originX;
  const initialOriginY=originY;
  let phaseScore=-Infinity;
  const phaseStep=fittedSide*.05;
  for(let offsetY=-fittedSide*.3;offsetY<=fittedSide*.3;offsetY+=phaseStep){
    for(let offsetX=-fittedSide*.3;offsetX<=fittedSide*.3;offsetX+=phaseStep){
      let score=0;
      for(const cell of best.grid){
        score+=captureSlotMetrics(model,initialOriginX+offsetX+cell.column*fittedSide,initialOriginY+offsetY+cell.row*fittedSide,fittedSide).score;
      }
      if(score>phaseScore){phaseScore=score;originX=initialOriginX+offsetX;originY=initialOriginY+offsetY;}
    }
  }
  const fittedMetrics=best.grid.map(cell=>captureSlotMetrics(model,originX+cell.column*fittedSide,originY+cell.row*fittedSide,fittedSide));
  const averageScore=fittedMetrics.reduce((sum,metrics)=>sum+metrics.score,0)/fittedMetrics.length;
  const occupied=new Map();
  const bestColumns=best.grid.map(cell=>cell.column);
  const bestRows=best.grid.map(cell=>cell.row);
  const minColumn=Math.max(Math.ceil((fittedSide/2-originX)/fittedSide),Math.min(...bestColumns));
  const maxColumn=Math.min(Math.floor((chestSearchRight-fittedSide/2-originX)/fittedSide),Math.max(...bestColumns));
  const minRow=Math.max(Math.ceil((model.height*chestSearchTopRatio-originY)/fittedSide),Math.min(...bestRows)-2);
  const maxRow=Math.min(Math.floor((model.height*.92-originY)/fittedSide),Math.max(...bestRows)+3);
  for(let row=minRow;row<=maxRow;row++){
    for(let column=minColumn;column<=maxColumn;column++){
      const x=originX+column*fittedSide;
      const y=originY+row*fittedSide;
      const metrics=captureSlotMetrics(model,x,y,fittedSide);
      if(metrics.occupancy<22||metrics.score<averageScore*.45) continue;
      occupied.set(`${column},${row}`,{column,row,point:{x,y,score:metrics.score,occupancy:metrics.occupancy}});
    }
  }
  const remaining=new Set(occupied.keys());
  let expandedCells=[];
  let expandedRank=-Infinity;
  while(remaining.size){
    const first=remaining.values().next().value;
    remaining.delete(first);
    const queue=[occupied.get(first)];
    const component=[];
    while(queue.length){
      const cell=queue.pop();
      component.push(cell);
      for(const [columnOffset,rowOffset] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const key=`${cell.column+columnOffset},${cell.row+rowOffset}`;
        if(!remaining.has(key)) continue;
        remaining.delete(key);
        queue.push(occupied.get(key));
      }
    }
    const overlap=component.filter(cell=>best.points.some(point=>Math.hypot(point.x-cell.point.x,point.y-cell.point.y)<fittedSide*.35)).length;
    const rank=overlap*100+component.length;
    if(rank>expandedRank){expandedRank=rank;expandedCells=component;}
  }
  if(expandedCells.length){
    const columnScores=new Map();
    const rowScores=new Map();
    for(const cell of expandedCells){
      if(!columnScores.has(cell.column)) columnScores.set(cell.column,[]);
      if(!rowScores.has(cell.row)) rowScores.set(cell.row,[]);
      columnScores.get(cell.column).push(cell.point.score);
      rowScores.get(cell.row).push(cell.point.score);
    }
    const columnAverages=new Map([...columnScores].map(([key,values])=>[key,values.reduce((sum,value)=>sum+value,0)/values.length]));
    const rowAverages=new Map([...rowScores].map(([key,values])=>[key,values.reduce((sum,value)=>sum+value,0)/values.length]));
    const bestColumn=Math.max(...columnAverages.values());
    const bestRow=Math.max(...rowAverages.values());
    expandedCells=expandedCells.filter(cell=>columnAverages.get(cell.column)>=bestColumn*.68&&rowAverages.get(cell.row)>=bestRow*.7);
  }
  const expanded=expandedCells.map(cell=>cell.point);
  const points=[];
  for(const point of (expanded.length>=best.points.length?expanded:best.points).sort((a,b)=>a.y-b.y||a.x-b.x)){
    if(points.some(other=>Math.hypot(other.x-point.x,other.y-point.y)<fittedSide*.55)) continue;
    points.push(point);
  }
  return {
    side:Math.round(fittedSide/model.scale),
    points:points.map(point=>({
      x:(point.x+fittedSide*.22)/model.scale,
      y:(point.y+fittedSide*.5)/model.scale
    }))
  };
}
function capturePopcount(value){
  value=value>>>0;
  value=value-((value>>>1)&0x55555555);
  value=(value&0x33333333)+((value>>>2)&0x33333333);
  return (((value+(value>>>4))&0x0f0f0f0f)*0x01010101)>>>24;
}
function captureDctMatrix(){
  if(captureDctMatrix.cache) return captureDctMatrix.cache;
  const size=32;
  const matrix=new Float64Array(size*size);
  for(let frequency=0;frequency<size;frequency++){
    const factor=frequency===0?Math.sqrt(1/size):Math.sqrt(2/size);
    for(let coordinate=0;coordinate<size;coordinate++){
      matrix[frequency*size+coordinate]=factor*Math.cos(Math.PI*(2*coordinate+1)*frequency/(2*size));
    }
  }
  captureDctMatrix.cache=matrix;
  return matrix;
}
function captureVisualDescriptor(draft){
  const image=$("captureImage");
  const side=Math.max(30,Number(draft.slotSize)||captureSlotSize());
  const contentSide=side*.76;
  const sourceX=Math.max(0,draft.x-contentSide/2);
  const sourceY=Math.max(0,draft.y-contentSide/2);
  const canvas=document.createElement("canvas");
  canvas.width=32;canvas.height=32;
  const context=canvas.getContext("2d",{willReadFrequently:true});
  context.fillStyle="rgb(44,50,54)";
  context.fillRect(0,0,32,32);
  context.imageSmoothingEnabled=true;
  context.imageSmoothingQuality="high";
  context.drawImage(image,sourceX,sourceY,contentSide,contentSide,0,0,32,32);
  const rgba=context.getImageData(0,0,32,32).data;
  const grey=new Float64Array(1024);
  for(let index=0,pixel=0;index<grey.length;index++,pixel+=4){
    grey[index]=.299*rgba[pixel]+.587*rgba[pixel+1]+.114*rgba[pixel+2];
  }
  const matrix=captureDctMatrix();
  const horizontal=new Float64Array(1024);
  for(let y=0;y<32;y++){
    for(let frequency=0;frequency<32;frequency++){
      let sum=0;
      for(let x=0;x<32;x++) sum+=matrix[frequency*32+x]*grey[y*32+x];
      horizontal[y*32+frequency]=sum;
    }
  }
  const coefficients=[];
  for(let vertical=0;vertical<8;vertical++){
    for(let horizontalFrequency=0;horizontalFrequency<8;horizontalFrequency++){
      let sum=0;
      for(let y=0;y<32;y++) sum+=matrix[vertical*32+y]*horizontal[y*32+horizontalFrequency];
      coefficients.push(sum);
    }
  }
  const threshold=[...coefficients.slice(1)].sort((a,b)=>a-b)[31];
  let high=0,low=0;
  coefficients.forEach((value,index)=>{
    if(index<32) high=((high<<1)|(value>=threshold?1:0))>>>0;
    else low=((low<<1)|(value>=threshold?1:0))>>>0;
  });
  const colourCanvas=document.createElement("canvas");
  colourCanvas.width=4;colourCanvas.height=4;
  const colourContext=colourCanvas.getContext("2d",{willReadFrequently:true});
  colourContext.drawImage(canvas,0,0,4,4);
  const colourRgba=colourContext.getImageData(0,0,4,4).data;
  const colours=[];
  for(let pixel=0;pixel<colourRgba.length;pixel+=4){
    colours.push(colourRgba[pixel]>>4,colourRgba[pixel+1]>>4,colourRgba[pixel+2]>>4);
  }
  const detailCanvas=document.createElement("canvas");
  detailCanvas.width=12;detailCanvas.height=12;
  const detailContext=detailCanvas.getContext("2d",{willReadFrequently:true});
  detailContext.drawImage(canvas,0,0,12,12);
  const detailRgba=detailContext.getImageData(0,0,12,12).data;
  const details=[];
  for(let pixel=0;pixel<detailRgba.length;pixel+=4){
    details.push(Math.min(15,Math.floor((.299*detailRgba[pixel]+.587*detailRgba[pixel+1]+.114*detailRgba[pixel+2])/16)));
  }
  return {high,low,colours,details};
}
async function loadCaptureVisualIndex(){
  if(captureVisualIndexPromise) return captureVisualIndexPromise;
  captureVisualIndexPromise=fetch("./item-visual-index.json?v=2",{cache:"force-cache"})
    .then(response=>{
      if(!response.ok) throw new Error("Índice visual no disponible.");
      return response.json();
    })
    .then(payload=>(payload.records||[]).map(record=>({
      id:record[0],
      high:Number.parseInt(record[1].slice(0,8),16)>>>0,
      low:Number.parseInt(record[1].slice(8),16)>>>0,
      colours:[...record[2]].map(value=>Number.parseInt(value,16)),
      details:[...(record[3]||"")].map(value=>Number.parseInt(value,16))
    })))
    .catch(error=>{
      captureVisualIndexPromise=null;
      throw error;
    });
  return captureVisualIndexPromise;
}
function captureRecognitionLabel(recognition){
  if(!recognition?.automatic) return "✓ revisado";
  if(recognition.state==="busy") return "analizando…";
  return `detectado · confianza ${recognition.confidence||"baja"}`;
}
async function recognizeCaptureObjects(sequence){
  try{
    await itemLoadPromise;
    const index=await loadCaptureVisualIndex();
    if(sequence!==captureDetectionSequence) return;
    const catalog=new Map(items.map(item=>[item.id,item]));
    for(let draftIndex=0;draftIndex<captureDrafts.length;draftIndex++){
      const draft=captureDrafts[draftIndex];
      if(draft.x==null) continue;
      const descriptor=captureVisualDescriptor(draft);
      const scored=[];
      for(const record of index){
        if(!catalog.has(record.id)) continue;
        const hashDistance=capturePopcount(descriptor.high^record.high)+capturePopcount(descriptor.low^record.low);
        let colourDistance=0;
        for(let index=0;index<48;index++) colourDistance+=Math.abs(descriptor.colours[index]-record.colours[index]);
        const score=hashDistance*1.15+(colourDistance/48)*.8;
        scored.push({record,score});
      }
      scored.sort((left,right)=>left.score-right.score);
      const detailAverage=descriptor.details.reduce((sum,value)=>sum+value,0)/descriptor.details.length;
      const detailDeviation=Math.sqrt(descriptor.details.reduce((sum,value)=>sum+(value-detailAverage)**2,0)/descriptor.details.length)||1;
      for(const result of scored.slice(0,250)){
        if(result.record.details.length!==descriptor.details.length){result.finalScore=result.score;continue;}
        const average=result.record.details.reduce((sum,value)=>sum+value,0)/result.record.details.length;
        const deviation=Math.sqrt(result.record.details.reduce((sum,value)=>sum+(value-average)**2,0)/result.record.details.length)||1;
        let normalizedError=0;
        for(let index=0;index<descriptor.details.length;index++){
          const difference=(descriptor.details[index]-detailAverage)/detailDeviation-(result.record.details[index]-average)/deviation;
          normalizedError+=difference*difference;
        }
        result.finalScore=result.score*.25+(normalizedError/descriptor.details.length)*7;
      }
      scored.splice(250);
      scored.sort((left,right)=>(left.finalScore??left.score)-(right.finalScore??right.score));
      const best=scored[0];
      if(best){
        const item=catalog.get(best.record.id);
        const score=best.finalScore??best.score;
        const nextScore=scored[1]?.finalScore??scored[1]?.score??score+2;
        const gap=nextScore-score;
        const confidence=score<=6&&gap>=.5?"alta":score<=10&&gap>=.22?"media":"baja";
        draft.item={id:item.id,name:item.name};
        draft.query=item.name;
        draft.recognition={
          automatic:true,state:"done",confidence,score,
          alternatives:scored.slice(0,4).map(result=>catalog.get(result.record.id)).filter(Boolean)
        };
      }else{
        draft.recognition={automatic:true,state:"error",confidence:"baja",alternatives:[]};
      }
      if(draftIndex%4===3){
        renderCaptureDrafts();
        await new Promise(resolve=>setTimeout(resolve,0));
        if(sequence!==captureDetectionSequence) return;
      }
    }
    renderCaptureDrafts();
  }catch(_){
    for(const draft of captureDrafts){
      if(draft.recognition?.automatic) draft.recognition={automatic:true,state:"error",confidence:"baja",alternatives:[]};
    }
    renderCaptureDrafts();
  }
}
function newCaptureDraft(point=null,options={}){
  const side=Number(options.slotSize)||captureSlotSize();
  const automatic=options.automatic===true;
  const draft={
    uid:captureUid(),x:point?.x??null,y:point?.y??null,slotSize:side,crop:"",
    query:"",item:null,enchantment:0,quality:1,quantity:1,matches:[],
    recognition:automatic?{automatic:true,state:"busy",confidence:"",alternatives:[]}:null,
    quantityEdited:false,ocrState:point?"busy":"manual",
    ocrStatus:point?"Cantidad pendiente de lectura…":"Cantidad manual"
  };
  draft.crop=cropCaptureDraft(draft);
  return draft;
}
async function autoDetectCapture(){
  if(!$("captureImage").naturalWidth) return;
  const sequence=++captureDetectionSequence;
  const button=$("autoDetectCaptureBtn");
  button.disabled=true;
  button.textContent="Detectando…";
  setCaptureStatus("Buscando la cuadrícula y las casillas ocupadas…",true);
  await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
  try{
    const result=detectCaptureSlots();
    if(sequence!==captureDetectionSequence) return;
    if(!result?.points.length){
      captureDrafts=[];
      renderCaptureDrafts();
      setCaptureStatus("No encontré una cuadrícula clara. Ajusta el tamaño o toca cada objeto manualmente.");
      return;
    }
    const limited=result.points.slice(0,120);
    $("captureSlotSize").value=Math.max(Number($("captureSlotSize").min),Math.min(Number($("captureSlotSize").max),result.side));
    $("captureSlotSizeLabel").textContent=`${result.side} px`;
    captureDrafts=limited.map(point=>newCaptureDraft(point,{slotSize:result.side,automatic:true}));
    renderCaptureDrafts();
    setCaptureStatus(`${limited.length} casilla${limited.length===1?"":"s"} encontrada${limited.length===1?"":"s"}. Identificando objetos…`,true);
    await recognizeCaptureObjects(sequence);
    if(sequence!==captureDetectionSequence) return;
    const low=captureDrafts.filter(draft=>draft.recognition?.confidence==="baja").length;
    setCaptureStatus(`${captureDrafts.length} objeto${captureDrafts.length===1?"":"s"} propuesto${captureDrafts.length===1?"":"s"}. ${low?`${low} con confianza baja. `:""}Revisa y cambia cualquier dato antes de importar.`);
    captureDrafts.forEach(draft=>queueQuantityRecognition(draft.uid));
  }catch(_){
    setCaptureStatus("No pude completar la detección. Puedes volver a intentarlo o marcar las casillas manualmente.");
  }finally{
    if(sequence===captureDetectionSequence){
      button.disabled=false;
      button.textContent="Detectar objetos";
    }
  }
}
function drawCaptureOverlay(){
  const img=$("captureImage"),canvas=$("captureOverlay");
  if(!img.naturalWidth) return;
  canvas.width=img.naturalWidth;
  canvas.height=img.naturalHeight;
  const ctx=canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const line=Math.max(3,canvas.width/500);
  ctx.textAlign="center";ctx.textBaseline="middle";
  captureDrafts.forEach((draft,index)=>{
    if(draft.x==null) return;
    const side=draft.slotSize||captureSlotSize();
    ctx.lineWidth=line;
    ctx.strokeStyle="#c4a7ff";
    ctx.fillStyle="rgba(139,92,246,.16)";
    ctx.fillRect(draft.x-side/2,draft.y-side/2,side,side);
    ctx.strokeRect(draft.x-side/2,draft.y-side/2,side,side);
    const radius=Math.max(11,side*.19);
    ctx.beginPath();ctx.arc(draft.x-side/2+radius*.75,draft.y-side/2+radius*.75,radius,0,Math.PI*2);
    ctx.fillStyle="#8b5cf6";ctx.fill();
    ctx.fillStyle="#160b28";ctx.font=`900 ${Math.max(14,radius)}px system-ui`;
    ctx.fillText(String(index+1),draft.x-side/2+radius*.75,draft.y-side/2+radius*.75+1);
  });
}
function addCaptureDraft(point=null){
  const side=captureSlotSize();
  if(point){
    const duplicate=captureDrafts.some(draft=>draft.x!=null&&Math.hypot(draft.x-point.x,draft.y-point.y)<side*.42);
    if(duplicate){
      setCaptureStatus("Esa casilla ya está marcada. Toca otro objeto.");
      return;
    }
  }
  const draft=newCaptureDraft(point,{slotSize:side});
  captureDrafts.push(draft);
  renderCaptureDrafts();
  if(point) queueQuantityRecognition(draft.uid);
  else setTimeout(()=>$("captureDrafts").querySelector(`[data-capture-id="${draft.uid}"] [data-field="item"]`)?.focus(),0);
}
function captureQualityOptions(selectedQuality){
  return Object.entries(QUALITY_NAMES).map(([value,label])=>`<option value="${value}" ${Number(value)===Number(selectedQuality)?"selected":""}>${esc(label)}</option>`).join("");
}
function captureDuplicateGroups(){
  const groups=new Map();
  for(const draft of captureDrafts){
    if(!draft.item) continue;
    const key=`${draft.item.id}@${Number(draft.enchantment)||0}|${Number(draft.quality)||1}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(draft);
  }
  return [...groups.values()].filter(group=>group.length>1);
}
function mergeCaptureDuplicates(){
  const groups=captureDuplicateGroups();
  if(!groups.length) return;
  const removed=new Set();
  for(const group of groups){
    const keeper=group[0];
    keeper.quantity=group.reduce((sum,draft)=>sum+Math.max(1,Math.floor(Number(draft.quantity)||1)),0);
    keeper.quantityEdited=true;
    keeper.ocrState="done";
    keeper.ocrStatus=`${group.length} casillas agrupadas · ${keeper.quantity} unidades.`;
    group.slice(1).forEach(draft=>removed.add(draft.uid));
  }
  captureDrafts=captureDrafts.filter(draft=>!removed.has(draft.uid));
  renderCaptureDrafts();
  setCaptureStatus(`${removed.size} duplicado${removed.size===1?"":"s"} agrupado${removed.size===1?"":"s"}. Revisa las cantidades resultantes.`);
}
function renderCaptureReviewSummary(){
  const summary=$("captureReviewSummary");
  if(!summary) return;
  const ready=captureDrafts.filter(draft=>draft.item).length;
  const missing=captureDrafts.length-ready;
  const low=captureDrafts.filter(draft=>draft.recognition?.automatic&&draft.recognition.confidence==="baja").length;
  const duplicates=captureDuplicateGroups();
  const units=captureDrafts.reduce((sum,draft)=>sum+Math.max(1,Math.floor(Number(draft.quantity)||1)),0);
  summary.classList.toggle("hidden",!captureDrafts.length);
  summary.innerHTML=!captureDrafts.length?"":`
    <div class="capture-review-head"><strong>Resumen antes de importar</strong><span>${captureDrafts.length} casillas · ${units} unidades</span></div>
    <div class="capture-review-stats">
      <span class="${missing?"bad":"good"}">${missing?`${missing} sin identificar`:"Todos identificados"}</span>
      <span class="${low?"warning":"good"}">${low?`${low} requieren revisión`:"Sin dudas pendientes"}</span>
      <span class="${duplicates.length?"warning":""}">${duplicates.length?`${duplicates.length} grupos repetidos`:"Sin repetidos"}</span>
    </div>
    ${duplicates.length?`<button id="mergeCaptureDuplicatesBtn" class="ghost" type="button">Agrupar objetos repetidos</button>`:""}`;
  $("mergeCaptureDuplicatesBtn")?.addEventListener("click",mergeCaptureDuplicates);
}
function renderCaptureDrafts(){
  $("captureDraftCount").textContent=captureDrafts.length;
  $("captureDraftCount").classList.toggle("hidden",!captureDrafts.length);
  $("captureDrafts").innerHTML=captureDrafts.map((draft,index)=>`
    <article class="capture-draft ${draft.item?"ready":""} ${draft.recognition?.confidence==="baja"?"low-confidence":""}" data-capture-id="${esc(draft.uid)}">
      <div class="capture-draft-preview">
        ${draft.crop?`<img src="${draft.crop}" alt="Recorte de la casilla ${index+1}">`:`<span class="capture-draft-placeholder">+</span>`}
        <span class="capture-draft-number">${index+1}</span>
      </div>
      <div class="capture-draft-main">
        <div class="capture-item-search">
          <label for="capture-item-${esc(draft.uid)}">Objeto ${draft.item||draft.recognition?`<small class="recognition-${esc(draft.recognition?.confidence||"reviewed")}">${esc(captureRecognitionLabel(draft.recognition))}</small>`:""}</label>
          <input id="capture-item-${esc(draft.uid)}" data-field="item" autocomplete="off" placeholder="Buscar nombre o ID…" value="${esc(draft.query)}">
          <div class="capture-draft-suggestions hidden"></div>
        </div>
        ${draft.recognition?.automatic&&draft.recognition.state==="done"?`
          <div class="capture-recognition-note ${draft.recognition.confidence}">
            <span>${draft.recognition.confidence==="baja"?"Comprueba este nombre":"Propuesta automática"}</span>
            <span><button data-action="review-capture-item" type="button">Confirmar</button><button data-action="edit-capture-item" type="button">Cambiar</button></span>
          </div>`:""}
        <div class="capture-mini-grid">
          <div class="field">
            <label for="capture-enchant-${esc(draft.uid)}">Encantamiento</label>
            <select id="capture-enchant-${esc(draft.uid)}" data-field="enchantment">
              ${[0,1,2,3,4].map(value=>`<option value="${value}" ${value===Number(draft.enchantment)?"selected":""}>.${value}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="capture-quality-${esc(draft.uid)}">Calidad</label>
            <select id="capture-quality-${esc(draft.uid)}" data-field="quality">${captureQualityOptions(draft.quality)}</select>
          </div>
          <div class="field">
            <label for="capture-qty-${esc(draft.uid)}">Cantidad</label>
            <input id="capture-qty-${esc(draft.uid)}" data-field="quantity" type="number" min="1" step="1" inputmode="numeric" value="${draft.quantity}">
          </div>
        </div>
        <div class="capture-ocr-status ${draft.ocrState==="done"?"good":draft.ocrState==="error"?"bad":""}">
          <span>${esc(draft.ocrStatus)}</span>
          ${draft.x!=null&&draft.ocrState!=="busy"?`<button data-action="retry-ocr" type="button">Releer</button>`:""}
        </div>
      </div>
      <button class="remove-item" data-action="remove-capture" title="Quitar casilla" aria-label="Quitar casilla ${index+1}">×</button>
    </article>`).join("");
  if(!captureDrafts.length){
    $("captureDrafts").innerHTML=`<div class="transport-empty">Pulsa Detectar objetos, toca las casillas o añade una fila manual.</div>`;
  }
  updateCaptureImportButton();
  renderCaptureReviewSummary();
  drawCaptureOverlay();
  saveCaptureDraftSession();
}
function updateCaptureImportButton(){
  const button=$("importChestItemsBtn");
  const ready=captureDrafts.filter(draft=>draft.item).length;
  const low=captureDrafts.filter(draft=>draft.recognition?.automatic&&draft.recognition.confidence==="baja").length;
  button.disabled=!captureDrafts.length||ready!==captureDrafts.length||low>0;
  button.textContent=!captureDrafts.length?"Añadir al cofre y consultar precios":low?`Revisa ${low} resultado${low===1?"":"s"} dudoso${low===1?"":"s"}`:ready===captureDrafts.length?`Añadir ${ready} objeto${ready===1?"":"s"} al cofre`:`Confirma ${captureDrafts.length-ready} objeto${captureDrafts.length-ready===1?"":"s"}`;
}

function findCaptureMatches(query){
  const raw=query.trim();
  const q=raw.toLocaleLowerCase("es");
  if(q.length<2) return [];
  const matches=items
    .filter(item=>item.name.toLocaleLowerCase("es").includes(q)||item.id.toLowerCase().includes(q))
    .sort((a,b)=>searchScore(a,q)-searchScore(b,q))
    .slice(0,7);
  if(/^[A-Z0-9]+_[A-Z0-9_]+(?:@\d+)?$/i.test(raw)){
    const typed=raw.toUpperCase();
    if(!matches.some(item=>item.id===baseId(typed))){
      matches.push({id:typed,name:`Usar ID ${typed}`,manual:true});
    }
  }
  return matches.slice(0,8);
}
function renderCaptureSuggestions(draft,card){
  const box=card.querySelector(".capture-draft-suggestions");
  draft.matches=findCaptureMatches(draft.query);
  if(!draft.matches.length){
    box.innerHTML=draft.query.trim().length>=2?`<div class="transport-empty">Sin coincidencias. También puedes pegar el ID del objeto.</div>`:"";
    box.classList.toggle("hidden",!box.innerHTML);
    return;
  }
  box.innerHTML=draft.matches.map((item,index)=>`
    <button type="button" class="capture-draft-suggestion" data-action="select-capture-item" data-index="${index}">
      <img src="${imageUrl(baseId(item.id),1,64)}" alt="" loading="lazy">
      <span><strong>${esc(item.name)}</strong><small>${esc(item.id)}</small></span>
    </button>`).join("");
  box.classList.remove("hidden");
}
function selectCaptureItem(draft,item){
  const enchantment=Number(String(item.id).match(/@(\d+)$/)?.[1]||draft.enchantment||0);
  const id=baseId(item.id);
  const catalogItem=items.find(candidate=>candidate.id===id);
  draft.item={id,name:catalogItem?.name||(item.manual?id:item.name)};
  draft.query=draft.item.name;
  draft.enchantment=Math.max(0,Math.min(4,enchantment));
  draft.recognition={automatic:false,state:"reviewed",confidence:"reviewed",alternatives:[]};
  renderCaptureDrafts();
}
function loadCaptureScript(src){
  if(window.Tesseract) return Promise.resolve();
  const existing=document.querySelector(`script[data-capture-ocr="true"]`);
  if(existing) return new Promise((resolve,reject)=>{
    existing.addEventListener("load",resolve,{once:true});
    existing.addEventListener("error",reject,{once:true});
  });
  return new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    script.src=src;script.async=true;script.dataset.captureOcr="true";
    script.onload=resolve;script.onerror=()=>{
      script.remove();
      reject(new Error("No se pudo descargar el lector OCR."));
    };
    document.head.appendChild(script);
  });
}
async function getCaptureOcrWorker(){
  if(captureOcrWorker) return captureOcrWorker;
  if(captureOcrWorkerPromise) return captureOcrWorkerPromise;
  captureOcrWorkerPromise=(async()=>{
    await loadCaptureScript("https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js");
    if(!window.Tesseract) throw new Error("El lector OCR no está disponible.");
    const worker=await window.Tesseract.createWorker("eng",1,{
      logger:message=>{
        if(message.progress>0&&message.progress<1){
          setCaptureStatus(`Preparando reconocimiento local… ${Math.round(message.progress*100)}%`,true);
        }
      }
    });
    await worker.setParameters({
      tessedit_char_whitelist:"0123456789",
      tessedit_pageseg_mode:window.Tesseract.PSM?.SINGLE_WORD||"8",
      preserve_interword_spaces:"0"
    });
    captureOcrWorker=worker;
    return worker;
  })().catch(error=>{
    captureOcrWorkerPromise=null;
    throw error;
  });
  return captureOcrWorkerPromise;
}
function quantityCanvas(draft){
  const img=$("captureImage");
  const side=Math.max(30,Number(draft.slotSize)||captureSlotSize());
  const sx=Math.max(0,draft.x-side*.05);
  const sy=Math.max(0,draft.y+side*.02);
  const sw=Math.min(side*.55,img.naturalWidth-sx);
  const sh=Math.min(side*.5,img.naturalHeight-sy);
  const canvas=document.createElement("canvas");
  canvas.width=300;canvas.height=180;
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  ctx.fillStyle="#000";ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(img,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
  for(let i=0;i<pixels.data.length;i+=4){
    const r=pixels.data[i],g=pixels.data[i+1],b=pixels.data[i+2];
    const brightness=.299*r+.587*g+.114*b;
    const value=brightness>165?255:0;
    pixels.data[i]=value;pixels.data[i+1]=value;pixels.data[i+2]=value;pixels.data[i+3]=255;
  }
  ctx.putImageData(pixels,0,0);
  return canvas;
}
function queueQuantityRecognition(uid){
  captureOcrQueue=captureOcrQueue.then(()=>recognizeCaptureQuantity(uid)).catch(()=>{});
}
function updateCaptureOcrCard(draft){
  const card=$("captureDrafts").querySelector(`[data-capture-id="${draft.uid}"]`);
  if(!card) return;
  const input=card.querySelector('[data-field="quantity"]');
  if(input&&document.activeElement!==input) input.value=draft.quantity;
  const status=card.querySelector(".capture-ocr-status");
  if(!status) return;
  status.className=`capture-ocr-status ${draft.ocrState==="done"?"good":draft.ocrState==="error"?"bad":""}`;
  status.innerHTML=`<span>${esc(draft.ocrStatus)}</span>${draft.x!=null&&draft.ocrState!=="busy"?`<button data-action="retry-ocr" type="button">Releer</button>`:""}`;
}
async function recognizeCaptureQuantity(uid){
  const draft=captureDrafts.find(item=>item.uid===uid);
  if(!draft||draft.x==null) return;
  draft.ocrState="busy";draft.ocrStatus="Leyendo cantidad en este dispositivo…";
  updateCaptureOcrCard(draft);
  try{
    const worker=await getCaptureOcrWorker();
    if(!captureDrafts.some(item=>item.uid===uid)) return;
    const result=await worker.recognize(quantityCanvas(draft));
    const digits=String(result?.data?.text||"").replace(/\D/g,"");
    const quantity=Number(digits);
    if(draft.quantityEdited){
      draft.ocrState="done";
      draft.ocrStatus="Cantidad revisada manualmente.";
    }else if(Number.isFinite(quantity)&&quantity>0&&quantity<=999999){
      draft.quantity=Math.floor(quantity);
      draft.ocrState="done";
      draft.ocrStatus=`Cantidad detectada: ${draft.quantity}. Confírmala antes de importar.`;
    }else{
      draft.quantity=Math.max(1,Number(draft.quantity)||1);
      draft.ocrState="error";
      draft.ocrStatus="No se vio una cantidad; se usará 1. Puedes corregirla.";
    }
  }catch(_){
    draft.ocrState="error";
    draft.ocrStatus="OCR no disponible. Escribe la cantidad manualmente.";
  }
  updateCaptureOcrCard(draft);
  const pending=captureDrafts.filter(item=>item.ocrState==="busy").length;
  setCaptureStatus(pending?`Leyendo ${pending} casilla${pending===1?"":"s"}…`:"Revisa los objetos y cantidades antes de añadirlos al cofre.",pending>0);
}

async function importCaptureDrafts(){
  if(!captureDrafts.length||captureDrafts.some(draft=>!draft.item)) return;
  const button=$("importChestItemsBtn");
  const importedCount=captureDrafts.length;
  button.disabled=true;button.textContent="Añadiendo al cofre…";
  const list=getActiveTransportItems();
  const server=$("server").value;
  for(const draft of captureDrafts){
    const id=draft.item.id+(Number(draft.enchantment)>0?`@${Number(draft.enchantment)}`:"");
    const quality=Number(draft.quality)||1;
    const quantity=Math.max(1,Math.floor(Number(draft.quantity)||1));
    const existing=list.find(item=>item.server===server&&item.id===id&&Number(item.quality)===quality);
    if(existing){
      existing.quantity=Math.max(1,Number(existing.quantity)||1)+quantity;
    }else{
      list.unshift({
        uid:`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
        server,id,name:draft.item.name,quality,quantity,prices:normalizePrices([]),updatedAt:0
      });
    }
  }
  saveActiveTransportItems(list);
  captureDrafts=[];
  renderCaptureDrafts();
  closeChestImport();
  renderTransportPlanner();
  $("transportStatus").textContent=`${importedCount} objeto${importedCount===1?"":"s"} importado${importedCount===1?"":"s"}. Consultando precios…`;
  try{
    await refreshTransportPrices();
  }finally{
    button.disabled=false;
    updateCaptureImportButton();
  }
}

async function loadItems(){
  try{
    const cacheKey = "albion-items-lite-v2-deduped-v2";
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
    $("transportRecommendation").innerHTML=`<strong>Tu cofre está vacío</strong><small>Importa una captura del cofre o añade objetos desde Mercado.</small>`;
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
$("importCaptureBtn").addEventListener("click",openChestImport);
$("closeChestImportBtn").addEventListener("click",closeChestImport);
$("chestCaptureInput").addEventListener("change",event=>{
  handleCaptureFile(event.target.files?.[0]);
  event.target.value="";
});
$("clipboardPasteZone").addEventListener("click",()=>{
  $("clipboardPasteZone").focus();
  setCaptureStatus("Pulsa Ctrl + V para pegar la captura que copiaste.");
});
$("clipboardPasteZone").addEventListener("keydown",event=>{
  if(event.key!=="Enter"&&event.key!==" ") return;
  event.preventDefault();
  setCaptureStatus("Ahora pulsa Ctrl + V para pegar la captura.");
});
$("captureStage").addEventListener("click",event=>{
  if(!$("captureImage").naturalWidth) return;
  addCaptureDraft(captureCoordinates(event));
});
$("captureStage").addEventListener("keydown",event=>{
  if(event.key!=="Enter"&&event.key!==" ") return;
  event.preventDefault();
  addCaptureDraft();
});
$("captureSlotSize").addEventListener("input",event=>{
  $("captureSlotSizeLabel").textContent=`${event.target.value} px`;
  recropCaptureDrafts();
});
$("autoDetectCaptureBtn").addEventListener("click",autoDetectCapture);
$("clearCaptureMarksBtn").addEventListener("click",clearCaptureDrafts);
$("addManualCaptureItemBtn").addEventListener("click",()=>addCaptureDraft());
$("importChestItemsBtn").addEventListener("click",importCaptureDrafts);
$("captureDrafts").addEventListener("input",event=>{
  const card=event.target.closest("[data-capture-id]");
  const field=event.target.dataset.field;
  if(!card||!field) return;
  const draft=captureDrafts.find(item=>item.uid===card.dataset.captureId);
  if(!draft) return;
  if(field==="item"){
    draft.query=event.target.value;
    if(draft.item&&draft.query!==draft.item.name) draft.item=null;
    draft.recognition=null;
    renderCaptureSuggestions(draft,card);
    updateCaptureImportButton();
  }else if(field==="quantity"){
    draft.quantity=Math.max(1,Math.floor(Number(event.target.value)||1));
    draft.quantityEdited=true;
    draft.ocrState="done";
    draft.ocrStatus="Cantidad revisada manualmente.";
    card.querySelector(".capture-ocr-status span").textContent=draft.ocrStatus;
    card.querySelector(".capture-ocr-status").className="capture-ocr-status good";
    renderCaptureReviewSummary();
    saveCaptureDraftSession();
  }
});
$("captureDrafts").addEventListener("change",event=>{
  const card=event.target.closest("[data-capture-id]");
  const field=event.target.dataset.field;
  if(!card||!field) return;
  const draft=captureDrafts.find(item=>item.uid===card.dataset.captureId);
  if(!draft) return;
  if(field==="enchantment") draft.enchantment=Number(event.target.value)||0;
  if(field==="quality") draft.quality=Number(event.target.value)||1;
  if(field==="quantity") draft.quantity=Math.max(1,Math.floor(Number(event.target.value)||1));
  renderCaptureReviewSummary();
  saveCaptureDraftSession();
});
$("captureDrafts").addEventListener("focusin",event=>{
  if(event.target.dataset.field!=="item") return;
  const card=event.target.closest("[data-capture-id]");
  const draft=captureDrafts.find(item=>item.uid===card?.dataset.captureId);
  if(draft) renderCaptureSuggestions(draft,card);
});
$("captureDrafts").addEventListener("keydown",event=>{
  if(event.target.dataset.field!=="item"||event.key!=="Enter") return;
  const card=event.target.closest("[data-capture-id]");
  const draft=captureDrafts.find(item=>item.uid===card?.dataset.captureId);
  if(!draft) return;
  renderCaptureSuggestions(draft,card);
  if(draft.matches[0]){
    event.preventDefault();
    selectCaptureItem(draft,draft.matches[0]);
  }
});
$("captureDrafts").addEventListener("click",event=>{
  const card=event.target.closest("[data-capture-id]");
  const action=event.target.closest("[data-action]")?.dataset.action;
  if(!card||!action) return;
  const draft=captureDrafts.find(item=>item.uid===card.dataset.captureId);
  if(!draft) return;
  if(action==="remove-capture"){
    captureDrafts=captureDrafts.filter(item=>item.uid!==draft.uid);
    renderCaptureDrafts();
  }else if(action==="retry-ocr"){
    draft.slotSize=captureSlotSize();
    draft.crop=cropCaptureDraft(draft);
    draft.quantityEdited=false;
    queueQuantityRecognition(draft.uid);
  }else if(action==="select-capture-item"){
    const index=Number(event.target.closest("[data-index]")?.dataset.index);
    if(draft.matches[index]) selectCaptureItem(draft,draft.matches[index]);
  }else if(action==="edit-capture-item"){
    const input=card.querySelector('[data-field="item"]');
    input?.focus();
    input?.select();
    renderCaptureSuggestions(draft,card);
  }else if(action==="review-capture-item"){
    draft.recognition={automatic:false,state:"reviewed",confidence:"reviewed",alternatives:[]};
    renderCaptureDrafts();
  }
});
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
  if(!e.target.closest(".capture-item-search")) document.querySelectorAll(".capture-draft-suggestions").forEach(box=>box.classList.add("hidden"));
});
document.addEventListener("paste",handleCapturePaste);

window.addEventListener("beforeunload",()=>{
  if(captureObjectUrl) URL.revokeObjectURL(captureObjectUrl);
  captureOcrWorker?.terminate?.();
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
  window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js?v=2.7.0").catch(()=>{}));
}

loadSettings();
renderQuickLists();
renderTransportPlanner();
renderView();
itemLoadPromise=loadItems().then(()=>restoreCaptureDraftSession());
