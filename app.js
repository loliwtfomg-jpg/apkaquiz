// Tracker tkanin – Slow Motion (v13-todo)
// Offline-first: zapis w localStorage. Gotowe pod GitHub Pages / Firebase Hosting.

const LS_KEY = "fabric_tracker_state_v14_done";
const LEGACY_KEYS = ["df_slow_tracker_state_v3","df_slow_tracker_state_v2","df_slow_tracker_state_v1"];
const SEED_DATA = JSON.parse(document.getElementById("seed-data").textContent);

const STATUS = {
  TODO: "Do nagrania",
  FIX: "Do poprawy",
  DONE: "Zrobione",
};
const STATUS_LIST = [STATUS.TODO, STATUS.FIX, STATUS.DONE];

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

let state = null;
let collapsedGroups = new Set();   // UI only (nie zapisujemy)
let selectedFid = null;            // UI only (nie zapisujemy)
let lastGroups = [];               // UI only

// Tryb masowych operacji (UI only)
let bulkMode = false;
let selectedFabrics = new Set();            // fid
let selectedColors = new Map();             // fid -> Set(color)

// Historia zmian (undo) – trzymamy w RAM (nie zapisujemy do localStorage)
const HISTORY_MAX = 10;
let historyStack = [];   // {label, undoFn}
let isUndoing = false;

function pushUndo(label, undoFn){
  if(isUndoing) return;
  historyStack.push({label: label || "zmiana", undoFn});
  if(historyStack.length > HISTORY_MAX) historyStack.shift();
  updateUndoButton();
}

function updateUndoButton(){
  const btn = $("#btnUndo");
  if(!btn) return;
  btn.disabled = historyStack.length === 0;
  const last = historyStack[historyStack.length - 1];
  btn.title = historyStack.length ? `Cofnij: ${last.label} (Ctrl+Z)` : "Cofnij (Ctrl+Z)";
}

function undo(){
  const entry = historyStack.pop();
  if(!entry) return;
  isUndoing = true;
  try{ entry.undoFn?.(); }
  finally{ isUndoing = false; }
  saveState(true);
  render();
  updateUndoButton();
  setSaveStatus("cofnięto");
}


let deferredInstallPrompt = null;

// ------------------------- Utils -------------------------

function now(){ return Date.now(); }

function setSaveStatus(t){
  const el = $("#saveStatus");
  if(el) el.textContent = t || "—";
}

function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }

function slugify(s){
  return String(s||"")
    .trim()
    .toLowerCase()
    .replace(/ą/g,"a").replace(/ć/g,"c").replace(/ę/g,"e").replace(/ł/g,"l")
    .replace(/ń/g,"n").replace(/ó/g,"o").replace(/ś/g,"s").replace(/ż/g,"z").replace(/ź/g,"z")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,48) || ("tkanina-" + Math.random().toString(16).slice(2,8));
}

function uniq(arr){
  return Array.from(new Set(arr));
}

function parseColorsInput(raw){
  const s = String(raw||"").trim();
  if(!s) return [];
  const parts = s.split(/[\s,;]+/).filter(Boolean);
  const out = [];
  for(const p of parts){
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
    if(m){
      let a = parseInt(m[1],10), b = parseInt(m[2],10);
      if(Number.isNaN(a) || Number.isNaN(b)) continue;
      if(a>b) [a,b]=[b,a];
      for(let i=a; i<=b; i++) out.push(String(i));
    }else{
      const n = p.replace(/[^\d]/g,"");
      if(n) out.push(String(parseInt(n,10)));
    }
  }
  return uniq(out.filter(Boolean));
}

function compareColor(a,b){
  const na = parseInt(a,10);
  const nb = parseInt(b,10);
  if(Number.isFinite(na) && Number.isFinite(nb)) return na-nb;
  return String(a).localeCompare(String(b), "pl");
}

function groupRank(g){
  // kolejność kolekcji = kolejność w state.groups (nie alfabetycznie)
  const arr = (state?.groups || []);
  const i = arr.indexOf(g);
  return i >= 0 ? i : 9999;
}

function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type: mime || "application/octet-stream"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------- State & migrations -------------------------

function emptyState(){
  return {
    version: 3,
    updatedAt: now(),
    groups: [],
    fabrics: {},   // id -> {id,name,group,createdAt}
    colors: {},    // fabricId -> { "1": "Zrobione", ... }
    prefs: {},
  };
}

function stateFromSeed(seed){
  const st = emptyState();
  st.groups = uniq([...(seed.groups||[])].filter(Boolean));
  for(const f of (seed.fabrics||[])){
    st.fabrics[f.id] = {
      id: f.id,
      name: f.name,
      group: f.group || st.groups[0] || "Kolekcja",
      createdAt: f.createdAt || now(),
    };
  }
  for(const s of (seed.shots||[])){
    const fid = s.fabricId;
    const c = String(s.color||"").trim();
    if(!fid || !c) continue;
    if(!st.colors[fid]) st.colors[fid] = {};
    st.colors[fid][c] = STATUS_LIST.includes(s.status) ? s.status : STATUS.TODO;
  }
  st.updatedAt = now();
  return st;
}

function migrateV1ToV3(old){
  // v1/v2 miały "shots" z dodatkowymi polami (data/link/notatka)
  const st = emptyState();
  st.groups = uniq([...(old.groups||[]), ...(SEED_DATA.groups||[])].filter(Boolean));
  // fabrics
  const fabricsObj = old.fabrics || {};
  for(const id of Object.keys(fabricsObj)){
    const f = fabricsObj[id];
    if(!f?.id) continue;
    st.fabrics[f.id] = {
      id: f.id,
      name: f.name || f.id,
      group: f.group || st.groups[0] || "Kolekcja",
      createdAt: f.createdAt || now(),
    };
  }
  // if fabrics missing (rare), rebuild from shots
  for(const sh of (old.shots||[])){
    if(!st.fabrics[sh.fabricId]){
      st.fabrics[sh.fabricId] = {
        id: sh.fabricId,
        name: sh.fabricName || sh.fabricId,
        group: sh.group || st.groups[0] || "Kolekcja",
        createdAt: sh.createdAt || now(),
      };
    }
  }
  // colors
  for(const sh of (old.shots||[])){
    const fid = sh.fabricId;
    const c = String(sh.color||"").trim();
    if(!fid || !c) continue;
    if(!st.colors[fid]) st.colors[fid] = {};
    st.colors[fid][c] = STATUS_LIST.includes(sh.status) ? sh.status : STATUS.TODO;
  }
  st.updatedAt = now();
  return st;
}

function mergeSeedIntoExisting(seed){
  let changed = false;
  if(!state) return false;

  // groups: append missing, keep seed order
  for(const g of (seed?.groups||[])){
    if(!g) continue;
    if(!state.groups.includes(g)){ state.groups.push(g); changed = true; }
  }

  // fabrics: add missing
  for(const f of (seed?.fabrics||[])){
    if(!f?.id) continue;
    if(!state.fabrics[f.id]){
      state.fabrics[f.id] = {
        id: f.id,
        name: f.name || f.id,
        group: f.group || state.groups[0] || "Kolekcja",
        createdAt: f.createdAt || now(),
      };
      changed = true;
    }
  }

  // colors from shots (do not overwrite existing statuses)
  for(const s of (seed?.shots||[])){
    const fid = s.fabricId;
    const c = String(s.color||"").trim();
    if(!fid || !c) continue;
    ensureFabric(fid);
    ensureColorMap(fid);
    if(state.colors[fid][c] == null){
      state.colors[fid][c] = STATUS_LIST.includes(s.status) ? s.status : STATUS.TODO;
      changed = true;
    }
  }

  return changed;
}

function loadState(){
  // najpierw próbujemy aktualny klucz, potem starsze (żeby nie zgubić danych)
  let usedKey = LS_KEY;
  let raw = localStorage.getItem(LS_KEY);
  if(!raw){
    for(const k of LEGACY_KEYS){
      raw = localStorage.getItem(k);
      if(raw){ usedKey = k; break; }
    }
  }
  if(!raw){
    state = stateFromSeed(SEED_DATA);
    saveState(true);
    return;
  }
  try{
    const parsed = JSON.parse(raw);
    if(parsed?.version === 3 && parsed.fabrics && parsed.colors){
      state = parsed;
      if(usedKey !== LS_KEY) setSaveStatus("wczytano dane ze starszej wersji");
      if(!state.groups) state.groups = [];
      if(!state.fabrics) state.fabrics = {};
      if(!state.colors) state.colors = {};
      if(!state.prefs) state.prefs = {};
      if(!state.media) state.media = {};
      const merged = mergeSeedIntoExisting(SEED_DATA);
      if(merged){ saveState(true); setSaveStatus("uzupełniono listę"); }
      return;
    }
    // fallback: spróbuj migracji z poprzednich wersji (np. v2 z "shots")
    if(parsed && (parsed.shots || parsed.fabrics)){
      state = migrateV1ToV3(parsed);
      saveState(true);
      return;
    }
  }catch(e){
    console.warn("Nie można wczytać stanu, seed…", e);
  }
  state = stateFromSeed(SEED_DATA);
  saveState(true);
}

function saveState(immediate=false){
  state.updatedAt = now();
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  setSaveStatus("zapisano");
  if(immediate) return;
}

const saveDebounced = (() => {
  let t=null;
  return () => {
    setSaveStatus("zapis…");
    clearTimeout(t);
    t = setTimeout(() => saveState(false), 200);
  };
})();

function ensureFabric(fid){
  if(state.fabrics[fid]) return;
  state.fabrics[fid] = {id: fid, name: fid, group: state.groups[0] || "Kolekcja", createdAt: now()};
}
function ensureColorMap(fid){
  if(!state.colors[fid]) state.colors[fid] = {};
}

// ------------------------- Bulk selection (UI) -------------------------

function getSelectedColorSet(fid){
  let set = selectedColors.get(fid);
  if(!set){
    set = new Set();
    selectedColors.set(fid, set);
  }
  return set;
}
function selectedColorsCount(fid){
  const set = selectedColors.get(fid);
  return set ? set.size : 0;
}
function totalSelectedFabrics(){ return selectedFabrics.size; }

function clearSelections(){
  selectedFabrics.clear();
  selectedColors.clear();
}

function toggleSelectFabric(fid){
  if(selectedFabrics.has(fid)) selectedFabrics.delete(fid);
  else selectedFabrics.add(fid);
  render();
}

function toggleSelectColor(fid, color){
  const set = getSelectedColorSet(fid);
  const c = String(color);
  if(set.has(c)) set.delete(c); else set.add(c);
  if(set.size === 0) selectedColors.delete(fid);
  render();
}

function selectAllColors(fid){
  const m = state.colors[fid] || {};
  const set = getSelectedColorSet(fid);
  Object.keys(m).forEach(c => set.add(String(c)));
  render();
}

function clearSelectedColors(fid){
  selectedColors.delete(fid);
  render();
}

function bulkDeleteSelectedColors(fid){
  const set = selectedColors.get(fid);
  if(!set || set.size === 0) return;
  const f = state.fabrics[fid];
  const ok = confirm(`Usunąć ${set.size} zaznaczonych kolorów z tkaniny "${f?.name || fid}"?`);
  if(!ok) return;

  ensureColorMap(fid);

  const deleted = {};
  const deletedMedia = {};
  for(const c of set){
    const key = String(c);
    deleted[key] = state.colors[fid][key];
    const media = (state.media && state.media[fid]) ? state.media[fid][key] : null;
    if(media != null) deletedMedia[key] = media;
  }

  pushUndo(`usuń kolory (${set.size})`, () => {
    ensureColorMap(fid);
    for(const key of Object.keys(deleted)){
      if(deleted[key] != null) state.colors[fid][key] = deleted[key];
    }
    if(Object.keys(deletedMedia).length){
      state.media = state.media || {};
      state.media[fid] = state.media[fid] || {};
      for(const key of Object.keys(deletedMedia)){
        state.media[fid][key] = deletedMedia[key];
      }
    }
  });

  for(const c of set){
    const key = String(c);
    delete state.colors[fid][key];
    if(state.media && state.media[fid]){
      delete state.media[fid][key];
      if(Object.keys(state.media[fid]).length === 0) delete state.media[fid];
    }
  }
  selectedColors.delete(fid);
  saveDebounced();
  render();
}

function bulkSetSelectedColors(fid, status){
  const set = selectedColors.get(fid);
  if(!set || set.size === 0) return;
  ensureFabric(fid);
  ensureColorMap(fid);

  // zapamiętaj poprzednie statusy (tylko zaznaczone)
  const prev = {};
  for(const c of set){
    prev[String(c)] = state.colors[fid][String(c)];
  }

  pushUndo(`status kolorów (${status})`, () => {
    ensureColorMap(fid);
    for(const c of Object.keys(prev)){
      if(prev[c] == null) delete state.colors[fid][c];
      else state.colors[fid][c] = prev[c];
    }
  });

  for(const c of set){
    state.colors[fid][String(c)] = status;
  }
  saveDebounced();
  render();
}

function bulkSetSelectedFabrics(status){
  if(selectedFabrics.size === 0) return;

  // zapamiętaj poprzednie statusy wszystkich kolorów w zaznaczonych tkaninach
  const prev = {};
  for(const fid of selectedFabrics){
    const m = state.colors[fid] || {};
    prev[fid] = {...m};
  }

  pushUndo(`status tkanin (${status})`, () => {
    for(const fid of Object.keys(prev)){
      state.colors[fid] = {...prev[fid]};
    }
  });

  for(const fid of selectedFabrics){
    ensureColorMap(fid);
    for(const c of Object.keys(state.colors[fid])){
      state.colors[fid][c] = status;
    }
  }
  saveDebounced();
  render();
}

function bulkDeleteSelectedFabrics(){
  if(selectedFabrics.size === 0) return;
  const names = Array.from(selectedFabrics).slice(0,6).map(fid => state.fabrics[fid]?.name || fid);
  const more = selectedFabrics.size > 6 ? `… (+${selectedFabrics.size-6})` : "";
  const ok = confirm(`Usunąć ${selectedFabrics.size} zaznaczonych tkanin?
${names.join(", ")} ${more}

Uwaga: usunie też wszystkie ich kolory.`);
  if(!ok) return;

  // backup danych do undo
  const backup = [];
  for(const fid of Array.from(selectedFabrics)){
    backup.push({
      fid,
      fabric: state.fabrics[fid] ? {...state.fabrics[fid]} : null,
      colors: state.colors[fid] ? {...state.colors[fid]} : {},
      media: (state.media && state.media[fid]) ? {...state.media[fid]} : {}
    });
  }

  pushUndo(`usuń tkaniny (${selectedFabrics.size})`, () => {
    for(const b of backup){
      if(!b.fabric) continue;
      state.fabrics[b.fid] = {...b.fabric};
      state.colors[b.fid] = {...b.colors};
      if(Object.keys(b.media).length){
        state.media = state.media || {};
        state.media[b.fid] = {...b.media};
      }
    }
  });

  for(const fid of Array.from(selectedFabrics)){
    delete state.fabrics[fid];
    delete state.colors[fid];
    if(state.media) delete state.media[fid];
    selectedColors.delete(fid);
  }
  selectedFabrics.clear();
  saveDebounced();
  render();
}

function updateBulkToolbar(){
  const btnToggle = $("#btnBulkToggle");
  const btnClear = $("#btnBulkClear");
  const btnDelete = $("#btnBulkDeleteFabrics");

  const bulkSetLabel = $("#bulkSetLabel");
  const btnSetTodo = $("#btnBulkSetTodo");
  const btnSetFix  = $("#btnBulkSetFix");
  const btnSetDone = $("#btnBulkSetDone");

  if(btnToggle){
    btnToggle.textContent = bulkMode ? "Tryb masowy: ON" : "Masowe";
  }
  if(btnClear){
    btnClear.classList.toggle("hidden", !bulkMode);
  }
  if(btnDelete){
    btnDelete.classList.toggle("hidden", !bulkMode);
    btnDelete.textContent = `Usuń tkaniny (${selectedFabrics.size})`;
    btnDelete.disabled = selectedFabrics.size === 0;
  }

  const showBulkSet = bulkMode;
  if(bulkSetLabel) bulkSetLabel.classList.toggle("hidden", !showBulkSet);
  for(const b of [btnSetTodo, btnSetFix, btnSetDone]){
    if(!b) continue;
    b.classList.toggle("hidden", !showBulkSet);
    b.disabled = selectedFabrics.size === 0;
  }

  document.body.classList.toggle("bulkMode", bulkMode);

  updateUndoButton();
}

// ------------------------- Rendering -------------------------

function getFilters(){
  const q = ($("#q")?.value || "").trim().toLowerCase();
  const group = $("#groupFilter")?.value || "";
  const status = $("#statusFilter")?.value || "";
  return {q, group, status};
}

function fabricCounts(fid){
  const m = state.colors[fid] || {};
  const colors = Object.keys(m);
  let done=0, fix=0, todo=0;
  for(const c of colors){
    const s = m[c];
    if(s === STATUS.DONE) done++;
    else if(s === STATUS.FIX) fix++;
    else todo++;
  }
  return {total: colors.length, done, fix, todo};
}

function groupCounts(ids){
  let total=0, done=0, fix=0, todo=0;
  for(const fid of ids){
    const c = fabricCounts(fid);
    total += c.total;
    done += c.done;
    fix  += c.fix;
    todo += c.todo;
  }
  const pct = total ? Math.round((done / total) * 100) : 0;
  return {total, done, fix, todo, pct};
}

function matchesQuery(fid, q){
  if(!q) return true;
  const f = state.fabrics[fid];
  const name = (f?.name || "").toLowerCase();
  if(name.includes(q)) return true;

  // jeśli wpisano numer/fragment numeru, spróbuj dopasować kolor
  if(/\d/.test(q)){
    const m = state.colors[fid] || {};
    for(const c of Object.keys(m)){
      if(String(c).includes(q)) return true;
    }
  }
  return false;
}

function filterFabricIds(){
  const {q, group, status} = getFilters();
  const ids = Object.keys(state.fabrics);
  const out = [];
  for(const fid of ids){
    const f = state.fabrics[fid];
    if(group && f.group !== group) continue;
    if(!matchesQuery(fid, q)) continue;

    if(status){
      const m = state.colors[fid] || {};
      const has = Object.keys(m).some(c => m[c] === status);
      if(!has) continue;
    }
    out.push(fid);
  }
  // sort by group order (state.groups), then name
  out.sort((a,b) => {
    const ga = (state.fabrics[a]?.group||"");
    const gb = (state.fabrics[b]?.group||"");
    if(ga !== gb){
      const ra = groupRank(ga);
      const rb = groupRank(gb);
      if(ra !== rb) return ra - rb;
      return ga.localeCompare(gb, "pl");
    }
    return (state.fabrics[a]?.name||"").localeCompare(state.fabrics[b]?.name||"", "pl");
  });
  return out;
}

function renderFilters(){
  const groupSel = $("#groupFilter");
  const newFabricGroup = $("#newFabricGroup");
  const groups = uniq([...(state.groups||[])]).filter(Boolean);
  if(groups.length === 0) groups.push("Kolekcja");

  // if current group value not present, add
  const current = groupSel?.value || "";
  if(groupSel){
    groupSel.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "Wszystkie";
    groupSel.appendChild(optAll);
    for(const g of groups){
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      groupSel.appendChild(opt);
    }
    if(groups.includes(current) || current==="") groupSel.value = current;
  }

  if(newFabricGroup){
    newFabricGroup.innerHTML = "";
    for(const g of groups){
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      newFabricGroup.appendChild(opt);
    }
  }
}

function renderGroupsEditor(){
  const wrap = $("#groupsList");
  if(!wrap) return;
  wrap.innerHTML = "";
  const groups = uniq([...(state.groups||[])]).filter(Boolean);
  if(groups.length === 0) groups.push("Kolekcja");

  for(const g of groups){
    const row = document.createElement("div");
    row.className = "groupRow";
    row.innerHTML = `
      <input value="${escapeHtml(g)}" data-g="${escapeAttr(g)}" />
      <button class="btn mini ghost" type="button" data-action="setFirstGroup" data-g="${escapeAttr(g)}" title="Ustaw jako pierwszą kolekcję">${g===groups[0] ? "⭐ Pierwsza" : "Na górę"}</button>
      <button class="btn mini" type="button" data-action="saveGroup" data-g="${escapeAttr(g)}">Zapisz</button>
      <button class="btn mini ghost" type="button" data-action="deleteGroup" data-g="${escapeAttr(g)}">Usuń</button>
    `;
    wrap.appendChild(row);
  }
}

function escapeHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
function escapeAttr(s){ return escapeHtml(s); }

function render(){
  renderFilters();
  renderGroupsEditor();
  updateBulkToolbar();

  const list = $("#fabricList");
  if(!list) return;
  list.innerHTML = "";

  const visibleIds = filterFabricIds();
  const groups = uniq(visibleIds.map(fid => state.fabrics[fid]?.group || "Kolekcja"))
    .sort((a,b) => {
      const ra = groupRank(a);
      const rb = groupRank(b);
      if(ra !== rb) return ra - rb;
      return a.localeCompare(b, "pl");
    });

  lastGroups = groups;

  // domyślny wybór (pierwsza widoczna tkanina), żeby prawy panel nie był pusty
  if(selectedFid && !visibleIds.includes(selectedFid)) selectedFid = null;
  if(!selectedFid && visibleIds.length) selectedFid = visibleIds[0];

  for(const g of groups){
    const block = document.createElement("div");
    block.className = "groupBlock";

    const ids = visibleIds.filter(fid => (state.fabrics[fid]?.group || "Kolekcja") === g);
    const totalColors = ids.reduce((acc, fid) => acc + fabricCounts(fid).total, 0);
    const gc = groupCounts(ids);
    const isCollapsed = collapsedGroups.has(g);
    const chevron = isCollapsed ? "▸" : "▾";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "groupHeadBtn";
    head.dataset.action = "toggleGroup";
    head.dataset.group = g;
    head.innerHTML = `
      <div class="groupLeft">
        <div class="groupChevron">${chevron}</div>
        <div>
          <div class="groupTitle">${escapeHtml(g)}</div>
          <div class="groupMeta">${ids.length} tkanin · ${totalColors} kolorów</div>
        </div>
      </div>
      <div class="groupRight">
        <div class="groupDone"><b>${gc.done}</b>/<b>${gc.total}</b> ✓</div>
        <div class="progress group" aria-hidden="true"><div style="width:${gc.pct}%;"></div></div>
      </div>
    `;
    block.appendChild(head);

    if(!isCollapsed){
      for(const fid of ids){
        const f = state.fabrics[fid];
        const counts = fabricCounts(fid);
        const pct = counts.total ? Math.round((counts.done / counts.total)*100) : 0;

        const fabricEl = document.createElement("div");
        fabricEl.className = "fabric";

        const isActive = selectedFid === fid;

        fabricEl.innerHTML = `
          <button class="fabricHeader ${isActive ? "active" : ""}" type="button" data-action="selectFabric" data-fid="${escapeAttr(fid)}">
            ${bulkMode ? `<input class="bulkChk" type="checkbox" data-action="toggleSelectFabric" data-fid="${escapeAttr(fid)}" aria-label="Zaznacz tkaninę" ${selectedFabrics.has(fid) ? "checked" : ""} />` : ""}
            <div class="chev">›</div>
            <div class="fabricName">${escapeHtml(f.name)}</div>
            <div class="fabricCounts">
              <div><b>${counts.done}</b>/<b>${counts.total}</b> zrobione</div>
              <div class="progress" aria-hidden="true"><div style="width:${pct}%;"></div></div>
            </div>
          </button>
        `;

        block.appendChild(fabricEl);
      }
    }

    list.appendChild(block);
  }

  if(groups.length === 0){
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.style.padding = "14px";
    empty.textContent = "Brak wyników dla podanych filtrów.";
    list.appendChild(empty);
  }

  // jeśli zaznaczona tkanina została usunięta
  if(selectedFid && !state.fabrics[selectedFid]) selectedFid = null;
  renderDetails();
}

function renderDetails(){
  const pane = $("#detailPane");
  if(!pane) return;

  if(!selectedFid){
    pane.innerHTML = `
      <div class="detailEmpty">
        <div class="muted">Wybierz tkaninę z listy po lewej, aby zobaczyć kolory po prawej.</div>
        <div class="muted small" style="margin-top:6px;">Tip: możesz użyć wyszukiwarki i filtrów u góry.</div>
      </div>
    `;
    return;
  }

  const f = state.fabrics[selectedFid];
  if(!f){
    selectedFid = null;
    renderDetails();
    return;
  }

  const counts = fabricCounts(selectedFid);
  const pct = counts.total ? Math.round((counts.done / counts.total)*100) : 0;
  const {status: statusFilter} = getFilters();

  pane.innerHTML = `
    <div class="detailTop">
      <div>
        <div class="detailTitle">${escapeHtml(f.name)}</div>
        <div class="detailSub">${escapeHtml(f.group || "Kolekcja")}</div>
      </div>
      <div class="detailCounts">
        <div><b>${counts.done}</b>/<b>${counts.total}</b> zrobione</div>
        <div class="progress" aria-hidden="true"><div style="width:${pct}%;"></div></div>
      </div>
    </div>

    <div class="colorsTools">
      <div class="field">
        <label>Dodaj kolory</label>
        <input class="addColorsInput" data-fid="${escapeAttr(selectedFid)}" placeholder="np. 1-10, 15, 22" />
      </div>
      <button class="btn mini" type="button" data-action="addColors" data-fid="${escapeAttr(selectedFid)}">Dodaj</button>
      <div class="hint">${statusFilter ? `Filtr: <b>${escapeHtml(statusFilter)}</b>` : "Status ustawiasz per kolor."}</div>
      ${bulkMode ? `
        <div class="bulkColorsBar">
          <button class="btn mini ghost" type="button" data-action="selectAllColors" data-fid="${escapeAttr(selectedFid)}">Zaznacz wszystkie kolory</button>
          <button class="btn mini ghost" type="button" data-action="clearSelectedColors" data-fid="${escapeAttr(selectedFid)}">Wyczyść zazn.</button>
          <button class="btn mini danger" type="button" data-action="bulkDeleteSelectedColors" data-fid="${escapeAttr(selectedFid)}">Usuń kolory (${selectedColorsCount(selectedFid)})</button>
          <span class="muted small">Ustaw:</span>
          <button class="statusIcon miniStatus todo" type="button" ${selectedColorsCount(selectedFid)===0 ? "disabled" : ""} data-action="bulkSetSelectedColors" data-fid="${escapeAttr(selectedFid)}" data-status="${escapeAttr(STATUS.TODO)}" title="Ustaw status: do nagrania">✕</button>
          <button class="statusIcon miniStatus fix" type="button" ${selectedColorsCount(selectedFid)===0 ? "disabled" : ""} data-action="bulkSetSelectedColors" data-fid="${escapeAttr(selectedFid)}" data-status="${escapeAttr(STATUS.FIX)}" title="Ustaw status: do poprawy">?</button>
          <button class="statusIcon miniStatus done" type="button" ${selectedColorsCount(selectedFid)===0 ? "disabled" : ""} data-action="bulkSetSelectedColors" data-fid="${escapeAttr(selectedFid)}" data-status="${escapeAttr(STATUS.DONE)}" title="Ustaw status: zrobione">✓</button>
        </div>
      ` : ``}
    </div>

    <div class="colorsTable" data-fid="${escapeAttr(selectedFid)}">
      ${renderColorsTable(selectedFid)}
    </div>

    <div class="detailFoot">
      <button class="btn mini danger" type="button" data-action="deleteFabric" data-fid="${escapeAttr(selectedFid)}">Usuń tkaninę</button>
    </div>
  `;
}

function renderColorsTable(fid){
  const m = state.colors[fid] || {};
  const colorsAll = Object.keys(m).sort(compareColor);
  const {status: statusFilter} = getFilters();
  const colors = statusFilter ? colorsAll.filter(c => m[c] === statusFilter) : colorsAll;

  const selSet = selectedColors.get(fid) || new Set();

  if(colors.length === 0){
    return `<div class="colorRow"><div class="muted small">Brak kolorów do wyświetlenia.</div></div>`;
  }

  const rows = colors.map(c => {
    const s = m[c] || STATUS.TODO;

    const btn = (icon, st, cls) => `
      <button class="statusIcon st ${cls} ${s===st?'active':''}" type="button"
              title="${escapeAttr(st)}"
              aria-label="${escapeAttr(st)}"
              data-action="setStatus"
              data-fid="${escapeAttr(fid)}"
              data-color="${escapeAttr(c)}"
              data-status="${escapeAttr(st)}">${icon}</button>
    `;

    return `
      <div class="colorRow">
        ${bulkMode ? `<input class="bulkChk" type="checkbox" data-action="toggleSelectColor" data-fid="${escapeAttr(fid)}" data-color="${escapeAttr(c)}" aria-label="Zaznacz kolor #${escapeAttr(c)}" ${selSet.has(String(c)) ? "checked" : ""} />` : ""}
        <div class="colorNo">#${escapeHtml(c)}</div>
        <div class="statusBtns">
          ${btn("✕", STATUS.TODO, "todo")}
          ${btn("?", STATUS.FIX, "fix")}
          ${btn("✓", STATUS.DONE, "done")}
        </div>
        <button class="smallBtn" type="button"
                data-action="removeColor"
                data-fid="${escapeAttr(fid)}"
                data-color="${escapeAttr(c)}">Usuń</button>
      </div>
    `;
  }).join("");

  return rows;
}

// ------------------------- Actions -------------------------


function setStatus(fid, color, status){
  ensureFabric(fid);
  ensureColorMap(fid);
  const key = String(color);
  const prev = state.colors[fid][key];
  if(prev === status) return; 

  pushUndo(`status #${key}`, () => {
    ensureColorMap(fid);
    if(prev == null) delete state.colors[fid][key];
    else state.colors[fid][key] = prev;
  });

  state.colors[fid][key] = status;
  saveDebounced();
  render();
}

function addColors(fid, raw){
  const colors = parseColorsInput(raw);
  if(colors.length === 0) return;

  ensureFabric(fid);
  ensureColorMap(fid);

  const addedColors = [];
  for(const c of colors){
    if(state.colors[fid][c]) continue;
    state.colors[fid][c] = STATUS.TODO;
    addedColors.push(String(c));
  }

  if(addedColors.length){
    pushUndo(`dodaj kolory (${addedColors.length})`, () => {
      ensureColorMap(fid);
      for(const c of addedColors){
        delete state.colors[fid][c];
      // (opcjonalnie) usuń powiązane media, jeśli istnieją
      if(state.media && state.media[fid]){
        delete state.media[fid][String(c)];
        if(Object.keys(state.media[fid]).length === 0) delete state.media[fid];
      }
      }
    });
    saveDebounced();
    render();
  }
}

function removeColor(fid, color){
  ensureColorMap(fid);
  const key = String(color);
  const prevStatus = state.colors[fid][key];
  const prevMedia = (state.media && state.media[fid]) ? state.media[fid][key] : null;

  pushUndo(`usuń kolor #${key}`, () => {
    ensureColorMap(fid);
    if(prevStatus != null) state.colors[fid][key] = prevStatus;
    if(prevMedia != null){
      state.media = state.media || {};
      state.media[fid] = state.media[fid] || {};
      state.media[fid][key] = prevMedia;
    }
  });

  delete state.colors[fid][key];
  // usuń ewentualne powiązane media (pozostałość po starszych wersjach)
  if(state.media && state.media[fid]){
    delete state.media[fid][key];
    if(Object.keys(state.media[fid]).length === 0) delete state.media[fid];
  }

  const set = selectedColors.get(fid);
  if(set){
    set.delete(key);
    if(set.size === 0) selectedColors.delete(fid);
  }
  saveDebounced();
  render();
}

function deleteFabric(fid){
  const f = state.fabrics[fid];
  if(!f) return;
  const colorsMap = state.colors[fid] ? {...state.colors[fid]} : {};
  const mediaMap = (state.media && state.media[fid]) ? {...state.media[fid]} : {};
  const count = Object.keys(colorsMap).length;

  const ok = confirm(`Usunąć tkaninę "${f.name}"?
Usunie też ${count} kolorów.`);
  if(!ok) return;

  pushUndo(`usuń tkaninę ${f.name}`, () => {
    state.fabrics[fid] = {...f};
    state.colors[fid] = {...colorsMap};
    if(Object.keys(mediaMap).length){
      state.media = state.media || {};
      state.media[fid] = {...mediaMap};
    }
  });

  delete state.fabrics[fid];
  delete state.colors[fid];
  if(state.media) delete state.media[fid];
  selectedFabrics.delete(fid);
  selectedColors.delete(fid);
  saveDebounced();
  render();
}

function addFabric(name, group){
  const n = String(name||"").trim();
  if(!n) return alert("Podaj nazwę tkaniny.");
  const g = group || state.groups[0] || "Kolekcja";
  if(!state.groups.includes(g)) state.groups.push(g);

  let id = slugify(n);
  // ensure unique
  let i=2;
  while(state.fabrics[id]){ id = `${slugify(n)}-${i++}`; }

  pushUndo(`dodaj tkaninę ${n}`, () => {
    delete state.fabrics[id];
    delete state.colors[id];
    if(state.media) delete state.media[id];
    selectedFabrics.delete(id);
    selectedColors.delete(id);
  });

  state.fabrics[id] = {id, name: n, group: g, createdAt: now()};
  if(!state.colors[id]) state.colors[id] = {};
  saveDebounced();
  render();
}

function setGroupFirst(name){
  const g = String(name||"").trim();
  if(!g) return;
  if(!state.groups.includes(g)) return;

  const prev = [...state.groups];
  pushUndo("kolejność kolekcji", () => { state.groups = [...prev]; });

  state.groups = [g, ...state.groups.filter(x => x !== g)];
  saveDebounced();
  render();
}

function addGroup(name){
  const n = String(name||"").trim();
  if(!n) return alert("Podaj nazwę kolekcji.");
  if(state.groups.includes(n)) return alert("Taka kolekcja już istnieje.");

  const prevGroups = [...state.groups];
  const prevFabricGroups = {};
  for(const fid of Object.keys(state.fabrics)) prevFabricGroups[fid] = state.fabrics[fid].group;

  pushUndo(`dodaj kolekcję ${n}`, () => {
    state.groups = [...prevGroups];
    for(const fid of Object.keys(prevFabricGroups)){
      if(state.fabrics[fid]) state.fabrics[fid].group = prevFabricGroups[fid];
    }
  });

  state.groups.push(n);
  saveDebounced();
  render();
}

function renameGroup(oldName, newName){
  const nn = String(newName||"").trim();
  if(!nn) return alert("Nazwa nie może być pusta.");
  if(oldName === nn) return;
  if(state.groups.includes(nn)) return alert("Taka kolekcja już istnieje.");

  const prevGroups = [...state.groups];
  const prevFabricGroups = {};
  for(const fid of Object.keys(state.fabrics)) prevFabricGroups[fid] = state.fabrics[fid].group;

  pushUndo(`zmień nazwę kolekcji`, () => {
    state.groups = [...prevGroups];
    for(const fid of Object.keys(prevFabricGroups)){
      if(state.fabrics[fid]) state.fabrics[fid].group = prevFabricGroups[fid];
    }
  });

  state.groups = state.groups.map(g => g===oldName ? nn : g);
  // update fabrics
  for(const fid of Object.keys(state.fabrics)){
    if(state.fabrics[fid].group === oldName) state.fabrics[fid].group = nn;
  }
  saveDebounced();
  render();
}

function deleteGroup(name){
  const groups = state.groups.filter(g => g !== name);
  if(groups.length === 0) return alert("Nie możesz usunąć jedynej kolekcji.");

  const fallback = groups[0];
  const affected = Object.values(state.fabrics).filter(f => f.group === name).length;

  const ok = confirm(`Usunąć kolekcję "${name}"?
Tkaniny z tej kolekcji zostaną przeniesione do: "${fallback}".
Liczba tkanin: ${affected}`);
  if(!ok) return;

  const prevGroups = [...state.groups];
  const prevFabricGroups = {};
  for(const fid of Object.keys(state.fabrics)) prevFabricGroups[fid] = state.fabrics[fid].group;

  pushUndo(`usuń kolekcję ${name}`, () => {
    state.groups = [...prevGroups];
    for(const fid of Object.keys(prevFabricGroups)){
      if(state.fabrics[fid]) state.fabrics[fid].group = prevFabricGroups[fid];
    }
  });

  for(const fid of Object.keys(state.fabrics)){
    if(state.fabrics[fid].group === name) state.fabrics[fid].group = fallback;
  }
  state.groups = groups;
  saveDebounced();
  render();
}

function exportJSON(){
  const payload = JSON.stringify(state, null, 2);
  const stamp = new Date().toISOString().slice(0,10);
  downloadFile(`Tracker_Backup_${stamp}.json`, payload, "application/json");
}

function exportCSV(){
  const rows = [];
  rows.push(["Kolekcja","Tkanina","ID","Kolor","Status"].map(csvCell).join(";"));
  for(const fid of Object.keys(state.fabrics)){
    const f = state.fabrics[fid];
    const m = state.colors[fid] || {};
    const colors = Object.keys(m).sort(compareColor);
    for(const c of colors){
      rows.push([f.group, f.name, fid, c, m[c]].map(csvCell).join(";"));
    }
    if(colors.length === 0){
      rows.push([f.group, f.name, fid, "", ""].map(csvCell).join(";"));
    }
  }
  const stamp = new Date().toISOString().slice(0,10);
  downloadFile(`Tracker_${stamp}.csv`, rows.join("\n"), "text/csv;charset=utf-8");
}
function csvCell(v){
  const s = String(v ?? "");
  // Excel PL lubi średniki; i tak zabezpieczamy cudzysłowami
  return `"${s.replaceAll('"','""')}"`;
}

async function importJSON(file){
  if(!file) return alert("Wybierz plik JSON.");
  const text = await file.text();
  let parsed = null;
  try{ parsed = JSON.parse(text); }catch(e){ return alert("To nie jest poprawny JSON."); }

  // akceptujemy v3, lub starsze (migrujemy)
  let next = null;
  if(parsed?.version === 3 && parsed.fabrics && parsed.colors) next = parsed;
  else if(parsed && (parsed.shots || parsed.fabrics)) next = migrateV1ToV3(parsed);
  else return alert("Nie rozpoznaję formatu tego backupu.");

  const ok = confirm("Import zastąpi Twoje aktualne dane w tej przeglądarce. Kontynuować?");
  if(!ok) return;

  state = next;
  if(!state.media) state.media = {};
  saveState(true);
  collapsedGroups = new Set();
  render();
}

function resetToSeed(){
  const ok = confirm("Reset do danych startowych nadpisze bieżące dane. Kontynuować?");
  if(!ok) return;
  state = stateFromSeed(SEED_DATA);
  saveState(true);
  collapsedGroups = new Set();
  render();
}

// ------------------------- Event wiring -------------------------

function wire(){
  $("#q")?.addEventListener("input", () => render());
  $("#groupFilter")?.addEventListener("change", () => render());
  $("#statusFilter")?.addEventListener("change", () => render());

  $("#btnCollapseAll")?.addEventListener("click", () => { collapsedGroups = new Set(lastGroups); render(); });
  $("#btnExpandAll")?.addEventListener("click", () => { collapsedGroups.clear(); render(); });

  // Bulk mode
  $("#btnBulkToggle")?.addEventListener("click", () => {
    bulkMode = !bulkMode;
    if(!bulkMode) clearSelections();
    render();
  });
  $("#btnBulkClear")?.addEventListener("click", () => { clearSelections(); render(); });
  $("#btnBulkDeleteFabrics")?.addEventListener("click", () => bulkDeleteSelectedFabrics());

  // Undo
  $("#btnUndo")?.addEventListener("click", () => undo());
  window.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if(!mod || e.key.toLowerCase() !== "z") return;
    // nie przeszkadzaj w pisaniu w polach tekstowych
    const a = document.activeElement;
    if(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    e.preventDefault();
    undo();
  });

  // Masowa zmiana statusu dla zaznaczonych tkanin
  $("#btnBulkSetTodo")?.addEventListener("click", () => bulkSetSelectedFabrics(STATUS.TODO));
  $("#btnBulkSetFix")?.addEventListener("click", () => bulkSetSelectedFabrics(STATUS.FIX));
  $("#btnBulkSetDone")?.addEventListener("click", () => bulkSetSelectedFabrics(STATUS.DONE));

  // Actions (delegacja)
  // Uwaga: mamy 2 panele (lista po lewej + szczegóły po prawej), więc delegujemy kliknięcia w obu.

  const handleActionClick = (e) => {
    const target = e.target;
    if(!(target instanceof HTMLElement)) return;
    const el = target.closest("[data-action]");
    if(!(el instanceof HTMLElement)) return;

    const action = el.dataset.action;
    if(!action) return;

    if(action === "toggleSelectFabric"){
      const fid = el.dataset.fid;
      if(!fid) return;
      toggleSelectFabric(fid);
      return;
    }

    if(action === "toggleSelectColor"){
      const fid = el.dataset.fid;
      const color = el.dataset.color;
      if(!fid || !color) return;
      toggleSelectColor(fid, color);
      return;
    }

    if(action === "selectAllColors"){
      const fid = el.dataset.fid;
      if(!fid) return;
      selectAllColors(fid);
      return;
    }

    if(action === "clearSelectedColors"){
      const fid = el.dataset.fid;
      if(!fid) return;
      clearSelectedColors(fid);
      return;
    }

    if(action === "bulkDeleteSelectedColors"){
      const fid = el.dataset.fid;
      if(!fid) return;
      bulkDeleteSelectedColors(fid);
      return;
    }

    if(action === "bulkSetSelectedColors"){
      const fid = el.dataset.fid;
      const status = el.dataset.status;
      if(!fid || !status) return;
      bulkSetSelectedColors(fid, status);
      return;
    }

    if(action === "toggleGroup"){
      const g = el.dataset.group;
      if(!g) return;
      if(collapsedGroups.has(g)) collapsedGroups.delete(g); else collapsedGroups.add(g);
      render();
      return;
    }

    if(action === "selectFabric"){
      const fid = el.dataset.fid;
      if(!fid) return;
      selectedFid = fid;
      render();
      return;
    }

    if(action === "setStatus"){
      const fid = el.dataset.fid;
      const color = el.dataset.color;
      const status = el.dataset.status;
      if(fid && color && status) setStatus(fid, color, status);
      return;
    }

    if(action === "removeColor"){
      const fid = el.dataset.fid;
      const color = el.dataset.color;
      if(!fid || !color) return;
      const ok = confirm(`Usunąć kolor #${color} z tkaniny?`);
      if(ok) removeColor(fid, color);
      return;
    }

    if(action === "addColors"){
      const fid = el.dataset.fid;
      if(!fid) return;
      const input = $(`.addColorsInput[data-fid="${CSS.escape(fid)}"]`);
      const raw = input?.value || "";
      addColors(fid, raw);
      if(input) input.value = "";
      return;
    }

    if(action === "deleteFabric"){
      const fid = el.dataset.fid;
      if(!fid) return;
      deleteFabric(fid);
      return;
    }
  };

  $("#fabricList")?.addEventListener("click", handleActionClick);
  $("#detailPane")?.addEventListener("click", handleActionClick);

  // Enter w polu dodawania kolorów
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if(!(t instanceof HTMLElement)) return;
    if(t.classList.contains("addColorsInput") && e.key === "Enter"){
      e.preventDefault();
      const fid = t.dataset.fid;
      if(!fid) return;
      addColors(fid, t.value);
      t.value = "";
    }
  });

  // Backup modal
  const backupModal = $("#backupModal");
  $("#btnBackup")?.addEventListener("click", () => backupModal?.showModal());
  $("#btnExportJson")?.addEventListener("click", exportJSON);
  $("#btnExportCsv")?.addEventListener("click", exportCSV);
  $("#btnImportJson")?.addEventListener("click", async () => {
    const file = $("#importFile")?.files?.[0];
    await importJSON(file);
  });
  $("#btnResetSeed")?.addEventListener("click", resetToSeed);

  // Settings modal
  const settingsModal = $("#settingsModal");
  $("#btnSettings")?.addEventListener("click", () => settingsModal?.showModal());

  $("#btnAddFabric")?.addEventListener("click", () => {
    addFabric($("#newFabricName")?.value, $("#newFabricGroup")?.value);
    const n = $("#newFabricName"); if(n) n.value="";
  });

  $("#btnAddGroup")?.addEventListener("click", () => {
    addGroup($("#newGroupName")?.value);
    const ng = $("#newGroupName"); if(ng) ng.value="";
  });

  $("#groupsList")?.addEventListener("click", (e) => {
    const t = e.target;
    if(!(t instanceof HTMLElement)) return;
    const action = t.dataset.action;
    const g = t.dataset.g;
    if(!action || !g) return;

    if(action === "setFirstGroup"){
      setGroupFirst(g);
      return;
    }

    if(action === "saveGroup"){
      const input = $(`#groupsList input[data-g="${CSS.escape(g)}"]`);
      const newName = input?.value;
      renameGroup(g, newName);
      return;
    }
    if(action === "deleteGroup"){
      deleteGroup(g);
      return;
    }
  });

  // PWA install
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = $("#btnInstall");
    if(btn) btn.classList.remove("hidden");
  });
  $("#btnInstall")?.addEventListener("click", async () => {
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#btnInstall")?.classList.add("hidden");
  });

  // Service worker
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
}

// ------------------------- Boot -------------------------

loadState();
wire();
render();
setSaveStatus("gotowe");
