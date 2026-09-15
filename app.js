'use strict';

/* ================= Fuentes ================= */
const SOURCES_URL = 'https://dabogo1879-source.github.io/atlas-tv-app/sources.json';
const DEFAULTS = {
  ec:     { label: 'Ecuador',  url: 'https://iptv-org.github.io/iptv/countries/ec.m3u' },
  latam:  { label: 'LatAm',    url: 'https://iptv-org.github.io/iptv/countries/latam.m3u' },
  spa:    { label: 'Español',  url: 'https://iptv-org.github.io/iptv/languages/spa.m3u' },
  movies: { label: 'Películas',url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  series: { label: 'Series',   url: 'https://iptv-org.github.io/iptv/categories/series.m3u' },
  global: { label: 'Global',   url: 'https://iptv-org.github.io/iptv/index.m3u' },
};
const CACHE_KEY = 'atlas-tv-cache-';        // prefijo localStorage (fallback universal)
const CUSTOM_KEY = 'atlas-tv-custom-url';

function cacheGet(url){
  return localStorage.getItem(CACHE_KEY + url);
}
function cacheSet(url, txt){
  try{ localStorage.setItem(CACHE_KEY + url, txt); }catch(_){}
}

/* Fetch con timeout que cachea en localStorage SIEMPRE (no depende de Cache Storage API) */
async function fetchCached(url, ttlMs){
  const hit = cacheGet(url);
  if(hit){
    const t = JSON.parse(hit);
    if(!ttlMs || (Date.now() - t.ts) < ttlMs) return t.txt;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try{
    const r = await fetch(url, { signal: ctrl.signal });
    if(!r.ok) throw new Error('HTTP '+r.status);
    const txt = await r.text();
    cacheSet(url, JSON.stringify({ ts: Date.now(), txt }));
    return txt;
  }finally{
    clearTimeout(t);
  }
}

/* ================= Estado ================= */
const state = {
  src: 'ec',
  sources: { ...DEFAULTS },
  groups: [],
  channels: [],
  filtered: [],
  grp: '',
  active: 0,           // índice dentro de filtered para zapping
  favs: new Set(JSON.parse(localStorage.getItem('atlas-tv-favs') || '[]')),
  hls: null,
};
const $ = s => document.querySelector(s);
const video = $('#video');

/* ================= Persistencia ================= */
function saveFavs(){ localStorage.setItem('atlas-tv-favs', JSON.stringify([...state.favs])); }

/* ================= Fuentes remotas ================= */
async function loadSources(){
  let txt = null, msg = '';
  try{
    txt = await fetchCached(SOURCES_URL, 15*60*1000);   // 15 min de TTL
    msg = '✅ Fuentes actualizadas desde internet';
  }catch(e){
    const stale = cacheGet(SOURCES_URL);
    if(stale){ txt = JSON.parse(stale).txt; msg = '⚠️ Sin internet: usando fuentes guardadas'; }
    else{ setStatus('⚠️ Sin acceso a fuentes remotas, usando locales', true); }
  }
  if(txt){
    try{
      const cfg = JSON.parse(txt);
      if(cfg && cfg.sources && Array.isArray(cfg.sources) && cfg.sources.length){
        const next = {};
        cfg.sources.forEach(s => { if(s.id && s.url) next[s.id] = { label: s.label || s.id, url: s.url }; });
        state.sources = next;
        setStatus(`${msg} · ${Object.keys(state.sources).length} pestañas`);
      }
    }catch(_){}
  }
  renderTabs();
  loadPlaylist(state.src);
}

function renderTabs(){
  const tabs = $('#tabs');
  tabs.innerHTML = Object.entries(state.sources)
    .map(([id, s]) => `<button data-src="${id}" class="tab${id === state.src ? ' active' : ''}">${s.label}</button>`)
    .join('');
  tabs.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      state.src = t.dataset.src;
      loadPlaylist(state.src);
    });
  });
}

/* ================= Data: playlist === ================= */
async function loadPlaylist(src){
  const url = src === 'custom'
    ? localStorage.getItem(CUSTOM_KEY) || ''
    : (state.sources[src] && state.sources[src].url) || '';
  if(!url){ setStatus('Sin URL personalizada guardada', true); return; }
  const t0 = performance.now();
  setStatus('Cargando canales…');
  try{
    let txt;
    try{
      txt = await fetchCached(url, null);   // sin TTL: m3u cambia poco, aprovecha caché local
    }catch(e){
      const stale = cacheGet(url);
      if(!stale) throw e;
      txt = JSON.parse(stale).txt;
      setStatus('⚠️ Sin internet: usando lista guardada', true);
    }
    state.channels = parseM3U(txt);
    state.groups = [...new Set(state.channels.map(c => c.group).filter(Boolean))].sort();
    state.grp = '';
    renderGroups();
    applyFilter();
    setStatus(`✅ ${state.channels.length} canales · ${Math.round(performance.now()-t0)}ms`);
  }catch(e){
    setStatus('⚠️ Error cargando playlist: '+e.message);
  }
}

/* Parser M3U minimalista: EXTINF → atributos + línea de URL */
function parseM3U(txt){
  const lines = txt.split(/\r?\n/);
  const out = [];
  let cur = null;
  for(const line of lines){
    if(line.startsWith('#EXTINF')){
      cur = { name: line.split(',').slice(1).join(',').trim() || 'Canal', group: 'General', logo: '', tvg: '', url: '' };
      const g = line.match(/group-title="([^"]*)"/);
      if(g) cur.group = g[1] || 'General';
      const l = line.match(/tvg-logo="([^"]*)"/);
      if(l) cur.logo = l[1];
      const t = line.match(/tvg-id="([^"]*)"/);
      if(t) cur.tvg = t[1];
    }else if(cur && line.trim() && !line.startsWith('#')){
      cur.url = line.trim();
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

/* ================= Render ================= */
function renderGroups(){
  const g = $('#groups');
  g.innerHTML = '<button data-grp="" class="grp active">Todos</button>' +
    '<button data-grp="⭐" class="grp fav">Favoritos</button>' +
    state.groups.map(n => `<button data-grp="${esc(n)}" class="grp">${esc(n)}</button>`).join('');
}

function applyFilter(){
  const q = $('#search').value.trim().toLowerCase();
  let list = state.channels;
  if(state.grp === '⭐') list = list.filter(c => state.favs.has(c.url));
  else if(state.grp)    list = list.filter(c => c.group === state.grp);
  if(q) list = list.filter(c => c.name.toLowerCase().includes(q));
  state.filtered = list;
  renderGrid(list);
}

function renderGrid(list){
  $('#count').textContent = `${list.length} canales`;
  const grid = $('#grid');
  grid.innerHTML = list.map((c, i) => `
    <article class="card" data-i="${i}">
      <div class="thumb">
        ${c.logo ? `<img loading="lazy" src="${esc(c.logo)}" onerror="this.outerHTML='<span class=\\'fallback\\'>${esc(firstLetter(c.name))}</span>'">`
                 : `<span class="fallback">${esc(firstLetter(c.name))}</span>`}
        <button class="star${state.favs.has(c.url) ? ' on' : ''}" title="Favorito">★</button>
      </div>
      <div class="meta">
        <div class="name">${esc(c.name)}</div>
        <div class="grp-chip">${esc(c.group)}</div>
      </div>
    </article>`).join('');
  // bind
  [...grid.querySelectorAll('.card')].forEach(el => {
    const i = +el.dataset.i;
    el.addEventListener('click', () => open(i));
  });
  [...grid.querySelectorAll('.star')].forEach((st, idx) => {
    st.addEventListener('click', ev => {
      ev.stopPropagation();
      const c = state.filtered[idx];
      toggleFav(c, st);
    });
  });
}

function firstLetter(n){ return (n.trim()[0]||'?').toUpperCase(); }
function toggleFav(ch, btn){
  if(state.favs.has(ch.url)){ state.favs.delete(ch.url); btn.classList.remove('on'); }
  else{ state.favs.add(ch.url); btn.classList.add('on'); }
  saveFavs();
  if(state.grp === '⭐') applyFilter(); // refresca si estamos en favoritos
}
function setStatus(text, bad){
  const s = $('#pl-status');
  s.textContent = text; s.classList.toggle('bad', !!bad); s.classList.add('show');
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ================= Reproductor ================= */
function open(i){
  state.active = i;
  const ch = state.filtered[state.active];
  $('#pl-name').textContent = ch.name;
  $('#pl-src').textContent = ch.url;
  player.showModal();
  play(ch);
  video.play().catch(() => {});
}

video.addEventListener('playing', () => setStatus('Reproduciendo'));

function play(ch, retry=0){
  setStatus('Conectando…');
  video.src = '';
  if(state.hls){ state.hls.destroy(); state.hls = null; }

  const tryNext = () => {
    setStatus('Señal caída, siguiente canal…', true);
    setTimeout(() => next(), 1200);
  };

  if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src = ch.url;                       // Safari/iOS nativo
    onErrOnce(tryNext);
  }else if(window.Hls && Hls.isSupported()){
    const hls = new Hls({ manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 2, maxBufferLength: 20 });
    state.hls = hls;
    hls.loadSource(ch.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus('Reproduciendo'));
    hls.on(Hls.Events.ERROR, (e, data) => {
      if(data.fatal){
        if(retry < 1 && ['networkError','mediaError'].includes(data.type)) play(ch, retry+1);
        else tryNext();
      }
    });
  }else{
    setStatus('Formato no soportado en este navegador', true);
  }
}

function onErrOnce(fn){
  const h = () => { video.removeEventListener('error', h); fn(); };
  video.addEventListener('error', h);
}

function next(){
  if(!state.filtered.length) return;
  state.active = (state.active + 1) % state.filtered.length;
  const ch = state.filtered[state.active];
  $('#pl-name').textContent = ch.name;
  $('#pl-src').textContent = ch.url;
  play(ch);
}
function prev(){
  if(!state.filtered.length) return;
  state.active = (state.active - 1 + state.filtered.length) % state.filtered.length;
  const ch = state.filtered[state.active];
  $('#pl-name').textContent = ch.name;
  $('#pl-src').textContent = ch.url;
  play(ch);
}

/* ================= Eventos ================= */
$('#search').addEventListener('input', applyFilter);

$('#groups').addEventListener('click', e => {
  const b = e.target.closest('.grp'); if(!b) return;
  document.querySelectorAll('.grp').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.grp = b.dataset.grp;
  applyFilter();
});

$('#custom-go').addEventListener('click', () => {
  const u = $('#custom-url').value.trim();
  if(!u){ setStatus('Pega una URL de lista .m3u primero', true); return; }
  localStorage.setItem(CUSTOM_KEY, u);
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  state.src = 'custom';
  loadPlaylist('custom');
});

$('#pl-close').addEventListener('click', () => {
  player.close();
  if(state.hls){ state.hls.destroy(); state.hls = null; }
  video.pause(); video.src = '';
});
$('#zap-next').addEventListener('click', next);
$('#zap-prev').addEventListener('click', prev);
document.addEventListener('keydown', e => {
  if(!player.open) return;
  if(e.key === 'ArrowRight') next();
  if(e.key === 'ArrowLeft') prev();
  if(e.key === 'Escape') $('#pl-close').click();
});

/* ================= Arranque ================= */
loadSources();