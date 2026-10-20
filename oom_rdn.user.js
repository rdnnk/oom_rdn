// ==UserScript==
// @name         RDN WME Open Other Maps
// @namespace    https://github.com/rdnnk/oom_rdn
// @author       rdnnk
// @version      2026.10.20.01
// @description  Quick links to open external maps at the current WME location. Migrated to the WME SDK (no WazeWrap / OpenLayers).
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/*editor*
// @match        *://www.google.com/maps*
// @match        https://www.waze.com/partnerhub/*
// @match        https://ipi.eprostor.gov.si/jv*
// @exclude      https://www.waze.com/user/editor*
// @require      https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js
// @connect      www.google.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceURL
// @resource     GMaps     https://www.google.com/s2/favicons?domain=maps.google.com&sz=64
// @resource     hub       https://www.google.com/s2/favicons?domain=waze.com&sz=64
// @resource     Mapillary https://www.google.com/s2/favicons?domain=mapillary.com&sz=64
// @resource     eprostor  https://www.google.com/s2/favicons?domain=eprostor.gov.si&sz=64
// @resource     akos      https://www.google.com/s2/favicons?domain=akos-rs.si&sz=64
// @resource     Bing      https://www.google.com/s2/favicons?domain=bing.com&sz=64
// @resource     OSM       https://www.google.com/s2/favicons?domain=openstreetmap.org&sz=64
// @resource     Here      https://www.google.com/s2/favicons?domain=here.com&sz=64
// @resource     Roadworks https://www.google.com/s2/favicons?domain=roadworks.org&sz=64
// @resource     Melvin    https://www.google.com/s2/favicons?domain=waze.cc&sz=64
// @updateURL    https://raw.githubusercontent.com/rdnnk/oom_rdn/main/oom_rdn.user.js
// @downloadURL  https://raw.githubusercontent.com/rdnnk/oom_rdn/main/oom_rdn.user.js
// @noframes
// ==/UserScript==

/* global proj4, getWmeSdk, unsafeWindow, I18n, GM_getResourceURL */

(function () {
  'use strict';

  // ==========================================================================
  // HOW THIS SCRIPT IS ORGANISED  (read me first)
  //
  // The same file runs in three different places. The "Bootstrap" section at
  // the very bottom looks at the current address and decides which one applies:
  //
  //   1. The Waze Map Editor (WME)     - the main feature: a row of buttons
  //                                      that open external maps at the current
  //                                      location, a settings tab, and the
  //                                      Google MyMap overlay.
  //   2. Google Maps (google.com/maps) - a single "WME" button that opens the
  //                                      editor at the spot you are viewing.
  //   3. The eProstor JV map viewer    - auto-fills its coordinate box so the
  //                                      viewer jumps to the WME location.
  //
  // TO ADD A NEW EXTERNAL MAP: add one entry to the MAPS array further down.
  // Each entry is plain data plus a url() function that builds the link from
  // the current centre and zoom. Nothing else needs to change.
  // ==========================================================================

  // Copies text to the clipboard. Tries the modern API first and falls back to
  // the old "select a hidden input and execCommand" trick for older browsers.
  function copyToClipboard(str) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(str); return; }
    } catch (_) {}
    const tmp = document.createElement('input');
    document.body.appendChild(tmp);
    tmp.value = str;
    tmp.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(tmp);
  }

  // ----------------------------------------------------------------------------
  // Reverse direction: an "open in WME" button on other map sites (Google Maps
  // and the Waze Partner Hub map tool). These pages do not have the WME SDK, so
  // we work out the location from the page's URL and build an editor link.
  // ----------------------------------------------------------------------------

  // Waze environment the editor link should open in:
  //   'row' = Rest of World (includes Slovenia), 'usa' = United States, 'il' = Israel.
  const EDITOR_ENV = 'row';

  // The editor's zoomLevel uses the same scale as web maps (~12 = region,
  // ~17 = street level, up to 22). We pass the web zoom straight through and
  // clamp it to the range the editor accepts.
  function editorZoom(webZoom) {
    let zoom = parseInt(webZoom, 10);
    if (Number.isNaN(zoom)) zoom = 17;
    return Math.max(12, Math.min(22, zoom));
  }

  // Builds a WME editor link, e.g.
  //   https://www.waze.com/en-US/editor?env=row&lat=46.06201&lon=14.52172&zoomLevel=17
  function editorUrl(lat, lon, webZoom) {
    return 'https://www.waze.com/en-US/editor?env=' + EDITOR_ENV +
      `&lat=${lat}&lon=${lon}&zoomLevel=${editorZoom(webZoom)}`;
  }

  // Google Maps keeps the view in the URL as ".../@<lat>,<lon>,<zoom>z".
  function googleMapsToWaze() {
    const afterAt = location.href.split('@').pop();
    const parts = afterAt.split(',');
    const lat = parts[0];
    const lon = parts[1];
    const zoom = parts[2];
    return editorUrl(lat, lon, zoom);
  }

  // Partner Hub map tool. The forward link we generate uses ?lat=&lon=, so we
  // look for those (and a few common alternatives) in the URL query and hash.
  // Returns a WME link, or null if no coordinates could be found in the URL.
  function partnerHubToWaze() {
    function paramsFrom(str) {
      return new URLSearchParams(str.replace(/^[?#]/, ''));
    }
    const query = paramsFrom(location.search);
    const hash = paramsFrom(location.hash);

    function pick(names) {
      for (let i = 0; i < names.length; i++) {
        const value = query.get(names[i]) || hash.get(names[i]);
        if (value) {
          return value;
        }
      }
      return null;
    }

    const lat = pick(['lat', 'latitude']);
    const lon = pick(['lon', 'lng', 'longitude']);
    const zoom = pick(['zoomLevel', 'zoom', 'z']);
    if (!lat || !lon) {
      return null;
    }
    return editorUrl(lat, lon, zoom);
  }

  // Injects a small fixed "WME" button. computeUrl() returns the editor link to
  // open, or null if the current location could not be read from the page.
  // rightPx sets the distance from the right edge of the window (default 30).
  // missingMessage is shown if the location can't be read (default is generic).
  function addWmeOpenButton(computeUrl, rightPx, missingMessage) {
    if (document.getElementById('OOMWazeButtonDiv')) {
      return;
    }
    const right = (typeof rightPx === 'number') ? rightPx : 30;
    const noLocationMessage = missingMessage ||
      'Open Other Maps: could not read the current location from this page.';
    const el = document.createElement('div');
    el.id = 'OOMWazeButtonDiv';
    el.title = 'Open in WME (Ctrl+C copies the WME link)';
    el.textContent = 'WME';
    el.style.cssText =
      `position:fixed;right:${right}px;top:75px;z-index:9999;width:40px;height:30px;` +
      'background:#33ccff;color:#fff;font:bold 13px Arial,sans-serif;border-radius:4px;' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'box-shadow:0 1px 4px rgba(0,0,0,0.4);';
    document.body.appendChild(el);

    function openInWme() {
      const url = computeUrl();
      if (url) {
        window.open(url);
      } else {
        alert(noLocationMessage);
      }
    }

    function copyHotkey(e) {
      if ((e.metaKey || e.ctrlKey) && e.which === 67) {
        const url = computeUrl();
        if (url) {
          copyToClipboard(url);
        }
      }
    }

    el.addEventListener('click', openInWme);
    el.addEventListener('mouseenter', () => document.addEventListener('keydown', copyHotkey));
    el.addEventListener('mouseleave', () => document.removeEventListener('keydown', copyHotkey));
  }

  // Google Maps and the Partner Hub are single-page apps: they re-render and
  // navigate without a full page reload, which can remove our button from the
  // page. So we add it now and then re-add it whenever it goes missing - the
  // same approach as the WME bottom-bar watcher further down.
  function watchWmeButton(computeUrl, rightPx, missingMessage) {
    addWmeOpenButton(computeUrl, rightPx, missingMessage);
    setInterval(() => {
      const el = document.getElementById('OOMWazeButtonDiv');
      if (!el || !el.isConnected) {
        addWmeOpenButton(computeUrl, rightPx, missingMessage);
      }
    }, 1500);
  }

  function initGoogleMaps() {
    watchWmeButton(googleMapsToWaze);
  }

  function initPartnerHub() {
    const message =
      'Open Other Maps: the Partner Hub has not set a location yet.\n\n' +
      'Click anywhere on the map first so the coordinates appear in the address bar, ' +
      'then press the WME button again.';
    watchWmeButton(partnerHubToWaze, 60, message); // sits further from the right edge than the default
  }

  // ----------------------------------------------------------------------------
  // eProstor JV (Javni vpogled) viewer side: auto-fill the coordinate input box
  // from the hash we set when opening it from WME (#oom=E,N in D96/TM). The app
  // is Angular with no URL centering param, so we drive the input directly.
  // Best-effort; the clipboard copy on the WME side is the guaranteed fallback.
  // ----------------------------------------------------------------------------
  // Types a value into the JV coordinate box and presses Enter, the way the
  // viewer expects (per the JV manual: type "E, N", press Enter, the map jumps
  // there).
  //
  // Why the unusual "native value setter" line below: the JV viewer is built
  // with Angular, which only updates its internal model when the browser fires
  // an "input" event on the field. A plain `input.value = value` changes what
  // you see but Angular keeps the old (empty) value, so Enter does nothing. The
  // accepted workaround is to call the browser's own built-in value setter and
  // then dispatch the "input" event ourselves - this mimics a real keystroke.
  function fillCoord(input, value) {
    const valueProperty = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    const nativeValueSetter = valueProperty.set;
    nativeValueSetter.call(input, value);

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();

    // Simulate pressing Enter. Different frameworks listen to different parts of
    // a keypress, so we send all three events.
    const enterOptions = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    input.dispatchEvent(new KeyboardEvent('keydown', enterOptions));
    input.dispatchEvent(new KeyboardEvent('keypress', enterOptions));
    input.dispatchEvent(new KeyboardEvent('keyup', enterOptions));
  }

  function initEprostorViewer() {
    const m = location.hash.match(/oom=(-?[\d.]+),(-?[\d.]+)/);
    if (!m) return;
    const coordStr = `${m[1]}, ${m[2]}`; // D96/TM "E, N" — an accepted form per the JV manual
    let tries = 0;
    const timer = setInterval(() => {
      const input = document.querySelector('input[aria-label="koordinate"]');
      if (input) {
        clearInterval(timer);
        fillCoord(input, coordStr);
        // The SPA can bind its handlers a beat after the box renders; re-fill once.
        setTimeout(() => fillCoord(input, coordStr), 1200);
      } else if (++tries > 60) { // give up after ~30s
        clearInterval(timer);
      }
    }, 500);
  }

  // ============================================================================
  // From here on: WME side (SDK).
  // ============================================================================

  let wmeSDK;

  const MYMAP_LAYER = 'oom-mymap';
  const SETTINGS_KEY = 'OOM_Settings_SDK';
  const MAX_ZOOM = 21;

  // AKOS uses its own zoom scale; map WME (new-style, ~16-22) zoom onto it.
  function akosZoom(z) {
    if (z >= 20) return 14;
    if (z === 19) return 13;
    if (z === 18) return 12;
    if (z === 17) return 10;
    if (z <= 16) return 8;
    return 14;
  }

  // Each entry: key, label, short (badge text), color, active (whether the map
  // is enabled by default), and a url(center, zoom, lang) builder.
  // center = { lon, lat } (WGS84). zoom = clamped WME zoom level.
  const MAPS = [
    { key: 'GMaps',     label: 'Google Maps',     short: 'G',   color: '#1a73e8', active: true,
      url: (c, z, lang) => {
        const link = `https://www.google.com/maps/@${c.lat},${c.lon},${z}z`;
        return lang ? `${link}?hl=${lang}` : link;
      } },
    { key: 'hub',       label: 'Partner Hub',     short: 'Hub', color: '#0099ff', active: true,
      url: (c) => `https://www.waze.com/partnerhub/map-tool?lat=${c.lat}&lon=${c.lon}` },
    { key: 'Mapillary', label: 'Mapillary',       short: 'Ma',  color: '#05cb63', active: true,
      url: (c, z) => `https://www.mapillary.com/app/?lat=${c.lat}&lng=${c.lon}&z=${z}` },
    { key: 'eprostor',  label: 'eProstor',        short: 'eP',  color: '#2e7d32', active: true,
      // The JV (Javni vpogled) viewer has no centering URL param — only a manual
      // coordinate input box that accepts SI-D96/TM (EPSG:3794) E,N. So we copy
      // the coords to the clipboard AND pass them in the hash; the companion
      // handler on the JV page (initEprostorViewer) tries to auto-fill the box.
      url: (c) => {
        const [e, n] = proj4('EPSG:4326', 'EPSG:3794', [c.lon, c.lat]);
        return `https://ipi.eprostor.gov.si/jv/#oom=${e.toFixed(2)},${n.toFixed(2)}`;
      },
      clip: (c) => {
        const [e, n] = proj4('EPSG:4326', 'EPSG:3794', [c.lon, c.lat]);
        return `${e.toFixed(2)}, ${n.toFixed(2)}`;
      } },
    { key: 'akos',      label: 'AKOS',            short: 'AK',  color: '#003f87', active: true,
      url: (c, z) => {
        const [e, n] = proj4('EPSG:4326', 'EPSG:3794', [c.lon, c.lat]);
        return `https://gis.akos-rs.si?zoom_level=${akosZoom(z)}&cx=${e}&cy=${n}&visible_layers=hs,grp_dof,grp_podlage,naselja&use_map_state=0`;
      } },
    { key: 'Bing',      label: 'Bing Maps',       short: 'B',   color: '#008373', active: false,
      url: (c, z) => `https://www.bing.com/maps?&cp=${c.lat}~${c.lon}&lvl=${z}` },
    { key: 'OSM',       label: 'OpenStreetMap',   short: 'OSM', color: '#7ebc6f', active: true,
      url: (c, z) => `https://www.openstreetmap.org/#map=${z}/${c.lat}/${c.lon}` },
    { key: 'Here',      label: 'HERE',            short: 'He',  color: '#00908a', active: false,
      url: (c, z) => `https://mapcreator.here.com/?l=${c.lat},${c.lon},${z},satellite` },
    { key: 'Roadworks', label: 'Roadworks',       short: 'RW',  color: '#f9a825', active: false,
      url: (c, z) => `https://roadworks.org/?lng=${c.lon}&lat=${c.lat}&zoom=${z}` },
    { key: 'Melvin',    label: 'Melvin (RdN_RW)', short: 'Mv',  color: '#616161', active: false,
      url: (c) => `https://waze.cc/roadworks/rwzoek.php?zD=0.015&zX=${c.lat}&zY=${c.lon}` }
  ];

  // --- Badges (CSS, no images — nothing to truncate) --------------------------
  function badgeFont(short, size) {
    return short.length >= 3 ? Math.round(size * 0.34) : Math.round(size * 0.46);
  }

  function makeBadge(m, size) {
    const d = document.createElement('div');
    d.textContent = m.short;
    d.title = `Open in ${m.label}`;
    d.style.cssText =
      `box-sizing:border-box;width:${size}px;height:${size}px;border-radius:4px;` +
      `background:${m.color};color:#fff;font:bold ${badgeFont(m.short, size)}px Arial,sans-serif;` +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;flex:0 0 auto;';
    return d;
  }

  function swatchHtml(m, size) {
    return `<span style="box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;` +
      `width:${size}px;height:${size}px;border-radius:3px;background:${m.color};color:#fff;` +
      `font:bold ${badgeFont(m.short, size)}px Arial,sans-serif;vertical-align:middle;margin-right:6px;">${m.short}</span>`;
  }

  // Favicon resource (fetched by the userscript manager at install/update time,
  // served from a local URL so the page CSP doesn't block it).
  function resourceUrl(key) {
    try {
      if (typeof GM_getResourceURL === 'function') {
        const u = GM_getResourceURL(key);
        if (u) return u;
      }
    } catch (_) {}
    return null;
  }

  // Favicon <img> when available, else the CSS letter badge. If the favicon
  // fails to load (CSP / 404 / blocked), it swaps itself out for the badge.
  function makeIconEl(m, size) {
    const url = resourceUrl(m.key);
    if (!url) return makeBadge(m, size);
    const img = document.createElement('img');
    img.src = url;
    img.width = size;
    img.height = size;
    img.title = `Open in ${m.label}`;
    img.style.cssText =
      `box-sizing:border-box;width:${size}px;height:${size}px;border-radius:3px;` +
      'object-fit:contain;display:block;flex:0 0 auto;';
    img.addEventListener('error', () => { img.replaceWith(makeBadge(m, size)); });
    return img;
  }

  // --- Settings ---------------------------------------------------------------
  function defaultSettings() {
    const enabled = {};
    MAPS.forEach(m => { enabled[m.key] = m.active; });
    return { enabled, lang: 1, custLang: '', myMapVisible: true };
  }

  function loadSettings() {
    let s;
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (_) { s = null; }
    const def = defaultSettings();
    if (!s) return def;
    s.enabled = Object.assign({}, def.enabled, s.enabled || {});
    if (s.lang == null) s.lang = def.lang;
    if (s.custLang == null) s.custLang = def.custLang;
    if (s.myMapVisible == null) s.myMapVisible = def.myMapVisible;
    return s;
  }

  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
  }

  // --- Notifications ----------------------------------------------------------
  function toast(text, type = 'info') {
    const canUseSdkNotification =
      wmeSDK && wmeSDK.Notifications && typeof wmeSDK.Notifications.show === 'function';
    if (canUseSdkNotification) {
      try {
        wmeSDK.Notifications.show({ text, type, timeout: 3500 });
        return;
      } catch (_) { /* fall through to the console below */ }
    }
    console.info(`[OOM] ${text}`);
  }

  // --- Map position helpers ---------------------------------------------------
  // Returns the centre of the current map view as { lon, lat } in WGS84.
  function getCenterLonLat() {
    const ext = wmeSDK.Map.getMapExtent();

    // The SDK returns the extent either as an array [west, south, east, north]
    // or as an object with named edges; handle both.
    let lonMin, latMin, lonMax, latMax;
    if (Array.isArray(ext)) {
      [lonMin, latMin, lonMax, latMax] = ext;
    } else {
      lonMin = ext.lonMin;
      latMin = ext.latMin;
      lonMax = ext.lonMax;
      latMax = ext.latMax;
    }

    const lon = (lonMin + lonMax) / 2;
    const lat = (latMin + latMax) / 2;

    // Round to 6 decimal places (~0.1 m) so the URLs stay short.
    return { lon: Math.round(lon * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6 };
  }

  function getZoom() {
    return Math.min(MAX_ZOOM, Math.max(1, Math.round(wmeSDK.Map.getZoomLevel())));
  }

  // Checks that the SDK actually provides a feature before we rely on it.
  // dottedPath looks like "Map.getZoomLevel"; we walk it one step at a time and
  // return false the moment something along the way is missing.
  function wmeSdkHasApi(dottedPath) {
    const parts = dottedPath.split('.');
    let node = wmeSDK;
    for (let i = 0; i < parts.length; i++) {
      if (node == null) {
        return false;
      }
      node = node[parts[i]];
    }
    return node != null;
  }

  function getLanguage(settings) {
    if (settings.lang === 0) return '';
    if (settings.lang === 1) {
      try { return I18n.currentLocale().replace('en-US', 'en'); } catch (_) { return 'en'; }
    }
    return settings.custLang || '';
  }

  function openMap(mapDef, settings) {
    const center = getCenterLonLat();
    const zoom = getZoom();
    const lang = getLanguage(settings);
    if (mapDef.clip) {
      copyToClipboard(mapDef.clip(center));
      toast('eProstor D96/TM coordinates copied — paste into the box if it does not auto-fill', 'info');
    }
    window.open(mapDef.url(center, zoom, lang), mapDef.key);
  }

  // --- Button bar -------------------------------------------------------------
  // Docks into WME's bottom control bar, as a sibling of the tile-build-status
  // widget (NOT inside it — that widget's text re-renders and would wipe us).
  // Falls back to a small floating panel on #map if that bar isn't present.
  let barSettings = null;
  const BADGE_SIZE = 18;

  function getBottomBar() {
    const status = document.querySelector('.tile-build-status');
    return status ? status.parentElement : null;
  }

  function fillBar(bar) {
    bar.innerHTML = '';
    MAPS.forEach(m => {
      if (!barSettings.enabled[m.key]) return;
      const wrap = document.createElement('div');
      wrap.title = `Open in ${m.label}`;
      wrap.style.cssText = 'display:flex;align-items:center;cursor:pointer;flex:0 0 auto;';
      wrap.appendChild(makeIconEl(m, BADGE_SIZE));
      wrap.addEventListener('click', () => openMap(m, barSettings));
      bar.appendChild(wrap);
    });
    bar.style.display = bar.childElementCount ? 'flex' : 'none';
  }

  function mountBar(settings) {
    if (settings) barSettings = settings;
    if (!barSettings) return;

    const host = getBottomBar();
    let bar = document.getElementById('oom-bar');

    if (host) {
      // Docked inline in the bottom bar.
      if (!bar || bar.parentElement !== host) {
        if (bar) bar.remove();
        bar = document.createElement('div');
        bar.id = 'oom-bar';
        bar.style.cssText = 'display:flex;gap:5px;align-items:center;margin:0 10px;height:100%;';
        host.insertBefore(bar, host.firstChild);
      }
    } else {
      // Fallback: float on the map, top-left, away from the bottom controls.
      const mapEl = document.getElementById('map');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'oom-bar';
        if (mapEl) mapEl.appendChild(bar);
      }
      bar.style.cssText =
        'position:absolute;top:8px;left:8px;z-index:1000;display:flex;gap:5px;align-items:center;' +
        'padding:4px 6px;background:rgba(255,255,255,0.85);border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,0.3);';
    }
    fillBar(bar);
  }

  // WME re-renders the bottom bar (tile-build text ticks), which can drop our
  // node. A cheap periodic check re-mounts it whenever it goes missing.
  function watchBar(settings) {
    barSettings = settings;
    setInterval(() => {
      const bar = document.getElementById('oom-bar');
      if (!bar || !bar.isConnected) mountBar();
    }, 1500);
  }

  // --- Google MyMap KML overlay (SDK layer + GeoJSON) -------------------------
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (res) => (res.status < 400 ? resolve(res.responseText) : reject(new Error('HTTP ' + res.status))),
        onerror: (res) => reject(new Error(res.statusText || 'request error'))
      });
    });
  }

  function kmlToGeoJson(kmlText) {
    const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
    const placemarks = Array.from(dom.getElementsByTagName('Placemark'));

    // KML stores coordinates as "lon,lat lon,lat ..." (space separated).
    // Turn that string into an array of [lon, lat] pairs.
    function parseCoords(text) {
      const tokens = text.trim().split(/\s+/);
      const points = [];
      for (let i = 0; i < tokens.length; i++) {
        const piece = tokens[i].split(',');
        const lon = Number(piece[0]);
        const lat = Number(piece[1]);
        points.push([lon, lat]);
      }
      return points;
    }

    // Returns the text inside the first matching child tag, or '' if there is none.
    function firstTagText(parent, tagName) {
      const el = parent.getElementsByTagName(tagName)[0];
      return el ? el.textContent : '';
    }

    const features = [];
    let nextId = 0;

    placemarks.forEach(pm => {
      const name = firstTagText(pm, 'name');
      const point = pm.getElementsByTagName('Point')[0];
      const line = pm.getElementsByTagName('LineString')[0];
      const polygon = pm.getElementsByTagName('Polygon')[0];

      let geometry = null;
      if (point) {
        const coords = parseCoords(firstTagText(point, 'coordinates'));
        geometry = { type: 'Point', coordinates: coords[0] };
      } else if (line) {
        const coords = parseCoords(firstTagText(line, 'coordinates'));
        geometry = { type: 'LineString', coordinates: coords };
      } else if (polygon) {
        const coords = parseCoords(firstTagText(polygon, 'coordinates'));
        geometry = { type: 'Polygon', coordinates: [coords] };
      }
      if (!geometry) {
        return; // skip placemarks we don't draw (folders, styles, etc.)
      }

      features.push({
        type: 'Feature',
        id: `oom-mymap-${nextId}`,
        geometry,
        properties: { name, kind: geometry.type }
      });
      nextId++;
    });

    return features;
  }

  function addMyMapLayer() {
    wmeSDK.Map.addLayer({
      layerName: MYMAP_LAYER,
      zIndexing: true,
      styleRules: [
        {
          predicate: (p) => p.kind === 'Point',
          style: { graphicName: 'circle', pointRadius: 6, fillColor: '#4285F4', fillOpacity: 0.9, strokeColor: '#ffffff', strokeWidth: 2 }
        },
        {
          predicate: (p) => p.kind === 'LineString',
          style: { strokeColor: '#4285F4', strokeWidth: 3, strokeOpacity: 0.9, fill: false }
        },
        {
          predicate: (p) => p.kind === 'Polygon',
          style: { strokeColor: '#4285F4', strokeWidth: 2, strokeOpacity: 0.9, fillColor: '#4285F4', fillOpacity: 0.2 }
        }
      ]
    });
    wmeSDK.Map.setLayerVisibility({ layerName: MYMAP_LAYER, visibility: true });
  }

  let myMapFeatureIds = [];

  function clearMyMap() {
    if (myMapFeatureIds.length) {
      try { wmeSDK.Map.removeFeaturesFromLayer({ layerName: MYMAP_LAYER, featureIds: myMapFeatureIds }); } catch (_) {}
      myMapFeatureIds = [];
    }
  }

  async function loadMyMap(url) {
    if (!url) return;
    const validUrl = /^(https?:\/\/)?www\.google\.com\/maps/.test(url);
    if (!validUrl) {
      toast('That is not a valid Google MyMap URL', 'error');
      return;
    }
    const midMatch = url.match(/mid=([^&]+)/);
    if (!midMatch) {
      toast('Could not find a map id (mid) in that URL', 'error');
      return;
    }
    const mid = midMatch[1];
    try {
      const kml = await gmFetch(`https://www.google.com/maps/d/kml?mid=${mid}&forcekml=1`);
      const features = kmlToGeoJson(kml);
      if (!features.length) {
        toast('No drawable features found in that MyMap', 'warning');
        return;
      }
      clearMyMap();
      wmeSDK.Map.addFeaturesToLayer({ layerName: MYMAP_LAYER, features });
      myMapFeatureIds = features.map(f => f.id);
      wmeSDK.Map.setLayerVisibility({ layerName: MYMAP_LAYER, visibility: true });
      toast(`Loaded ${features.length} MyMap features`, 'success');
    } catch (err) {
      console.error('[OOM] MyMap load failed:', err);
      toast('Failed to load MyMap. See console.', 'error');
    }
  }

  // --- Sidebar tab ------------------------------------------------------------
  function buildTab(tabLabel, tabPane, settings) {
    tabLabel.innerText = 'OOM';
    tabLabel.title = 'Open Other Maps';

    // WME's <wz-checkbox> reports its state through a "checked" attribute
    // (present = checked) rather than a normal .checked property.
    function isChecked(el) {
      return el ? el.hasAttribute('checked') : false;
    }
    function setChecked(el, checked) {
      if (checked) {
        el.setAttribute('checked', '');
      } else {
        el.removeAttribute('checked');
      }
    }

    const mapRows = MAPS.map(m =>
      `<div style="margin:2px 0;"><wz-checkbox data-map="${m.key}"${settings.enabled[m.key] ? ' checked' : ''}>` +
      `<span class="oom-tab-ico" data-key="${m.key}"></span>${m.label}</wz-checkbox></div>`
    ).join('');

    tabPane.innerHTML = `
      <div style="padding:10px;">
        <h2 style="margin-top:0;">Open Other Maps</h2>
        <p style="font-size:12px;color:#555;">
          External maps are for <b style="color:#c00;">reference only</b> — never copy data from them
          (it violates Waze's external-sources policy).
        </p>
        <fieldset style="border:1px solid #ccc;border-radius:4px;padding:8px;">
          <legend style="font-weight:bold;">Map buttons</legend>
          ${mapRows}
        </fieldset>
        <fieldset style="border:1px solid #ccc;border-radius:4px;padding:8px;margin-top:8px;">
          <legend style="font-weight:bold;">Map language (Google Maps)</legend>
          <label style="display:block;font-size:12px;"><input type="radio" name="oomLang" value="0"${settings.lang === 0 ? ' checked' : ''}> Do not set a language</label>
          <label style="display:block;font-size:12px;"><input type="radio" name="oomLang" value="1"${settings.lang === 1 ? ' checked' : ''}> Use WME language</label>
          <label style="display:block;font-size:12px;"><input type="radio" name="oomLang" value="2"${settings.lang === 2 ? ' checked' : ''}> Custom:
            <input type="text" id="oomCustLang" value="${settings.custLang}" size="4" style="border:1px solid #000;width:50px;"></label>
        </fieldset>
        <fieldset style="border:1px solid #ccc;border-radius:4px;padding:8px;margin-top:8px;">
          <legend style="font-weight:bold;">Overlay Google MyMap</legend>
          <input type="text" id="oomMyMapUrl" placeholder="MyMap link" style="width:100%;box-sizing:border-box;margin-bottom:6px;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <button id="oomMyMapLoad" class="wz-button">Load MyMap</button>
            <button id="oomMyMapClear" class="wz-button wz-button--secondary">Clear</button>
            <wz-checkbox id="oomMyMapVisible"${settings.myMapVisible ? ' checked' : ''}>Show layer</wz-checkbox>
          </div>
        </fieldset>
      </div>
    `;

    // Fill the row icons (favicon, or letter badge fallback).
    tabPane.querySelectorAll('.oom-tab-ico[data-key]').forEach(span => {
      const m = MAPS.find(x => x.key === span.getAttribute('data-key'));
      if (!m) return;
      const holder = document.createElement('span');
      holder.style.cssText = 'display:inline-flex;vertical-align:middle;margin-right:6px;';
      holder.appendChild(makeIconEl(m, 16));
      span.replaceWith(holder);
    });

    // Map toggles
    tabPane.querySelectorAll('wz-checkbox[data-map]').forEach(cb => {
      cb.addEventListener('click', () => {
        const key = cb.getAttribute('data-map');
        const next = !isChecked(cb);
        setChecked(cb, next);
        settings.enabled[key] = next;
        saveSettings(settings);
        mountBar(settings);
      });
    });

    // Language
    tabPane.querySelectorAll('input[name="oomLang"]').forEach(r => {
      r.addEventListener('change', () => {
        settings.lang = Number(r.value);
        saveSettings(settings);
      });
    });
    tabPane.querySelector('#oomCustLang').addEventListener('change', (e) => {
      settings.custLang = e.target.value;
      saveSettings(settings);
    });

    // MyMap
    tabPane.querySelector('#oomMyMapLoad').addEventListener('click', () => {
      loadMyMap(tabPane.querySelector('#oomMyMapUrl').value.trim());
    });
    tabPane.querySelector('#oomMyMapClear').addEventListener('click', clearMyMap);
    const visCb = tabPane.querySelector('#oomMyMapVisible');
    visCb.addEventListener('click', () => {
      const next = !isChecked(visCb);
      setChecked(visCb, next);
      settings.myMapVisible = next;
      saveSettings(settings);
      wmeSDK.Map.setLayerVisibility({ layerName: MYMAP_LAYER, visibility: next });
    });
  }

  // --- Init -------------------------------------------------------------------
  function init() {
    // EPSG:3794 (Slovenia D96/TM) for eProstor + AKOS
    if (!proj4.defs['EPSG:3794']) {
      proj4.defs(
        'EPSG:3794',
        '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
      );
    }

    const settings = loadSettings();

    addMyMapLayer();
    wmeSDK.Map.setLayerVisibility({ layerName: MYMAP_LAYER, visibility: settings.myMapVisible });

    mountBar(settings);
    watchBar(settings);

    wmeSDK.Sidebar.registerScriptTab().then(({ tabLabel, tabPane }) => {
      buildTab(tabLabel, tabPane, settings);
    });
  }

  // --- Bootstrap --------------------------------------------------------------
  if (location.hostname === 'ipi.eprostor.gov.si') {
    initEprostorViewer();
    return;
  }
  if (location.hostname.endsWith('google.com') && location.pathname.includes('/maps')) {
    initGoogleMaps();
    return;
  }
  if (location.hostname === 'www.waze.com' && location.pathname.startsWith('/partnerhub')) {
    initPartnerHub();
    return;
  }

  const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
  if (!root.SDK_INITIALIZED) {
    console.error('[OOM] SDK_INITIALIZED not found — is the WME SDK available on this page?');
    return;
  }

  root.SDK_INITIALIZED.then(() => {
    wmeSDK = getWmeSdk({ scriptId: 'rdn-open-other-maps', scriptName: 'RDN WME Open Other Maps' });
    wmeSDK.Events.once({ eventName: 'wme-ready' }).then(() => {
      const requiredApis = [
        'Map.getMapExtent',
        'Map.getZoomLevel',
        'Map.addLayer',
        'Map.addFeaturesToLayer',
        'Map.removeFeaturesFromLayer',
        'Map.setLayerVisibility',
        'Sidebar.registerScriptTab'
      ];

      const missing = [];
      for (let i = 0; i < requiredApis.length; i++) {
        if (!wmeSdkHasApi(requiredApis[i])) {
          missing.push(requiredApis[i]);
        }
      }

      if (missing.length > 0) {
        console.error('[OOM] WME SDK missing required APIs:', missing);
        toast(`OOM: WME SDK is missing ${missing.length} required APIs. See console.`, 'error');
        return;
      }
      init();
    });
  });
})();
