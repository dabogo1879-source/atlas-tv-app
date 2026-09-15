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
const RECENTS_KEY = 'atlas-tv-recents';      // últimos canales vistos
const EPG_URL_KEY = 'atlas-tv-epg-url';      // URL XMLTV opcional del usuario
const EPG_KEY = 'atlas-tv-epg-data';

function cacheGet(url){
  return localStorage.getItem(CACHE_KEY + url);
}
function cacheSet(url, txt){
  try{ localStorage.setItem(CACHE_KEY + url, txt); }catch(_){}
}

/* Fetch con timeout que cachea en localStorage SIEMPRE (no depende de Cache Storage API) */
async function fetchCached(url, ttlMs, raw){
  const hit = cacheGet(url);
  if(hit && !raw){
    const t = JSON.parse(hit);
    if(!ttlMs || (Date.now() - t.ts) < ttlMs) return t.txt;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try{
    const r = await fetch(url, { signal: ctrl.signal });
    if(!r.ok) throw new Error('HTTP '+r.status);
    let txt;
    if(raw){
      const buf = await r.arrayBuffer();
      if(url.endsWith('.gz') || r.headers.get('content-encoding') === 'gzip'){
        if(typeof DecompressionStream === 'undefined') throw new Error('Este WebView no descomprime .gz');
        txt = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      }else{
        txt = new TextDecoder('utf-8').decode(buf);
      }
    }else{
      txt = await r.text();
    }
    cacheSet(url, JSON.stringify({ ts: Date.now(), txt }));
    return txt;
  }finally{
    clearTimeout(t);
  }
}

/* ================= Estado ================= */
const state = {
  src: localStorage.getItem('atlas-tv-src') || 'ec',
  sources: { ...DEFAULTS },
  groups: [],
  channels: [],
  filtered: [],
  grp: '',
  active: 0,           // índice dentro de filtered para zapping
  favs: new Set(JSON.parse(localStorage.getItem('atlas-tv-favs') || '[]')),
  recents: JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'),
  hls: null,
  epgUrl: localStorage.getItem(EPG_URL_KEY) || '',
  epg: null,           // {ts, channels:{id:name}, progs} cacheado en memoria
  epgTimer: null,
  muted: false,
};
const $ = s => document.querySelector(s);
const video = $('#video');

/* ================= Persistencia ================= */
function saveFavs(){ localStorage.setItem('atlas-tv-favs', JSON.stringify([...state.favs])); }
function pushRecent(ch){
  state.recents = state.recents.filter(r => r.url !== ch.url);
  state.recents.unshift({ url: ch.url, name: ch.name, group: ch.group, logo: ch.logo, ts: Date.now() });
  if(state.recents.length > 12) state.recents.length = 12;
  try{ localStorage.setItem(RECENTS_KEY, JSON.stringify(state.recents)); }catch(_){}
}

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
      localStorage.setItem('atlas-tv-src', state.src);
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
    setStatus(`✅ ${state.channels.length} canales · ${Math.round(performance.now()-t0)}ms` + (state.epg ? ' · 📺 EPG activo' : ''));
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
    (state.recents.length ? '<button data-grp="🕘" class="grp recent">🕘 Recientes</button>' : '') +
    '<button data-grp="⭐" class="grp fav">Favoritos</button>' +
    state.groups.map(n => `<button data-grp="${esc(n)}" class="grp">${esc(n)}</button>`).join('');
}

function applyFilter(){
  const q = $('#search').value.trim().toLowerCase();
  let list = state.channels;
  if(state.grp === '⭐') list = list.filter(c => state.favs.has(c.url));
  else if(state.grp === '🕘'){
    const urls = new Set(state.recents.map(r => r.url));
    list = state.recents
      .map(r => state.channels.find(c => c.url === r.url))
      .filter(Boolean)
      .map(c => ({ ...c, _recent: true }));
    if(!list.length){ state.grp = ''; document.querySelectorAll('.grp').forEach(x => x.classList.remove('active')); }
  }
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
        <div class="grp-chip">${esc(c.group)}${c._recent ? ' · 🕘' : ''}</div>
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

/* ================= EPG (Ahora/Siguiente) ================= */
async function loadEpg(force){
  if(!state.epgUrl){
    $('#epg-state').textContent = 'Sin EPG: pega una URL XMLTV para ver la programación.';
    $('#epg-state').classList.add('dim');
    return;
  }
  $('#epg-state').textContent = '📡 Cargando guía EPG…';
  $('#epg-state').classList.remove('dim');
  const cached = localStorage.getItem(EPG_KEY);
  if(!force && cached){
    try{
      const d = JSON.parse(cached);
      if(Date.now() - d.ts < 6*60*60*1000){   // 6h de vida
        state.epg = d;
        $('#epg-state').textContent = `✅ EPG: ${Object.keys(d.channels||{}).length} canales con guía (hace ${Math.round((Date.now()-d.ts)/60000)} min)`;
        return;
      }
    }catch(_){}
  }
  try{
    const txt = await fetchCached(state.epgUrl, null, true);
    const parsed = parseXmltv(txt);
    state.epg = { ts: Date.now(), ...parsed };
    try{ localStorage.setItem(EPG_KEY, JSON.stringify(state.epg)); }catch(_){}
    $('#epg-state').textContent = `✅ EPG: ${Object.keys(state.epg.channels||{}).length} canales con guía (envivo)`;
  }catch(e){
    $('#epg-state').textContent = '⚠️ Error EPG: '+e.message;
    $('#epg-state').classList.add('bad');
    if(state.epg) $('#epg-state').textContent += ' · usando la copia guardada';
  }
}

function parseXmltv(xml){
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const channels = {};
  doc.querySelectorAll('channel').forEach(ch => {
    const id = ch.getAttribute('id');
    if(!id) return;
    const dn = ch.querySelector('display-name');
    channels[id.toLowerCase()] = dn ? dn.textContent.trim() : id;
  });
  const progs = [];
  doc.querySelectorAll('programme').forEach(p => {
    const cid = (p.getAttribute('channel')||'').toLowerCase();
    if(!cid) return;
    const s = p.getAttribute('start')||'';
    const st = p.getAttribute('stop')||'';
    progs.push({
      cid,
      start: toEpoch(s),
      stop: toEpoch(st),
      title: (p.querySelector('title')||{textContent:''}).textContent.trim() || '(sin título)',
    });
  });
  progs.sort((a,b) => a.start - b.start);
  return { channels, progs };
}

function toEpoch(s){
  // XMLTV: AAAAmmddHHMMSS [±ZZzz]
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if(!m) return 0;
  const off = m[7] ? ((+m[7].slice(0,3)) * 3600 + (+m[7].slice(3) * 60)) : 0; // segundos offset UTC
  return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]) - off*1000;
}

function epgFor(ch){
  if(!state.epg) return null;
  const now = Date.now();
  const tvg = (ch.tvg||'').toLowerCase();
  // match por tvg-id exacto, luego por nombre normalizado
  let cid = null;
  if(tvg && state.epg.channels[tvg]) cid = tvg;
  else{
    const key = String(ch.name||'').toLowerCase();
    if(state.epg.channels[key]) cid = key;
    else{
      const found = Object.keys(state.epg.channels).find(k =>
        key.includes(k) || k.includes(key)
      );
      if(found) cid = found;
    }
  }
  if(!cid) return null;
  const cur = state.epg.progs.filter(p => p.cid === cid && p.start <= now && p.stop > now);
  const nxt = state.epg.progs.filter(p => p.cid === cid && p.start > now);
  return { now: cur[0] || null, next: nxt[0] || null };
}

function fmtEpg(t){
  if(!t) return '';
  const d = new Date(t);
  return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function updateEpgUi(){
  if(!player.open) return;
  const ch = state.filtered[state.active];
  if(!ch) return;
  const ep = epgFor(ch);
  const box = $('#pl-epg');
  if(!ep || (!ep.now && !ep.next)){
    box.innerHTML = state.epg
      ? `<span class="ep-none">📺 Sin programación para este canal</span>`
      : `<span class="ep-none">➕ Configura EPG en ⚙ Ajustes para ver "Ahora/Siguiente"</span>`;
  }else{
    box.innerHTML =
      (ep.now ? `<div class="ep-row now"><b>● Ahora</b><span class="ep-t">${fmtEpg(ep.now.start)}–${fmtEpg(ep.now.stop)}</span><i>${esc(ep.now.title)}</i></div>` : '') +
      (ep.next ? `<div class="ep-row"><b>Siguiente</b><span class="ep-t">${fmtEpg(ep.next.start)}</span><i>${esc(ep.next.title)}</i></div>` : '');
  }
}

function startEpgTimer(){
  clearInterval(state.epgTimer);
  state.epgTimer = setInterval(updateEpgUi, 30000);
}

/* ================= Reproductor ================= */
function open(i){
  state.active = i;
  const ch = state.filtered[state.active];
  if(!ch) return;
  pushRecent(ch);
  renderGroups();
  $('#pl-name').textContent = ch.name;
  $('#pl-src').textContent = ch.url;
  player.showModal();
  updateEpgUi();
  play(ch);
  video.play().catch(() => {});
}

video.addEventListener('playing', () => setStatus('▶ Reproduciendo'));

function play(ch, retry=0){
  setStatus('Conectando…');
  video.src = '';
  if(state.hls){ state.hls.destroy(); state.hls = null; }
  $('#pl-audio-wrap').classList.add('hide');
  $('#pl-subs-wrap').classList.add('hide');

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
    hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus('▶ Reproduciendo'));
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => fillTracks('audio'));
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => fillTracks('subs'));
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

function fillTracks(kind){
  if(!state.hls) return;
  const tracks = kind === 'audio' ? state.hls.audioTracks : state.hls.subtitleTracks;
  const wrap = $(kind === 'audio' ? '#pl-audio-wrap' : '#pl-subs-wrap');
  if(!tracks || !tracks.length){ wrap.classList.add('hide'); return; }
  if(tracks.length <= 1){ wrap.classList.add('hide'); return; }
  const sel = $(kind === 'audio' ? '#pl-audio' : '#pl-subs');
  const label = tr => tr.name || tr.lang || ('Pista');
  sel.innerHTML = '<option value="auto">Auto</option>' +
    tracks.map((tr, idx) => {
      const val = kind === 'subs' ? idx : tr.id;
      const prefix = kind === 'subs' ? 'Sí · ' : '';
      return `<option value="${val}">${prefix}${esc(label(tr))}</option>`;
    }).join('');
  wrap.classList.remove('hide');
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
  updateEpgUi();
  play(ch);
}
function prev(){
  if(!state.filtered.length) return;
  state.active = (state.active - 1 + state.filtered.length) % state.filtered.length;
  const ch = state.filtered[state.active];
  $('#pl-name').textContent = ch.name;
  $('#pl-src').textContent = ch.url;
  updateEpgUi();
  play(ch);
}

/* ================= Ajustes ================= */
function openSettings(){
  $('#set-epg').value = state.epgUrl || '';
  $('#dlg-settings').showModal();
}
function saveSettings(){
  const u = $('#set-epg').value.trim();
  state.epgUrl = u;
  if(u) localStorage.setItem(EPG_URL_KEY, u);
  else localStorage.removeItem(EPG_URL_KEY);
  $('#dlg-settings').close();
  loadEpg(true);
}
function updateEpgStateLine(){
  if(!state.epgUrl) $('#epg-state').textContent = 'Sin EPG configurado.';
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

$('#btn-settings').addEventListener('click', openSettings);
$('#set-save').addEventListener('click', saveSettings);
$('#set-close').addEventListener('click', () => $('#dlg-settings').close());
$('#set-test').addEventListener('click', () => {
  const u = $('#set-epg').value.trim();
  if(!u){ $('#epg-state').textContent = 'Pega una URL XMLTV primero.'; return; }
  state.epgUrl = u;
  loadEpg(true);
});

// velocidad
let speedIdx = 2;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
$('#pl-speed').addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  video.playbackRate = SPEEDS[speedIdx];
  $('#pl-speed').textContent = '⏩ ' + SPEEDS[speedIdx] + 'x';
});

// pista de audio
$('#pl-audio').addEventListener('change', e => {
  if(!state.hls) return;
  const v = e.target.value;
  state.hls.audioTrack = v === 'auto' ? -1 : parseInt(v, 10);
});
// subtítulos (auto = apagados)
$('#pl-subs').addEventListener('change', e => {
  if(!state.hls) return;
  const v = e.target.value;
  state.hls.subtitleTrack = v === 'auto' ? -1 : parseInt(v, 10);
});

// pantalla completa
$('#pl-full').addEventListener('click', () => {
  const el = document.fullscreenElement ? document : player;
  if(!document.fullscreenElement){
    if(player.requestFullscreen) player.requestFullscreen().catch(() => {});
  }else{
    if(document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }
});

document.addEventListener('keydown', e => {
  if(!player.open) return;
  if(e.key === 'ArrowRight') next();
  if(e.key === 'ArrowLeft') prev();
  if(e.key === 'Escape') $('#pl-close').click();
});

/* ================= Arranque ================= */
loadSources();
startEpgTimer();