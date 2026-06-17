// ========== CONFIG ==========
const ENDPOINT_SHEETS      = "/api/sheets";
const ENDPOINT_DATA        = (tab) => `/api/data/${encodeURIComponent(tab)}`;
const MUNICIPIOS_JSON_URL  = "/municipios.json"; // o "/api/municipios"

// Claves reales de tus datos:
const MUNICIPIO_KEY_JSON   = "municipio"; // en municipios.json
const WKT_KEY_JSON         = "poligono";  // en municipios.json
const MUNICIPIO_KEY_SHEET  = "Municipio"; // en tus hojas de Google Sheet

// ========== Estado global ==========
let map, baseLayer;
let polygons = [];                        // L.GeoJSON (uno por municipio)
let polygonByMunicipio = Object.create(null); // key normalizada -> L.GeoJSON
let municipiosRaw = [];                   // arreglo original de municipios.json
let municipiosMap = Object.create(null);  // key normalizada -> objeto municipio (JSON)
let currentTab = null;
let currentMunicipio = null;
let dataCache = new Map();                // tab -> filas (objetos)
let tabs = [];                            // lista de hojas
let lastFilteredRows = []; // guardaremos el último subconjunto filtrado
let partyChartInstance = null;
let _suspendEvents = false;
let filterMode = 'general'; // 'general' | 'coord'
let municipioColorMap = Object.create(null); // key municipio norm -> '#rrggbb'
let currentCoord = null;     // string o null
let currentParty = null;                    // 'morena', 'pri', 'pvem', etc.
const municipioPartyMap = new Map();        // municipio (normalize) -> partyKey
let partyKeysAvailable = new Set();         // partidos presentes en la hoja actual
// Overlay de resaltado por partido (contornos encima de los polígonos)
let partyHighlightGroup = null; // L.FeatureGroup con outlines


// ========== Selectores UI (ajusta IDs si usas otros) ==========
const selHoja = document.getElementById('selHoja');
const selMunicipio = document.getElementById('selMunicipio');

const btnAplicar = document.getElementById('btnAplicar');
const btnLimpiar = document.getElementById('btnLimpiar');
const dataInfo = document.getElementById('dataInfo');
const munInfo  = document.getElementById('munInfo');

const modeGeneral = document.getElementById('modeGeneral');
const modeCoord   = document.getElementById('modeCoord');

const blockCoordinacion = document.getElementById('blockCoordinacion');
const blockHoja = document.getElementById('blockHoja');
const blockMunicipio = document.getElementById('blockMunicipio');

const coordIndex = new Map();
// Columnas a ocultar SIEMPRE (en cualquier hoja)
const HIDDEN_COLS_GLOBAL = new Set(['id'].map(s => normalize(s)));

// Columnas a ocultar POR HOJA (clave = nombre de la hoja normalizado)
const HIDDEN_COLS_PER_TAB = {
  [normalize('Presidentes Municipales')]: new Set(['colores'].map(s => normalize(s))),
};

// Helper: Â¿esta columna debe ocultarse?
function isHiddenColumn(tabName, colName) {
  const ncol = normalize(colName);
  if (HIDDEN_COLS_GLOBAL.has(ncol)) return true;
  const ntab = normalize(tabName || '');
  const per = HIDDEN_COLS_PER_TAB[ntab];
  return per ? per.has(ncol) : false;
}

function initLegendBg() {
  const legend = document.querySelector('#mapPartyLegend .overlay-inner');
  if (!legend) return;
  legend.style.backgroundColor = legend.style.backgroundColor || 'rgba(255, 255, 255, 0.92)';
}

function showAppAlert(message, type = 'warning') {
  const host = document.getElementById('alertHost');
  if (!host) return;

  host.innerHTML = `
    <div class="alert alert-${type} alert-dismissible fade show mb-0" role="alert">
      <i class="bi bi-exclamation-triangle-fill me-2"></i>
      ${escapeHtml(message)}
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Cerrar"></button>
    </div>
  `;

  window.clearTimeout(host._dismissTimer);
  host._dismissTimer = window.setTimeout(() => {
    const alertEl = host.querySelector('.alert');
    if (!alertEl) return;
    bootstrap.Alert.getOrCreateInstance(alertEl).close();
  }, 4500);
}

function clearAppAlert() {
  const host = document.getElementById('alertHost');
  if (!host) return;
  window.clearTimeout(host._dismissTimer);

  const alertEl = host.querySelector('.alert');
  if (alertEl) {
    bootstrap.Alert.getOrCreateInstance(alertEl).close();
    return;
  }

  host.replaceChildren();
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  attachUI();

  await loadSheets();
  await loadMunicipios();

  // <-- AQUI: construye el índice y rellena el select
  await buildCoordIndex();
  populateCoordinacionesFromIndex(); // (si estás en modo coord, quedará habilitado)

  await buildMunicipioColorMapFromPresidentes(); // comentario
  refreshBasePolygonStyles();                     // pinta el mapa con esos colores

  updateButtonState(); // <<--- AQUI
  updateUIForMode(); // inicia en modo General (radio ya marcado)
  dimBasemap(true);
  initLegendBg(); // comentario
});

// ==================== MAPA ====================
function initMap() {
  map = L.map('map', { zoomControl: false });
  baseLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap' }
  ).addTo(map);
  map.setView([19.3, -99.65], 8); // Edomex
}
// Atenuar / restaurar el mapa base (no afecta polígonos)
function dimBasemap(on = true) {
  if (!baseLayer || !baseLayer.setOpacity) return;
  baseLayer.setOpacity(on ? 0.15 : 1);
}

// Opacidades estándar
const FILL_OPACITY_DEFAULT = 0.90;  // normal
const FILL_OPACITY_DIMMED  = 0.20;  // atenuado (no seleccionado)
const FILL_OPACITY_FOCUS   = 0.78;  // enfocado/seleccionado

function baseFillColorFor(feature){
  const nom = feature?.properties?.municipio || '';
  const key = normalize(nom);
  return municipioColorMap[key] || '#ee82ee'; // comentario
}

function polyDefaultStyle(feature) {
  return {
    color: '#ffffff',               // borde neutro
    weight: 1,
    opacity: 0.5,
    fillColor: baseFillColorFor(feature),
    fillOpacity: FILL_OPACITY_DEFAULT
  };
}

function polyHoverStyle(feature) {
  const base = polyDefaultStyle(feature);
  return { ...base, weight: 2, fillOpacity: Math.min(base.fillOpacity + 0.10, 0.80) };
}

function polyHighlightStyle(feature) {
  const base = polyDefaultStyle(feature);
  return { ...base, color:'#ffffff', weight: 3, fillOpacity: FILL_OPACITY_FOCUS };
}

function polyDimStyle(feature) {
  const base = polyDefaultStyle(feature);
  return { ...base, color:'#ffffff', opacity:0.7, fillOpacity: FILL_OPACITY_DIMMED };
}

function coordKeyFrom(value) {
  return normalize(value || '');
}

function getCoordEntry(value) {
  const key = coordKeyFrom(value);
  return key ? coordIndex.get(key) : null;
}

function coordDisplayName(value) {
  const entry = getCoordEntry(value);
  return entry?.name || String(value || '');
}

// Reaplicar estilos base a todo (cuando limpias filtros, etc.)
// Si tienes coordIndex (modo coordinación), esto ayuda a saber quién se atenúa:
// Devuelve true si el municipio (keyNorm) pertenece a la coordinación activa
function belongsToActiveCoord(keyNorm) {
  if (filterMode !== 'coord') return true;           // en modo general hay hover normal
  if (!currentCoord) return false;                   // sin coordinación activa
  const coordKey = normalize(currentCoord); // comentario
  const entry = getCoordEntry(currentCoord);
  if (!entry || !entry.municipios) return false;
  return entry.municipios.has(keyNorm); // comentario
}

// Atenuar si NO pertenece a la coordinación activa (usa misma lógica)
function isDimmedByCoord(keyNorm) {
  if (filterMode !== 'coord') return false;
  if (!currentCoord) return false;
  const coordKey = normalize(currentCoord);
  const entry = getCoordEntry(currentCoord);
  if (!entry || !entry.municipios) return false;
  return !entry.municipios.has(keyNorm);
}
function setLayerBaseStyle(lyr, styleObj) {
  lyr._baseStyleCurrent = styleObj;
  lyr.setStyle(styleObj);
}

// Decide qué estilo va para un municipio (clave normalizada)
function styleForKey(keyNorm, feature) {
  if (currentMunicipio && normalize(currentMunicipio) === keyNorm) {
    return polyHighlightStyle(feature); // foco por municipio
  }
  if (isDimmedByCoord(keyNorm)) {
    return polyDimStyle(feature);       // atenuado por coordinación
  }
  if (currentParty && !(municipioPartyMap.get(keyNorm) || []).includes(currentParty)) {
    return polyDimStyle(feature);
  }
  return polyDefaultStyle(feature);     // normal
}

// Reaplica estilos base/contexto a TODO
function refreshBasePolygonStyles() {
  polygons.forEach(g => {
    g.eachLayer && g.eachLayer(l => {
      const name = l?.feature?.properties?.municipio || '';
      const key  = normalize(name);
      const st   = styleForKey(key, l.feature); // default / dim / highlight
      setLayerBaseStyle(l, st); // comentario
    });
  });
}

function focusMunicipio(nombre) {
  currentMunicipio = nombre || null;
  refreshBasePolygonStyles();
  // centra si existe
  const lyr = polygonByMunicipio[ normalize(nombre) ];
  if (lyr?.getBounds) map.fitBounds(lyr.getBounds(), { padding: [28, 28] });
  if (lyr?.bringToFront) lyr.bringToFront();
}

// ==================== CARGAS ====================
async function loadSheets() {
  const r = await fetch(ENDPOINT_SHEETS);
  const j = await r.json();
  tabs = j?.tabs || [];
  selHoja.innerHTML = '<option value="" disabled selected>Selecciona categoría…</option>';
  for (const t of tabs) {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    selHoja.appendChild(opt);
  }
    // === NUEVO: fuerza que quede seleccionada la opción placeholder (índice 0)
  selHoja.selectedIndex = 0;

// comentario
  updateButtonState();
}

async function loadMunicipios() {
  const r = await fetch(MUNICIPIOS_JSON_URL);
  municipiosRaw = await r.json();

  // Index por nombre normalizado y llena combo
  selMunicipio.innerHTML = '<option value="" disabled selected>Selecciona un municipio…</option>';
  const nombres = [];
  municipiosRaw.forEach(m => {
    const nombre = m[MUNICIPIO_KEY_JSON];
    if (!nombre) return;
    const key = normalize(nombre);
    municipiosMap[key] = m;
    nombres.push(nombre);
  });
  nombres.sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}));
  for (const n of nombres) {
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    selMunicipio.appendChild(opt);
  }

  // === NUEVO: habilita y asegura placeholder activo
  selMunicipio.disabled = false;
  selMunicipio.removeAttribute('disabled'); // extra seguro
  selMunicipio.selectedIndex = 0;           // placeholder (índice 0)

  // Dibuja todos los polígonos una sola vez
  drawAllPolygons();

// comentario
  setTimeout(updateButtonState, 0);
}
  
function drawAllPolygons() {
  // limpia anteriores
  polygons.forEach(p => map.removeLayer(p));
  polygons = [];
  polygonByMunicipio = Object.create(null);

  const layers = [];
  for (const m of municipiosRaw) {
    const nombre = m[MUNICIPIO_KEY_JSON];
    const wkt    = m[WKT_KEY_JSON];
    if (!nombre || !wkt) continue;

    let geo = wellknown.parse(wkt);
    if (!geo) continue;
    if (shouldSwapXY(geo)) geo = swapXYGeom(geo);

    const feature = {
      type: "Feature",
      properties: {
        municipio: nombre,
        cve_entidad: m.cve_entidad ?? null,
        cve_municipio: m.cve_municipio ?? null
      },
      geometry: geo
    };

    const layer = L.geoJSON(feature, {
// comentario
      style: polyDefaultStyle,
      onEachFeature: (feat, lyr) => {
        const nom = feat?.properties?.municipio || '—';
        const key = normalize(nom);

        lyr.bindTooltip(nom, { sticky: true });

        lyr.on('click', async () => {
          const nom = feat?.properties?.municipio || '—';
          if (filterMode === 'coord' && currentCoord && !belongsToActiveCoord(key)) {
            showAppAlert('Ese municipio no pertenece a la coordinación seleccionada.');
            return;
          }

          // --- flujo normal ---
          selMunicipio.value = nom;
          currentMunicipio = nom;
          if (selMunicipio.selectedIndex < 0) {
            for (let i=0;i<selMunicipio.options.length;i++){
              if (selMunicipio.options[i].textContent.trim() === nom.trim()){
                selMunicipio.selectedIndex = i; break;
              }
            }
          }
          selMunicipio.dispatchEvent(new Event('change', { bubbles:true }));

          if (selHoja.selectedIndex > 0) {
            await applyFilters();
          } else if (filterMode === 'coord') {
            focusMunicipio?.(nom);
          } else {
            showAppAlert('Selecciona una capa para abrir el popup con información del municipio.');
            resaltarMunicipio(nom);
          }
        });

        // HOVER: en coordinación solo reaccionan los que pertenecen a _coordTargets
        lyr.on('mouseover', () => {
          const isCoordMode = (filterMode === 'coord' && currentCoord);
          const belongs = isCoordMode
            ? (window._coordTargets && window._coordTargets.has(key)) // comentario
            : true; // en modo general sí hay hover

          if (!belongs) return;

          const opt = lyr.options || {};
          // guarda estilo previo exacto
          lyr._prevStyle = {
            color: opt.color,
            weight: opt.weight,
            opacity: opt.opacity,
            fillColor: opt.fillColor,
            fillOpacity: opt.fillOpacity
          };
          // sube borde/opacidad SIN cambiar fillColor
          lyr.setStyle({
            color: opt.color,
            weight: Math.min((opt.weight || 1) + 1, 5),
            opacity: opt.opacity,
            fillColor: opt.fillColor,
            fillOpacity: Math.min((opt.fillOpacity ?? FILL_OPACITY_DEFAULT) + 0.10, 0.95)
          });
        });

        lyr.on('mouseout', () => {
          if (lyr._prevStyle) {
            lyr.setStyle(lyr._prevStyle);
            lyr._prevStyle = null;
          } else {
            lyr.setStyle(styleForKey(key, lyr.feature));
          }
        });
      }
    }).addTo(map);

    polygons.push(layer);
    polygonByMunicipio[ normalize(nombre) ] = layer;
    layers.push(layer);
  }

  // Ajusta vista
  if (layers.length) {
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds(), { padding: [20, 20] });
  }
}

// ==================== UI & FILTROS ====================
// URL del Web App (deploy de Apps Script: .../exec)
const GAS_REPORT_URL = 'https://script.google.com/macros/s/AKfycby3eTIm3pwV5mbWh4n_qK-ucbogaLfeR_M4L-bNyQlbuwp9p8tNvMuDddhKtdj4r3Sx/exec';

document.getElementById('btnReporte').addEventListener('click', () => {
  const hoja = selHoja?.value;
  if (!hoja) return;

  const params = new URLSearchParams({ hoja });

  // Si quieres que respete el municipio seleccionado (opcional):
  if (selMunicipio?.value) params.set('municipio', selMunicipio.value);

  window.open(`${GAS_REPORT_URL}?${params.toString()}`, '_blank');
});



function normalizeColName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
function getPhotoColumn(rows){
  if(!rows?.length) return null;
  const keys = Object.keys(rows[0]);
  if (keys.includes('Foto')) return 'Foto';
  for(const k of keys) if (normalizeColName(k).includes('foto') || normalizeColName(k).includes('imagen')) return k;
  return null;
}
function getNameColumn(rows){
  if(!rows?.length) return null;
  const keys = Object.keys(rows[0]);
  if (keys.includes('Nombre')) return 'Nombre';
  for(const k of keys) if (normalizeColName(k).includes('nombre')) return k;
  return null;
}
function isPresidentesTab(tab){
  const n = normalizeColName(tab);
  return n.includes('presidente') || n.includes('presidentes') || n.includes('presidentesmunicipales');
}

// Drive: obtener URL directa
function extractDriveId(u){
  if(!u) return null;
  let m = u.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);    if(m) return m[1];
  m = u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);            if(m) return m[1];
  m = u.match(/\/uc\?.*?[?&]id=([a-zA-Z0-9_-]{10,})/);   if(m) return m[1];
  m = u.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]{10,})/); if(m) return m[1];
  return null;
}
function toDirectImageUrl(u){
  if(!u) return '';
  if(/lh3\.googleusercontent\.com\/d\//.test(u)) return u;
  const id = extractDriveId(u);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w800` : u;
}
// Encuentra la columna "Coordinación" con tolerancia
function getCoordColumn(rows) {
  if (!rows?.length) return null;
  const keys = Object.keys(rows[0]);

  // Coincidencias exactas más típicas
  if (keys.includes('Coordinación')) return 'Coordinación';
  if (keys.includes('Coordinacion')) return 'Coordinacion';

  // Búsqueda flexible (COORDINACION / coordinación / coordinacion / etc.)
  for (const k of keys) {
    const nk = normalizeColName(k); // ej. "coordinación"
    if (nk.includes('coordinación')) return k;
  }
  return null;
}
// Detecta columna de "Partido" con variantes (Partido, Partido Político/Politico, etc.)
function getPartyColumn(rows) {
  if (!rows || !rows.length) return null;
  const keys = Object.keys(rows[0]);

  // Prioriza nombres comunes exactos
  const preferred = ["Partido Político", "Partido Politico", "Partido"];
  for (const p of preferred) if (keys.includes(p)) return p;

  // Búsqueda flexible
  for (const k of keys) {
    const nk = normalizeColName(k);   // ej: "partidopolitico"
    if (nk.includes('partido')) return k;
  }
  return null;
}
/*colores mapa hoja presidente*/
function getColorColumn(rows){
  if(!rows?.length) return null;
  const keys = Object.keys(rows[0]);
  if (keys.includes('Colores')) return 'Colores';
  if (keys.includes('Color')) return 'Color';
  for (const k of keys) if (normalizeColName(k).includes('color')) return k;
  return null;
}
function isHexColor(s){
  return /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(String(s||'').trim());
}
function colorFromParty(p){
  if(!p) return null;
  const dict = window.PARTY_COLORS || {};   // <- evita ReferenceError
  const k = normalizeColName(p);
  for (const key in dict) {
    if (k === key || k.includes(key)) return dict[key];
  }
  return null;
}
// Al activar coordinación:
function colorByCoordFromIndex(coordName) {
// comentario
  const coordKey = coordKeyFrom(coordName || currentCoord || '');
  currentCoord = coordKey || null;

  const entry = getCoordEntry(coordKey);
  // set accesible para hover (bloquear municipios fuera)
  window._coordTargets = entry ? entry.municipios : null;

  if (!entry) {
    refreshBasePolygonStyles(); // pinta todo normal si no hay entrada
    return;
  }

  const targets = entry.municipios; // Set de keys normalizadas
  const bounds = [];

  // Recorre TODOS los municipios ya normalizados
  Object.keys(polygonByMunicipio).forEach(key => {
    const group = polygonByMunicipio[key];
    if (!group) return;

    const isTarget = targets.has(key);

    // Aplica estilo a CADA subcapa
    group.eachLayer(l => {
      // Si ya elegiste Hoja: targets con color del sheet (polyDefaultStyle), otros atenuados
      // Si aún NO elegiste Hoja: puedes dejarlo igual, o poner un uniforme en targets (descomenta la línea de fillColor si quieres rosa uniforme previo a Hoja)
      const st = isTarget
        ? polyDefaultStyle(l.feature) // comentario
// comentario
        : polyDimStyle(l.feature); // comentario

      l.setStyle(st); // si usas setLayerBaseStyle(l, st), mejor para hover, pero no es obligatorio si ya usas _prevStyle en onEachFeature
    });

    if (isTarget) {
      try { bounds.push(group.getBounds()); } catch(_) {}
    }
  });

  if (bounds.length) {
    let union = L.latLngBounds(bounds[0]);
    for (let i = 1; i < bounds.length; i++) union.extend(bounds[i]);
    map.fitBounds(union, { padding: [24,24] });
  }
}
// Muestra/oculta el contenedor de la gráfica
function setPartyBoxVisible(on) {
  const box = document.getElementById('partyChartBox');
  if (!box) return;
  if (on) box.classList.remove('d-none');
  else box.classList.add('d-none');
}

// Dibuja/actualiza la gráfica de partidos a partir de TODAS las filas de la hoja
// Llama: renderPartyChart(rows) donde 'rows' = j.rows de /api/data/:tab (completo, sin filtrar)
function renderPartyChart(rows) {
  const box = document.getElementById('partyChartBox');
  const canvas = document.getElementById('partyChart');
  const hint = document.getElementById('partyChartHint');

  // Oculta si no hay columna de partido
  const col = getPartyColumn(rows);
  if (!col || !rows?.length || !canvas) {
    if (box) box.classList.add('d-none');
    if (hint) hint.textContent = '';
    if (partyChartInstance) { partyChartInstance.destroy(); partyChartInstance = null; }
    return;
  }

  // Conteo por partido
  const counts = new Map();
  rows.forEach(r => {
    const raw = r[col];
    if (!raw) return;
    const key = partyKeyFrom(raw);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const labels = [];
  const data = [];
  const bg = [];
  let total = 0;

  for (const [key, count] of counts.entries()) {
    labels.push(key.toUpperCase());
    data.push(count);
    bg.push(partyColor(key)); // comentario
    total += count;
  }

  // Crear/actualizar Chart.js
  const ctx = canvas.getContext('2d');
  if (partyChartInstance) partyChartInstance.destroy();
  partyChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: bg,
        borderWidth: 0
      }]
    },
    options: {
      cutout: '58%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const count = ctx.parsed;
              const pct = total ? (count / total * 100) : 0;
              return ` ${ctx.label}: ${count} (${pct.toFixed(1)}%)`;
            }
          }
        }
      }
    }
  });

  // Mostrar contenedor + hint
  if (box) box.classList.remove('d-none');
  if (hint) hint.textContent = `Total: ${total}`;
}
async function buildCoordIndex() {
  coordIndex.clear();
  if (!Array.isArray(tabs) || tabs.length === 0) {
    console.warn('[coordIndex] No hay tabs aún.');
    return;
  }

  for (const tab of tabs) {
    try {
      const rows = await getRowsForTab(tab);
      if (!rows.length) continue;

      const colC = getCoordColumn(rows);
      if (!colC) {
        console.warn(`[coordIndex] La hoja "${tab}" NO tiene columna "Coordinación". Claves:`, Object.keys(rows[0]));
        continue;
      }

      for (const r of rows) {
        const coord = String(r[colC] ?? '').trim();
        const coordKey = coordKeyFrom(coord);
        const muni  = String(r[MUNICIPIO_KEY_SHEET] ?? '').trim();
        if (!coord || !muni) continue;         // ignora vacíos

        const muniKey = normalize(muni);
        if (!coordIndex.has(coordKey)) {
          coordIndex.set(coordKey, { name: coord, tabs:new Set(), municipios:new Set(), municipiosByTab:new Map() });
        }
        const entry = coordIndex.get(coordKey);
        if (!entry.name && coord) entry.name = coord;
        entry.tabs.add(tab);
        entry.municipios.add(muniKey);

        let s = entry.municipiosByTab.get(tab);
        if (!s) { s = new Set(); entry.municipiosByTab.set(tab, s); }
        s.add(muniKey);
      }
    } catch (err) {
      console.error(`[coordIndex] Falló lectura de "${tab}":`, err);
    }
  }

  console.debug('[coordIndex] Coordinaciones detectadas:', [...coordIndex.keys()]);
}

// rows: todas las filas de la hoja que uses para construir el índice (cualquiera que tenga la columna "Coordinación")
function buildCoordIndexFromRows(rows) {
  coordIndex.clear();
  const colC = getCoordColumn(rows); // "Coordinación" o como se llame en tus hojas

  rows.forEach(r => {
    const coordName = String(r[colC] || '').trim();
    const coordKey = coordKeyFrom(coordName);
    const muniKey  = normalize(r[MUNICIPIO_KEY_SHEET] || '');
    if (!coordKey || !muniKey) return;

    let entry = coordIndex.get(coordKey);
    if (!entry) {
      entry = { name: coordName, tabs: new Set(), municipios: new Set(), municipiosByTab: new Map() };
      coordIndex.set(coordKey, entry);
    }
    if (!entry.name && coordName) entry.name = coordName;
    entry.municipios.add(muniKey); // comentario
  });
}

function hasEnabledValue(sel) {
  return !!(sel && !sel.disabled && sel.value && String(sel.value).trim() !== '');
}
function updateButtonState() {
  if (document.getElementById('modeCoord')?.checked)   filterMode = 'coord';
  if (document.getElementById('modeGeneral')?.checked) filterMode = 'general';
  // Habilita el botón cuando haya hoja seleccionada (en tu updateButtonState)
  if (btnReporte) btnReporte.disabled = !(selHoja && selHoja.value);

  const hasTab   = hasEnabledValue(selHoja);
  const hasMun   = hasEnabledValue(selMunicipio);
  const hasCoord = hasEnabledValue(selCoordinacion);

  if (filterMode === 'general') {
    btnAplicar.disabled = !(hasTab && hasMun);
  } else {
    btnAplicar.disabled = !hasCoord; // capa y municipio son opcionales en modo coordinación
  }
}
//Utilidad para (re)crear el overlay
function ensurePartyHighlightGroup() {
  if (partyHighlightGroup) return partyHighlightGroup;
  partyHighlightGroup = L.featureGroup([], { interactive: false });
  partyHighlightGroup.addTo(map);
  return partyHighlightGroup;
}

function clearPartyHighlight() {
  if (partyHighlightGroup) {
    partyHighlightGroup.clearLayers();
  }
}
function updatePartyHighlight(pKey) {
  ensurePartyHighlightGroup();
  clearPartyHighlight();
  if (!pKey) return; // comentario

  // Recorre todos los municipios y, si pertenecen al partido, agrega outline
  Object.entries(polygonByMunicipio).forEach(([keyNorm, lyr]) => {
    const pks = municipioPartyMap.get(keyNorm) || [];
    if (!pks.includes(pKey) || !lyr) return;

    // 1) Versión simple: un contorno sutil
    const gj = lyr.toGeoJSON();
    const outline = L.geoJSON(gj, {
      interactive: false,
      style: {
        color: '#00D1FF',     // azul suave (cámbialo si quieres)
        weight: 3,            // grosor
        opacity: 0.9,
        fillOpacity: 0        // sin relleno
      }
    });

    // 2) (Opcional) Halo: un trazo ancho semitransparente debajo + el fino encima
    const halo = L.geoJSON(gj, {
      interactive: false,
      style: {
        color: '#ffffff',
        weight: 8,
        opacity: 0.18,
        fillOpacity: 0
      }
    });

    halo.addTo(partyHighlightGroup);
    outline.addTo(partyHighlightGroup);
  });

  // Trae el overlay al frente para que se vea claro
  partyHighlightGroup.bringToFront?.();
}
function attachUI() {
  selHoja.addEventListener('change', async () => {
      if (_suspendEvents) return;

    currentTab = selHoja.value || null;
    if (currentTab) clearAppAlert();
    await buildPartyIndexForTab(currentTab);  // índice municipio->partido y set de keys
    currentParty = null;                      // reset filtro
    renderPartyChips();                       // pinta chips disponibles
    refreshBasePolygonStyles();               // reaplica estilos
    updatePartyHighlight?.(null); // limpiar halo

    if (filterMode === 'coord') {
// comentario
        updateMunicipiosForCurrentCoordAndTab(selCoordinacion.value, currentTab);

// comentario
        selMunicipio.disabled = false;

        // Mantén el patrón de color por coordinación
        if (selCoordinacion.selectedIndex > 0) colorByCoordFromIndex(selCoordinacion.value);
      }

      updateButtonState();
      setTimeout(updateButtonState, 0);

      // (opcional) resetear municipio y limpiar UI al cambiar de hoja
      if (selMunicipio) {
        selMunicipio.selectedIndex = 0;
        currentMunicipio = null;
        munInfo && (munInfo.textContent = "—");
        dataInfo && (dataInfo.innerHTML = "Selecciona un municipio.");
        map?.closePopup && map.closePopup();
        polygons.forEach(p => refreshBasePolygonStyles());
      }

// comentario
      if (currentTab) {
        let rows = dataCache.get(currentTab);
        if (!rows) {
          const r = await fetch(ENDPOINT_DATA(currentTab));
          const j = await r.json();
          rows = j?.rows || [];
          dataCache.set(currentTab, rows);
        }
        if (typeof renderPartyChart === 'function') {
          renderPartyChart(rows);
        }
        // o si usas la genérica:
        // renderSummaryChart?.(rows);
      } else {
        // sin hoja -> oculta gráfica de partidos si la tienes
        if (typeof setPartyBoxVisible === 'function') setPartyBoxVisible(false);
      }

      if (_suspendEvents) return;
        currentTab = selHoja.value || null;
        updateButtonState();

        if (filterMode === 'coord') {
// comentario
          updateMunicipiosForCurrentCoordAndTab(selCoordinacion.value, currentTab);

          // (opcional) pinta gráfica global de la hoja
          if (currentTab && typeof renderPartyChart === 'function') {
            const rows = await getRowsForTab(currentTab);
            renderPartyChart(rows);
          }
        }
    });
  selCoordinacion.addEventListener('change', () => {
    if (_suspendEvents || filterMode !== 'coord') return;

    currentCoord = selCoordinacion.value || null;
    currentTab = null;

    // Rellena listas filtradas por coordinación
    populateDependentsForCoord(currentCoord);
    selHoja.disabled = false;
    selMunicipio.selectedIndex = 0;
    currentMunicipio = null;

    // Colorear patrón por coordinación (mantiene colores oficiales)
    colorByCoordFromIndex(currentCoord);

    updateButtonState();
  });
  selMunicipio.addEventListener('change', () => {
    if (_suspendEvents) return;
    currentMunicipio = selMunicipio.value || null;
    updateButtonState();
  });
  selMunicipio.addEventListener('input', updateButtonState); // defensa extra

  modeGeneral.addEventListener('change', () => {
    if (!modeGeneral.checked) return;
    filterMode = 'general';
    updateUIForMode();
  });

async function onSwitchToGeneralMode() {
  filterMode = 'general';
  document.body.classList.remove('is-coord-mode');
  _suspendEvents = true;

  fullResetState();

  // UI: ocultar coordinación, habilitar selects globales
  blockCoordinacion.classList.add('d-none');

  populateTabsAll?.();
  populateMunicipiosAll?.();

  selCoordinacion.selectedIndex = 0;
  selCoordinacion.disabled = true;

  selHoja.disabled = false;
  selMunicipio.disabled = false;

  clearChartsAndInfo();
  if (dataInfo) dataInfo.textContent = 'Selecciona una hoja y un municipio.';

  resetMapVisual();

  _suspendEvents = false;
  updateButtonState();
}

// listener del radio
  modeGeneral.addEventListener('change', () => {
    if (!modeGeneral.checked) return;
    onSwitchToGeneralMode();
  });
  async function onSwitchToCoordMode() {
    filterMode = 'coord';
    document.body.classList.add('is-coord-mode');
    _suspendEvents = true;

    fullResetState();

    // UI: mostrar bloque de coordinación, y deshabilitar dependientes
    blockCoordinacion.classList.remove('d-none');
    blockHoja.classList.remove('d-none');
    blockMunicipio.classList.remove('d-none');

    selCoordinacion.selectedIndex = 0;
    selCoordinacion.disabled = false;

    selHoja.selectedIndex = 0;
    selHoja.disabled = true;

    selMunicipio.selectedIndex = 0;
    selMunicipio.disabled = true;

    // repoblar coordinaciónes
    await buildCoordIndex?.();
    populateCoordinacionesFromIndex?.();

    clearChartsAndInfo();
    if (dataInfo) dataInfo.textContent = 'Selecciona una coordinación.';

    resetMapVisual();

    _suspendEvents = false;
    updateButtonState();
  }

  // listener del radio
  modeCoord.addEventListener('change', () => {
    if (!modeCoord.checked) return;
    onSwitchToCoordMode();
  });
  btnAplicar.addEventListener('click', () => {
    // fuerza sincronización desde el DOM antes de aplicar
    currentTab = selHoja.value || null;
    currentMunicipio = selMunicipio.value || null;
    clearPartyHighlight?.();
    applyFilters();
  });

  btnLimpiar.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resetAll();
    refreshBasePolygonStyles();
    clearPartyHighlight?.();
  });
  /*MODAL ABRIR MODAL Y PINTAR*/
  document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-ver-mas');
  if (!btn) return;

  const hoja = btn.getAttribute('data-hoja');
  const municipio = btn.getAttribute('data-municipio');

  // Trae toda la hoja (cache) y filtra por municipio
  const rows = await getRowsForTab(hoja);
  const fil  = rows.filter(r => normalize(r[MUNICIPIO_KEY_SHEET]) === normalize(municipio));
    openInfoModal(hoja, municipio, fil);
  });
  // Delegación de eventos para chips
  document.getElementById('partyChips')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.party-chip');
    if (!chip) return;

    const pKey = chip.dataset.party || '';
    await applyPartyFilter(pKey);
  });

  document.getElementById('mapPartyLegend')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.party-dock-btn[data-party]');
    if (!btn) return;
    await applyPartyFilter(btn.dataset.party || '');
  });

  // Botón Limpiar (quitar filtro de partido)
  document.getElementById('btnPartyClear')?.addEventListener('click', async () => {
    currentParty = null;
    refreshBasePolygonStyles();
    renderPartyChips();
    syncPartyDockState();
    clearPartyHighlight?.();
    // Si quieres devolver la tabla a la hoja completa:
    if (selHoja.value) {
      const rows = await getRowsForTab(selHoja.value);
      renderDataTable(rows, selHoja.value);
      renderPartyChart?.(rows);
    }
  });
}
/*FUNCION PARA ABRIR EL MODAL*/
function iconForField(fieldName) {
  const key = normalize(fieldName);
  if (key.includes('nombre')) return 'bi-person-badge';
  if (key.includes('cargo') || key.includes('puesto')) return 'bi-briefcase';
  if (key.includes('partido')) return 'bi-award';
  if (key.includes('facebook')) return 'bi-facebook';
  if (key.includes('instagram')) return 'bi-instagram';
  if (key.includes('telefono') || key.includes('telefonico') || key.includes('celular') || key.includes('whatsapp')) return 'bi-telephone';
  if (key.includes('correo') || key.includes('email')) return 'bi-envelope';
  if (key.includes('grado') || key.includes('estudios') || key.includes('escolaridad') || key.includes('academico')) return 'bi-mortarboard';
  if (key.includes('cumpleanos') || key.includes('nacimiento') || key.includes('fecha de nacimiento')) return 'bi-cake2';
  if (key.includes('direccion') || key.includes('domicilio')) return 'bi-geo-alt';
  if (key.includes('coordinación')) return 'bi-diagram-3';
  if (key.includes('municipio')) return 'bi-map';
  if (key.includes('foto') || key.includes('imagen')) return 'bi-image';
  return 'bi-info-circle';
}

function renderDetailItem(key, value) {
  const partyIcons = getPartyColumn([{ [key]: value }]) ? renderPartyIcons(value, { compact: true }) : '';
  return `
    <div class="detail-item">
      <div class="detail-icon"><i class="bi ${iconForField(key)}"></i></div>
      <div class="detail-copy">
        <div class="k">${escapeHtml(key)}</div>
        <div class="v">${autoFormat(value, key) || '<span class="text-muted">Sin dato</span>'}</div>
        ${partyIcons}
      </div>
    </div>
  `;
}

function renderDetailBadges(hoja, municipio, total) {
  return `
    <div class="detail-badges">
      <span class="badge text-bg-primary"><i class="bi bi-layers me-1"></i>${escapeHtml(hoja)}</span>
      <span class="badge text-bg-light"><i class="bi bi-map me-1"></i>${escapeHtml(municipio)}</span>
      <span class="badge text-bg-secondary"><i class="bi bi-list-check me-1"></i>${total} registro${total === 1 ? '' : 's'}</span>
    </div>
  `;
}

function openInfoModal(hoja, municipio, rows) {
  const titleEl = document.getElementById('infoModalTitle');
  const bodyEl = document.getElementById('infoModalBody');

  titleEl.textContent = municipio;

  if (!rows?.length) {
    bodyEl.innerHTML = `
      ${renderDetailBadges(hoja, municipio, 0)}
      <div class="detail-empty">
        <i class="bi bi-inbox"></i>
        <div>Sin información disponible.</div>
      </div>
    `;
  } else if (isPresidentesTab(hoja)) {
    const photoCol = getPhotoColumn(rows);
    const nameCol = getNameColumn(rows);
    const r = rows[0] || {};
    const name = String(r?.[nameCol] ?? '').trim() || 'Sin nombre';
    const rawImage = String(r?.[photoCol] ?? '').trim();
    const img = typeof toDirectImageUrl === 'function' ? toDirectImageUrl(rawImage) : rawImage;
    const partyCol = getPartyColumn(rows);
    const partyBlock = partyCol ? renderPartyIcons(r[partyCol]) : '';
    const visibleCols = Object.keys(r).filter((k) => normalize(k) !== 'foto' && !isHiddenColumn(hoja, k));
    const gridHtml = visibleCols.map((k) => renderDetailItem(k, r[k])).join('');

    bodyEl.innerHTML = `
      <section class="detail-profile">
        <div class="detail-photo-wrap">
          ${img ? `<img class="big-avatar" src="${escapeHtml(img)}" alt="${escapeHtml(name)}" onerror="this.closest('.detail-photo-wrap').classList.add('is-empty'); this.remove();">` : '<i class="bi bi-person-circle"></i>'}
        </div>
        <div class="detail-profile-copy">
          <div class="profile-name">${escapeHtml(name)}</div>
          ${renderDetailBadges(hoja, municipio, rows.length)}
          ${partyBlock}
        </div>
      </section>
      <section class="detail-section">
        <div class="detail-section-title"><i class="bi bi-card-checklist"></i> Datos del registro</div>
        <div class="detail-grid">${gridHtml}</div>
      </section>
    `;
  } else {
    let html = `
      ${renderDetailBadges(hoja, municipio, rows.length)}
      <section class="detail-section">
        <div class="detail-section-title"><i class="bi bi-card-checklist"></i> Datos encontrados</div>
    `;

    rows.forEach((r, idx) => {
      const visible = Object.keys(r).filter((k) => !isHiddenColumn(hoja, k));
      html += `
        ${rows.length > 1 ? `<div class="detail-record-label"><span class="badge text-bg-light">Registro ${idx + 1}</span></div>` : ''}
        <div class="detail-grid">${visible.map((k) => renderDetailItem(k, r[k])).join('')}</div>
        ${idx < rows.length - 1 ? '<hr class="detail-separator">' : ''}
      `;
    });

    html += '</section>';
    bodyEl.innerHTML = html;
  }

  const panel = bootstrap.Offcanvas.getOrCreateInstance(document.getElementById('detailPanel'));
  panel.show();
}

function updateMunicipiosForCurrentCoordAndTab(coordName, tabName) {
  const entry = getCoordEntry(coordName);
  selMunicipio.innerHTML = '<option value="" selected disabled>Selecciona un municipio…</option>';
  if (!entry || !tabName) { selMunicipio.disabled = true; return; }

  // Intersección: municipios de la coordinación QUE APARECEN en esa hoja
  const setForTab = entry.municipiosByTab.get(tabName);
  if (!setForTab || setForTab.size === 0) { selMunicipio.disabled = true; return; }

  const list = Array.from(setForTab)
    .map(k => canonicalMunicipioName(k))
    .sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}));

  for (const n of list) {
    const opt = document.createElement('option'); opt.value = n; opt.textContent = n;
    selMunicipio.appendChild(opt);
  }
  selMunicipio.disabled = list.length === 0;
}

//filtro boton option general o coordinación 
function populateTabsAll() {
  selHoja.innerHTML = '<option value="" selected disabled>Selecciona una hoja…</option>';
  (tabs || []).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    selHoja.appendChild(opt);
  });
  selHoja.disabled = false;
}

function populateMunicipiosAll() {
  selMunicipio.innerHTML = '<option value="" selected disabled>Selecciona un municipio…</option>';
  const nombres = (municipiosRaw || [])
    .map(m => m[MUNICIPIO_KEY_JSON])
    .filter(Boolean)
    .sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}));
  for (const n of nombres) {
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    selMunicipio.appendChild(opt);
  }
  selMunicipio.disabled = false;
}
//filtro por coordinación
// Usa el índice global ya construido: coordIndex
function canonicalMunicipioName(name) {
  const key = normalize(name);
  return (municipiosMap?.[key]?.[MUNICIPIO_KEY_JSON]) || name;
}

function populateDependentsForCoord(coordName) {
  const entry = getCoordEntry(coordName);
  // Limpia siempre
  selHoja.innerHTML = '<option value="" selected disabled>Selecciona una hoja…</option>';
  selMunicipio.innerHTML = '<option value="" selected disabled>Selecciona un municipio…</option>';

  if (!entry) {
    selHoja.disabled = true;
    selMunicipio.disabled = true;
    return;
  }

  // Hojas/catálogos que contienen ESA coordinación
  const tabsList = Array.from(entry.tabs).sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}));
  for (const t of tabsList) {
    const opt = document.createElement('option'); opt.value = t; opt.textContent = t;
    selHoja.appendChild(opt);
  }
  selHoja.disabled = tabsList.length === 0;

// comentario
  const muniList = Array.from(entry.municipios)
    .map(k => canonicalMunicipioName(k))
    .sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}));
  for (const n of muniList) {
    const opt = document.createElement('option'); opt.value = n; opt.textContent = n;
    selMunicipio.appendChild(opt);
  }
  selMunicipio.disabled = muniList.length === 0;
}
//carga de select option coordinación
function populateCoordinacionesFromIndex() {
  selCoordinacion.innerHTML = '<option value="" selected disabled>Selecciona una coordinación…</option>';

  const coords = [...coordIndex.entries()]
    .filter(([key]) => key && String(key).trim().length > 0)
    .sort(([,a],[,b])=>(a.name || '').localeCompare(b.name || '','es',{sensitivity:'base'}));

  for (const [key, entry] of coords) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = entry.name || key;
    selCoordinacion.appendChild(opt);
  }

  selCoordinacion.disabled = coords.length === 0;
  console.debug('[populateCoordinaciones] total:', coords.length);
}

function updateUIForMode() {
  _suspendEvents = true;
  document.body.classList.toggle('is-coord-mode', filterMode === 'coord');
  if (filterMode === 'coord') {
  // Mostrar bloque de Coordinación y preparar combos
  blockCoordinacion.classList.remove('d-none');
  blockHoja.classList.remove('d-none');
  blockMunicipio.classList.remove('d-none');

  // Habilita Coordinación; deshabilita dependientes hasta que elijan
  selCoordinacion.disabled = false;
  selHoja.selectedIndex = 0;    selHoja.disabled = true;
  selMunicipio.selectedIndex = 0; selMunicipio.disabled = true;

  // (re)llena el select de Coordinación desde tu índice
  populateCoordinacionesFromIndex();

  polygons.forEach(p => refreshBasePolygonStyles());
  map?.closePopup && map.closePopup();

  updateButtonState(); // <<<< clave
}
  if (filterMode === 'general') {
    // Mostrar Hoja/Municipio; ocultar Coordinación
    blockCoordinacion.classList.add('d-none');
    blockHoja.classList.remove('d-none');
    blockMunicipio.classList.remove('d-none');

    // Coordinación en neutro
    selCoordinacion.selectedIndex = 0;
    selCoordinacion.disabled = true;

    // Hoja/Municipio habilitados y poblados globalmente
    populateTabsAll();
    populateMunicipiosAll();

    // Limpia estilos de mapa
    polygons.forEach(p => refreshBasePolygonStyles());
    map?.closePopup && map.closePopup();

  } else { // 'coord'
    // Mostrar bloque de Coordinación
    blockCoordinacion.classList.remove('d-none');
    blockHoja.classList.remove('d-none');
    blockMunicipio.classList.remove('d-none');

    // Deshabilitar Hoja/Municipio hasta elegir una coordinación (los filtraremos en el paso 2)
    selHoja.selectedIndex = 0; selHoja.disabled = true;
    selMunicipio.selectedIndex = 0; selMunicipio.disabled = true;

    // Activar Coordinación (en el paso 2 la llenamos desde el índice)
    selCoordinacion.disabled = false;

    // Limpia estilos de mapa
    polygons.forEach(p => refreshBasePolygonStyles());
    map?.closePopup && map.closePopup();
  }

  _suspendEvents = false;
  updateButtonState();
}

async function getRowsForTab(tab) {
  if (!tab) return [];
  // usa tu cache actual (dataCache) si ya lo tienes
  let rows = dataCache.get(tab);
  if (!rows) {
    const r = await fetch(ENDPOINT_DATA(tab));
    const j = await r.json();
    rows = j?.rows || [];
    dataCache.set(tab, rows);
  }
  return rows;
}
async function buildPartyIndexForTab(tabName) {
  municipioPartyMap.clear();
  partyKeysAvailable = new Set();

  const rows = await getRowsForTab(tabName);
  const col = getPartyColumn(rows);
  if (!col) return; // la hoja no tiene columna de partido

  rows.forEach(r => {
    const muni = normalize(r[MUNICIPIO_KEY_SHEET]);
    const keys = partyKeysFromRaw(r[col] || '');
    if (!muni || !keys.length) return;
    municipioPartyMap.set(muni, keys);
    keys.forEach((key) => partyKeysAvailable.add(key));
  });
}

async function applyPartyFilter(pKey) {
  const tab = selHoja.value;
  if (!tab) {
    showAppAlert('Selecciona una capa para filtrar por partido.');
    return;
  }

  currentParty = (currentParty === pKey) ? null : (pKey || null);
  refreshBasePolygonStyles();
  updatePartyHighlight?.(currentParty);
  syncPartyDockState();

  if (currentParty) {
    const bounds = [];
    Object.keys(polygonByMunicipio).forEach(mkey => {
      if ((municipioPartyMap.get(mkey) || []).includes(currentParty)) {
        const lyr = polygonByMunicipio[mkey];
        if (lyr?.getBounds) bounds.push(lyr.getBounds());
      }
    });
    if (bounds.length) {
      let union = L.latLngBounds(bounds[0]);
      for (let i = 1; i < bounds.length; i++) union.extend(bounds[i]);
      map.fitBounds(union, { padding: [24, 24] });
    }
  }

  const rows = await getRowsForTab(tab);
  const col = getPartyColumn(rows);
  const filtered = (currentParty && col)
    ? rows.filter(r => partyKeysFromRaw(r[col] || '').includes(currentParty))
    : rows;

  renderDataTable(filtered, tab);
  renderPartyChart?.(rows);
  renderPartyChips();
}

function syncPartyDockState() {
  document.querySelectorAll('.party-dock-btn[data-party]').forEach((btn) => {
    const key = btn.dataset.party || '';
    btn.classList.toggle('is-active', key ? key === currentParty : !currentParty);
  });
}
async function applyFilters() {
  // Sincroniza estado desde los selects
  currentTab        = selHoja.value || null;
  currentMunicipio  = selMunicipio.value || currentMunicipio || null;
  currentCoord      = selCoordinacion.value || currentCoord || null;
  const coordLabel = coordDisplayName(currentCoord);

  if (filterMode === 'coord' && currentCoord && !currentTab) {
    colorByCoordFromIndex(currentCoord);
    if (currentMunicipio) resaltarMunicipio(currentMunicipio);
    munInfo && (munInfo.innerHTML = `<b>Coordinación:</b> ${escapeHtml(coordLabel)}${currentMunicipio ? ` <span class="text-muted">- Municipio: ${escapeHtml(currentMunicipio)}</span>` : ''}`);
    return;
  }

  if (!currentTab) return;

  // Trae toda la hoja (cache)
  let rows = dataCache.get(currentTab);
  if (!rows) {
    const r = await fetch(ENDPOINT_DATA(currentTab));
    const j = await r.json();
    rows = j?.rows || [];
    dataCache.set(currentTab, rows);
  }

// comentario
  if (filterMode === 'coord' && currentCoord) {
    // 1) Pintar mapa según coordinación (targets normal, otros atenuados)
    colorByCoordFromIndex(currentCoord);

    // 2) Si NO hay municipio -> tabla por coordinación
    if (!currentMunicipio) {
      // filtra filas de la hoja por la coordinación seleccionada
      const colC = getCoordColumn(rows); // tu helper que detecta "Coordinación"
      const filCoord = rows.filter(r => normalize(r[colC]) === normalize(currentCoord));

      renderDataTable(filCoord, currentTab);
      lastFilteredRows = filCoord;

      // Info y gráfica global con TODA la hoja
      munInfo && (munInfo.innerHTML = `<b>Coordinación:</b> ${escapeHtml(coordLabel)} <span class="text-muted">• Hoja: ${escapeHtml(currentTab)} • Registros: ${rows.length}</span>`);
      renderPartyChart?.(rows);
      return;
    }

    // 3) Si SÍ hay municipio -> flujo similar al general, pero manteniendo el contexto de coordinación
    resaltarMunicipio(currentMunicipio);

    const filMun = rows.filter(r => normalize(r[MUNICIPIO_KEY_SHEET]) === normalize(currentMunicipio));
    renderDataTable(filMun, currentTab);
    lastFilteredRows = filMun;

    const lyr = polygonByMunicipio[ normalize(currentMunicipio) ];
    if (lyr) {
      const content = buildPopupHTML(currentMunicipio, currentTab, filMun);
      lyr.bindPopup(content, { maxWidth: 420 }).openPopup();
    }

    renderPartyChart?.(rows); // gráfica = toda la hoja
    return;
  }

  // --- RUTA MODO GENERAL ---
  if (!currentMunicipio) {
    // En general necesitas municipio para aplicar
    dataInfo && (dataInfo.textContent = "Selecciona un municipio.");
    return;
  }

  // 1) Resalta polígono y centra
  resaltarMunicipio(currentMunicipio);

  // 2) Subconjunto solo para tabla/popup (por municipio)
  const fil = rows.filter(r => normalize(r[MUNICIPIO_KEY_SHEET]) === normalize(currentMunicipio));
  renderDataTable(fil, currentTab);
  lastFilteredRows = fil;

  // 3) Popup
  const lyr = polygonByMunicipio[ normalize(currentMunicipio) ];
  if (lyr) {
    const content = buildPopupHTML(currentMunicipio, currentTab, fil);
    lyr.bindPopup(content, { maxWidth: 420 }).openPopup();
  }

  // 4) Gráfica = toda la hoja
  renderPartyChart?.(rows);
}
/*Construir el mapa de colores desde Presidentes*/
async function buildMunicipioColorMapFromPresidentes() {
  municipioColorMap = Object.create(null);

  // 1) encuentra la hoja de presidentes
  const presidentsTab = (tabs || []).find(t => isPresidentesTab(t));
  if (!presidentsTab) {
    console.warn('[colors] No encontré una hoja de Presidentes');
    return;
  }

  // 2) carga filas y detecta columnas
  const rows = await getRowsForTab(presidentsTab);
  if (!rows.length) return;
  const colM = MUNICIPIO_KEY_SHEET;
  const colC = getColorColumn(rows);     // "Colores" (preferida)
  const colP = getPartyColumn(rows);     // "Partido..." (fallback)

  // 3) llena el diccionario municipio -> color
  rows.forEach(r => {
    const muni = String(r[colM] ?? '').trim();
    if (!muni) return;
    const key = normalize(muni);

    let hex = null;
    if (colC) {
      const raw = String(r[colC] ?? '').trim();
      if (isHexColor(raw)) hex = raw;
    }
    if (!hex && colP) {
      hex = colorFromParty(r[colP]);
    }
    municipioColorMap[key] = hex || '#93c5fd'; // default si no hay color
  });

  console.debug('[colors] municipios con color:', Object.keys(municipioColorMap).length);
}
//Render dinámico de chips
function renderPartyChips() {
  const wrap = document.getElementById('partyChips');
  const hint = document.getElementById('partyHint');
  if (!wrap) return;

  // Construye chips: primero "Todos"
  const keys = Array.from(partyKeysAvailable).sort();
  const all = [{ key: '', label: 'Todos', color: '#9CA3AF', icon: '' }];

  const items = all.concat(
    keys.map(k => ({ key: k, label: PARTY_LABELS[k] || k.toUpperCase(), color: partyColor(k), icon: PARTY_ICONS[k] || '' }))
  );

  wrap.innerHTML = items.map(it => `
    <button class="party-chip ${currentParty === it.key ? 'is-active' : ''}"
            title="${escapeHtml(it.label)}"
            data-party="${it.key}">
      <span class="party-chip-icon" style="--party-color:${it.color}">
        ${it.icon
          ? `<img src="${it.icon}" alt="${escapeHtml(it.label)}" loading="lazy">`
          : '<i class="bi bi-asterisk"></i>'}
      </span>
      <span class="lbl">${it.label}</span>
    </button>
  `).join('');

  if (hint) {
    hint.textContent = currentParty
      ? `Filtrando por: ${currentParty.toUpperCase()}`
      : 'Selecciona un chip para filtrar.';
  }
  syncPartyDockState();
}

function resetAll() {
  _suspendEvents = true;  // <<<<<< bloquea listeners mientras reseteas
  window._coordTargets = null;
  currentCoord = null;
  currentParty = null;
  refreshBasePolygonStyles();  // repinta con colores del Sheet
  // 1) Selects a placeholder
  if (selCoordinacion && selCoordinacion.options.length) {
    selCoordinacion.selectedIndex = 0;
  }
  if (selHoja && selHoja.options.length) {
    selHoja.selectedIndex = 0;
    currentTab = null;
  }
  if (selMunicipio && selMunicipio.options.length) {
    selMunicipio.selectedIndex = 0;
    currentMunicipio = null;
  }
  if (filterMode === 'coord') {
    selCoordinacion.disabled = false;
    selHoja.innerHTML = '<option value="" selected disabled>Selecciona una hoja…</option>';
    selMunicipio.innerHTML = '<option value="" selected disabled>Selecciona un municipio…</option>';
    selHoja.disabled = true;
    selMunicipio.disabled = true;
  } else {
    selHoja.disabled = false;
    selMunicipio.disabled = false;
  }

  // 2) Cerrar cualquier popup abierto del mapa
  map?.closePopup && map.closePopup();

  // 3) Cerrar popups/unbind y restaurar estilos en TODAS las subcapas
  polygons.forEach(p => {
    p.closePopup && p.closePopup();
    if (p.eachLayer) {
      p.eachLayer(l => {
        l.closePopup && l.closePopup();
        l.unbindPopup && l.unbindPopup();      // <- opcional pero útil para limpiar contenido
        l.setStyle && l.setStyle(styleForKey(normalize(l.feature?.properties?.municipio || ''), l.feature));
      });
    } else {
      p.setStyle && refreshBasePolygonStyles();
    }
  });
  refreshBasePolygonStyles();
  syncPartyDockState?.();

  // 4) Limpiar UI lateral
  if (dataInfo) {
    // elimina nodos para evitar HTML residual
    dataInfo.replaceChildren();
    dataInfo.textContent = "Selecciona una hoja y un municipio.";
  }
  if (munInfo) munInfo.textContent = "—";

  // Si tienes buscador de municipio
  const search = document.getElementById('searchMunicipio');
  if (search) search.value = '';

  // 5) Limpiar gráficas
  if (typeof miniChartInstance !== 'undefined' && miniChartInstance) {
    miniChartInstance.destroy(); miniChartInstance = null;
  }
  if (typeof partyChartInstance !== 'undefined' && partyChartInstance) {
    partyChartInstance.destroy(); partyChartInstance = null;
  }
  typeof setPartyBoxVisible === 'function' && setPartyBoxVisible(false);
  const chartHint = document.getElementById('partyChartHint') || document.getElementById('chartHint');
  if (chartHint) chartHint.textContent = '';

  // 6) Recentrar mapa a todos los polígonos
  try {
    const group = L.featureGroup(polygons);
    map.fitBounds(group.getBounds(), { padding: [20, 20] });
  } catch (_) {
    map.setView([19.3, -99.65], 8);
  }

  _suspendEvents = false;  // <<<<<< re-activa listeners

  // 7) Re-sincroniza estado de botones/leyenda
  updateButtonState?.();
  if (typeof updateLegend === 'function') {
    const sw = document.getElementById('legendSwatch');
    const tx = document.getElementById('legendText');
    if (sw) sw.style.background = 'transparent';
    if (tx) tx.textContent = '—';
  }
}
function fullResetState() {
  currentTab = null;
  currentMunicipio = null;
  currentCoord = null;
  lastFilteredRows = [];
}

function resetMapVisual() {
  // cierra popups y repone colores oficiales (sin atenuar)
  map?.closePopup && map.closePopup();
  refreshBasePolygonStyles?.();

  // encuadra todo el estado
  try {
    let union = null;
    polygons.forEach(g => {
      if (!g?.getBounds) return;
      const b = g.getBounds();
      union = union ? union.extend(b) : L.latLngBounds(b);
    });
    if (union) map.fitBounds(union, { padding: [20, 20] });
  } catch(_) {
    map.setView([19.3, -99.65], 8);
  }
}

function clearChartsAndInfo() {
  // borra gráfica de partidos si la usas
  if (partyChartInstance) { partyChartInstance.destroy(); partyChartInstance = null; }
  setPartyBoxVisible?.(false);

  // textos
  if (munInfo)  munInfo.textContent = '—';
  if (dataInfo) dataInfo.textContent = 'Selecciona una opción.';
}

// Usa esta en lugar de tu resaltarMunicipio anterior
function resaltarMunicipio(nombre) {
  focusMunicipio(nombre);
  munInfo.innerHTML = `<span class="municipio-highlight">${escapeHtml(nombre)}</span>`;
}

function renderDataTable(rows, tabName) {
  if (!dataInfo) return;
  if (!rows || rows.length === 0) {
    dataInfo.innerHTML = `<span class="text-warning">No hay registros para <b>${escapeHtml(currentMunicipio || '—')}</b> en la hoja <b>${escapeHtml(tabName)}</b>.</span>`;
    return;
  }
// comentario
  const allCols = Object.keys(rows[0]);
  const cols = allCols.filter(c => !isHiddenColumn(tabName, c));

  let html = `<div class="mb-2 small text-muted">Hoja: <b>${escapeHtml(tabName)}</b> — Registros: <b>${rows.length}</b></div>`;
  html += `<div class="table-responsive"><table class="table table-sm table-striped align-middle mb-0"><thead><tr>`;
  for (const c of cols) html += `<th>${escapeHtml(c)}</th>`;
  html += `</tr></thead><tbody>`;

  for (const r of rows) {
    html += `<tr>`;
    for (const c of cols) html += `<td>${autoFormat(r[c], c)}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  dataInfo.innerHTML = html;
}

function findFieldByTerms(row, terms = []) {
  const keys = Object.keys(row || {});
  return keys.find((k) => {
    const nk = normalize(k);
    return terms.some((term) => nk.includes(normalize(term)));
  }) || null;
}

function valueIsPresent(value) {
  return String(value ?? '').trim() !== '';
}

function renderPopupDataItem(key, value) {
  return `
    <div class="popup-data-item">
      <span class="popup-data-icon"><i class="bi ${iconForField(key)}"></i></span>
      <span class="popup-data-copy">
        <span class="popup-data-label">${escapeHtml(key)}</span>
        <span class="popup-data-value">${autoFormat(value, key)}</span>
      </span>
    </div>
  `;
}

function getPopupFieldPlan(row, hoja, rows) {
  const nameCol = getNameColumn(rows) || findFieldByTerms(row, ['nombre', 'responsable', 'titular', 'representante']);
  const roleCol = findFieldByTerms(row, ['cargo', 'puesto', 'tipo', 'categoría', 'comision', 'area']);
  const partyCol = getPartyColumn(rows);
  const coordCol = getCoordColumn(rows);
  const contactCols = [
    findFieldByTerms(row, ['telefono', 'telefonico', 'celular', 'whatsapp']),
    findFieldByTerms(row, ['correo', 'email']),
    findFieldByTerms(row, ['facebook']),
    findFieldByTerms(row, ['instagram'])
  ].filter(Boolean);

  const excluded = new Set([
    nameCol,
    roleCol,
    partyCol,
    coordCol,
    MUNICIPIO_KEY_SHEET,
    getPhotoColumn(rows)
  ].filter(Boolean));

  const metaCols = [roleCol, partyCol, coordCol]
    .filter(Boolean)
    .filter((k) => valueIsPresent(row[k]) && !isHiddenColumn(hoja, k));

  const detailCols = Object.keys(row)
    .filter((k) => !excluded.has(k))
    .filter((k) => !isHiddenColumn(hoja, k))
    .filter((k) => valueIsPresent(row[k]))
    .filter((k) => !contactCols.includes(k))
    .slice(0, 4);

  return { nameCol, roleCol, partyCol, coordCol, contactCols, metaCols, detailCols };
}

function buildPopupHTML(municipio, hoja, rows) {
  if (!rows || rows.length === 0) {
    return `
      <div class="map-popup map-popup-empty">
        <div class="popup-topline">
          <span class="popup-layer-badge"><i class="bi bi-layers"></i>${escapeHtml(hoja)}</span>
        </div>
        <div class="popup-title">${escapeHtml(municipio)}</div>
        <div class="popup-empty-state"><i class="bi bi-inbox"></i> Sin datos disponibles.</div>
      </div>
    `;
  }

  // === Popup especial para Presidentes Municipales ===
  if (isPresidentesTab(hoja)) {
    const photoCol = getPhotoColumn(rows);
    const nameCol  = getNameColumn(rows);
    const r = rows[0] || {};
    const name = String(r[nameCol] ?? '').trim() || '—';
    const raw  = String(r[photoCol] ?? '').trim();
    const img  = toDirectImageUrl(raw);
    const partyCol = getPartyColumn(rows);
    const partyBlock = partyCol ? renderPartyIcons(r[partyCol]) : '';

    const extra = rows.length > 1
      ? `<div class="small text-muted mt-2">(+ ${rows.length - 1} más)</div>`
      : '';

    return `
      <div class="president-popup text-center">
        ${img ? `<img class="popup-avatar mb-2" src="${escapeHtml(img)}" alt="${escapeHtml(name)}" onerror="this.style.display='none'">` : ''}
        <div class="fw-semibold mb-2">${escapeHtml(name)}</div>
        ${partyBlock}
        <button class="btn btn-sm btn-primary btn-ver-mas"
                data-hoja="${escapeHtml(hoja)}"
                data-municipio="${escapeHtml(municipio)}">
          <i class="bi bi-layout-sidebar-inset-reverse me-1"></i> Ver más
        </button>
        ${extra}
      </div>
    `;
  }


  // === Ficha compacta para otras hojas (oculta columnas no visibles) ===
  const first = rows[0];
  const plan = getPopupFieldPlan(first, hoja, rows);
  const title = plan.nameCol && valueIsPresent(first[plan.nameCol])
    ? String(first[plan.nameCol]).trim()
    : municipio;
  const subtitle = plan.roleCol && valueIsPresent(first[plan.roleCol])
    ? String(first[plan.roleCol]).trim()
    : hoja;
  const partyBlock = plan.partyCol ? renderPartyIcons(first[plan.partyCol], { compact: true }) : '';
  const metaHtml = plan.metaCols.map((k) => renderPopupDataItem(k, first[k])).join('');
  const contactHtml = plan.contactCols
    .filter((k) => valueIsPresent(first[k]) && !isHiddenColumn(hoja, k))
    .slice(0, 3)
    .map((k) => renderPopupDataItem(k, first[k]))
    .join('');
  const detailHtml = plan.detailCols.map((k) => renderPopupDataItem(k, first[k])).join('');
  const extra = rows.length > 1
    ? `<span class="popup-count-badge"><i class="bi bi-stack"></i>${rows.length} registros</span>`
    : '';

  if (!metaHtml && !contactHtml && !detailHtml && !partyBlock) {
    return `
      <div class="map-popup">
        <div class="popup-topline">
          <span class="popup-layer-badge"><i class="bi bi-layers"></i>${escapeHtml(hoja)}</span>
          ${extra}
        </div>
        <div class="popup-title">${escapeHtml(municipio)}</div>
        <div class="popup-empty-state"><i class="bi bi-eye-slash"></i> Sin campos visibles.</div>
        <button class="btn btn-sm btn-primary btn-ver-mas popup-action"
                data-hoja="${escapeHtml(hoja)}"
                data-municipio="${escapeHtml(municipio)}">
          <i class="bi bi-layout-sidebar-inset-reverse me-1"></i> Ver detalle
        </button>
      </div>
    `;
  }

  return `
    <div class="map-popup">
      <div class="popup-topline">
        <span class="popup-layer-badge"><i class="bi bi-layers"></i>${escapeHtml(hoja)}</span>
        ${extra}
      </div>
      <div class="popup-title">${escapeHtml(title)}</div>
      <div class="popup-subtitle"><i class="bi bi-geo-alt"></i>${escapeHtml(municipio)}${subtitle && subtitle !== hoja ? ` · ${escapeHtml(subtitle)}` : ''}</div>
      ${partyBlock ? `<div class="popup-party-row">${partyBlock}</div>` : ''}
      <div class="popup-data-grid">
        ${metaHtml}
        ${contactHtml}
        ${detailHtml}
      </div>
      <button class="btn btn-sm btn-primary btn-ver-mas popup-action"
              data-hoja="${escapeHtml(hoja)}"
              data-municipio="${escapeHtml(municipio)}">
        <i class="bi bi-layout-sidebar-inset-reverse me-1"></i> Ver detalle
      </button>
    </div>
  `;
}

// ==================== Utils ====================
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^\/\//.test(s)) s = 'https:' + s;
  else if (/^www\./i.test(s)) s = 'https://' + s;
  return s;
}

function toDirectImageSource(raw) {
  const u = normalizeUrl(raw);
  if (!u) return { img:'', href:'', fallbacks:[] };

  // Google Photos: no embebible
  if (/photos\.app\.goo\.gl/i.test(u)) {
    return { img:'', href:u, fallbacks:[] };
  }

  // Google Drive
  const id = extractDriveId(u);
  if (id) {
    const primary   = `https://drive.google.com/thumbnail?id=${id}&sz=w800`;
    const secondary = `https://lh3.googleusercontent.com/d/${id}=s800`;
    const tertiary  = `https://drive.google.com/uc?export=view&id=${id}`;
    return { img: primary, href: `https://drive.google.com/file/d/${id}/view`, fallbacks: [secondary, tertiary] };
  }

  // URLs con extensión de imagen
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i.test(u)) {
    return { img: u, href: u, fallbacks: [] };
  }

// comentario
  return { img:'', href:u, fallbacks:[] };
}

function buildImgTagWithFallback(src, alt, fallbacks = []) {
  const safeAlt = escapeHtml(alt || '');
  const safeSrc = escapeHtml(src || '');
  const safeFallbacks = JSON.stringify([].concat(fallbacks || []).filter(Boolean));
  return `
    <img src="${safeSrc}" alt="${safeAlt}"
         style="max-width:140px;max-height:100px;border-radius:8px"
         data-fallbacks='${escapeHtml(safeFallbacks)}'
         onerror="const f=JSON.parse(this.dataset.fallbacks||'[]'); const i=Number(this.dataset.fbIndex||0); if(f[i]){ this.dataset.fbIndex=i+1; this.src=f[i]; } else { this.style.display='none'; }">`;
}
function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}
function escapeHtml(x) {
  return String(x ?? "").replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}
function autoFormat(v, colName) {
  if (v == null) return '';
  let s = String(v).trim();
  if (!s) return '';

// comentario
  if (colName && /foto/i.test(colName)) {
    const { img, href, fallbacks } = toDirectImageSource(s);
    if (img) {
      return buildImgTagWithFallback(img, 'Foto', fallbacks);
    }
// comentario
    if (href) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">Abrir foto</a>`;
    }
    return '';
  }

// comentario
  if (/^(https?:)?\/\/|^www\./i.test(s)) {
    const u = normalizeUrl(s);
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">Abrir</a>`;
  }

// comentario
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(s)) {
    const src = normalizeUrl(s);
    return `<img src="${escapeHtml(src)}" alt="" style="max-width:80px;max-height:50px;border-radius:8px">`;
  }

  return escapeHtml(s);
}

// Detectar si hay que invertir ejes (por si el WKT viniera lat,lon)
function firstCoordFromGeo(geometry) {
  const g = geometry, t = g?.type;
  if (!g) return null;
  if (t === "Point") return g.coordinates;
  if (t === "LineString") return g.coordinates[0];
  if (t === "Polygon") return g.coordinates[0][0];
  if (t === "MultiPolygon") return g.coordinates[0][0][0];
  if (t === "MultiLineString") return g.coordinates[0][0];
  if (t === "MultiPoint") return g.coordinates[0];
  return null;
}
function shouldSwapXY(geometry) {
  const c = firstCoordFromGeo(geometry);
  if (!c) return false;
  const [x, y] = c; // GeoJSON espera [lon,lat]
  return Math.abs(x) <= 90 && Math.abs(y) > 90; // x parece lat, y parece lon
}
function swapXYGeom(geometry) {
  const deepSwap = (coords) => {
    if (typeof coords[0] === "number") return [coords[1], coords[0]];
    return coords.map(deepSwap);
  };
  return { type: geometry.type, coordinates: deepSwap(geometry.coordinates) };
}
function ajustarPaddingFooter() {
    const nav = document.querySelector('.navbar.fixed-bottom');
    const h = nav ? Math.ceil(nav.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--footer-h', (h || 64) + 'px');
  }

  function resizeDataInfo() {
    const di = document.getElementById('dataInfo');
    if (!di) return;
    const footer = document.querySelector('.navbar.fixed-bottom');
    const footerH = footer ? Math.ceil(footer.getBoundingClientRect().height) : 0;
    const top = di.getBoundingClientRect().top;         // posición actual del panel
    const gap = 16;                                      // respiración inferior (px)
    const avail = Math.max(160, window.innerHeight - footerH - top - gap);
    di.style.maxHeight = avail + 'px';
    di.style.overflow = 'auto';
  }
// Colores oficiales por partido (keys normalizadas)
const PARTY_COLORS = {
  morena: '#7A003F',
  pan: '#0000FF',
  pri: '#FF0D00',
  prd: '#FFD700',
  pt: '#FF903F',
  pvem: '#008000',
  mc: '#FF5300',
  naem: '#0BD1E4',
  independiente: '#6B7280'
};

const PARTY_ICON_BASE = '/assets/partidos';
const PARTY_ICONS = {
  morena: `${PARTY_ICON_BASE}/morena.png`,
  pan: `${PARTY_ICON_BASE}/pan.png`,
  pri: `${PARTY_ICON_BASE}/pri.png`,
  prd: `${PARTY_ICON_BASE}/prd.png`,
  pt: `${PARTY_ICON_BASE}/pt.png`,
  pvem: `${PARTY_ICON_BASE}/pvem.png`,
  mc: `${PARTY_ICON_BASE}/mc.png`,
  naem: `${PARTY_ICON_BASE}/na.png`
};

const PARTY_LABELS = {
  morena: 'Morena',
  pan: 'PAN',
  pri: 'PRI',
  prd: 'PRD',
  pt: 'PT',
  pvem: 'Partido Verde',
  mc: 'Movimiento Ciudadano',
  naem: 'Nueva Alianza',
  independiente: 'Independiente'
};

const PARTY_ALIASES = [
  { key: 'morena', tests: ['morena'] },
  { key: 'pt', tests: ['pt', 'partido del trabajo'] },
  { key: 'pvem', tests: ['pvem', 'verde', 'partido verde', 'ecologista'] },
  { key: 'mc', tests: ['mc', 'movimiento ciudadano'] },
  { key: 'pan', tests: ['pan', 'accion nacional'] },
  { key: 'pri', tests: ['pri', 'revolucionario institucional'] },
  { key: 'prd', tests: ['prd', 'revolucion democratica'] },
  { key: 'naem', tests: ['nueva alianza', 'naem'] },
  { key: 'independiente', tests: ['independiente'] }
];

function partyKeysFromRaw(raw) {
  const n = normalize(raw);
  if (!n) return [];

  const keys = [];
  PARTY_ALIASES.forEach(({ key, tests }) => {
    if (tests.some((test) => n.includes(test)) && !keys.includes(key)) {
      keys.push(key);
    }
  });

  if (!keys.length && PARTY_COLORS[n]) keys.push(n);
  return keys;
}

function renderPartyIcons(raw, options = {}) {
  const keys = partyKeysFromRaw(raw).filter((key) => PARTY_ICONS[key]);
  if (!keys.length) return '';

  const compact = Boolean(options.compact);
  return `
    <div class="${compact ? 'party-icons party-icons-compact' : 'party-icons'}">
      ${keys.map((key) => `
        <span class="party-icon-badge" title="${escapeHtml(PARTY_LABELS[key] || key.toUpperCase())}">
          <img src="${PARTY_ICONS[key]}" alt="${escapeHtml(PARTY_LABELS[key] || key.toUpperCase())}" loading="lazy">
        </span>
      `).join('')}
    </div>
  `;
}

// comentario
function partyKeyFrom(raw) {
  const keys = partyKeysFromRaw(raw);
  if (keys.length) return keys[0];
  const n = normalize(raw);
  return n;
}
function partyColor(key) {
  return PARTY_COLORS[key] || '#9CA3AF';
}
  // Llama en los momentos clave
  window.addEventListener('load',  () => { ajustarPaddingFooter(); resizeDataInfo(); setTimeout(resizeDataInfo, 0); });
  window.addEventListener('resize', () => { ajustarPaddingFooter(); resizeDataInfo(); });

  // Si usas Leaflet, ayuda a reacomodar azulejos al cambiar tamaños
  window.addEventListener('resize', () => { try { map && map.invalidateSize(); } catch(_){} });

// Toggle mostrar/ocultar solo del contenido
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#legendToggle');
  if (!btn) return;

  const wrap = document.getElementById('mapPartyLegend');
  wrap.classList.toggle('is-collapsed');

  const expanded = !wrap.classList.contains('is-collapsed');
  btn.setAttribute('aria-expanded', String(expanded));
  btn.textContent = expanded ? '–' : '+';
});



