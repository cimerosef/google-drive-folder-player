// ==UserScript==
// @name         Google Drive Folder Player
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.36
// @description  Play a complete Google Drive MP3/WebM folder with direct playback, system media controls, track search/selection, preload, Previous/Pause/Next, Shuffle and Repeat.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.36';
  const PANEL_ID = 'gdfp-player';
  const MINIMIZED_KEY = 'gdfp-player-minimized';
  const PREFS_KEY = 'gdfp-player-prefs';
  const POSITION_KEY = 'gdfp-player-position';
  const LIBRARY_KEY_PREFIX = 'gdfp-library:';
  const MAX_CACHED_LIBRARIES = 20;
  const MEDIA_RE = /([^\/\n\r]{1,320}\.(?:mp3|webm))(?=\s|$)/i;
  const REPEAT_MODES = ['off', 'all', 'one'];

  // Scan tuning. Drive renders a virtualized list and appends ~50 rows per
  // network batch when the list reaches its bottom. Steps wait for the DOM to
  // go quiet instead of sleeping a fixed time; the bottom gets real patience.
  const SCAN_STEP_RATIO = 0.7;
  const SCAN_QUIET_MS = 160;
  const SCAN_STEP_MAX_MS = 1500;
  const SCAN_FIRST_CHANGE_MS = 500;
  const SCAN_BOTTOM_PATIENCE_MS = 3000;
  const SCAN_BOTTOM_EXTRA_PATIENCE_MS = 8000;
  const SCAN_BOTTOM_LOADING_MAX_MS = 12000;
  const SCAN_MAX_STEPS = 400;
  const DRIVE_BATCH_SIZE = 50;
  const MAX_AUTO_SKIPS = 3;

  let discoveredItems = [];
  let playlist = [];
  let currentIndex = -1;
  let shuffleMode = false;
  let repeatMode = 'off';
  let autoMode = false;
  let advancing = false;
  let discoveryRunning = false;
  let stopDiscoveryRequested = false;
  let scanFoundCount = 0;
  let directPrevious = null;
  let directCurrent = null;
  let directNext = null;
  let transitionRequestedAt = 0;
  let logLines = [];
  let trackSearchQuery = '';
  let libraryFolderKey = '';
  let libraryFolderName = '';
  let libraryScannedAt = 0;
  let seekDragging = false;
  const failedIds = new Set();
  const ui = {};

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-160);
    if (ui.log) ui.log.textContent = logLines.join('\n');
    console.log('[GDFP]', text);
  }

  function extensionOf(name) {
    return String(name || '').toLowerCase().endsWith('.webm') ? 'webm' : 'mp3';
  }

  function labelOf(item) {
    return extensionOf(item?.name).toUpperCase();
  }

  function mediaTitleOf(item) {
    return String(item?.name || '').replace(/\.(?:mp3|webm)$/i, '');
  }

  function readJson(storage, key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Media Session (system media controls)
  // ---------------------------------------------------------------------------

  function mediaSessionAvailable() {
    return 'mediaSession' in navigator;
  }

  function syncMediaSessionMetadata(item = playlist[currentIndex]) {
    if (!mediaSessionAvailable() || typeof MediaMetadata !== 'function') return;
    try {
      navigator.mediaSession.metadata = item ? new MediaMetadata({
        title: mediaTitleOf(item),
        artist: 'Google Drive',
        album: libraryFolderName || 'Google Drive Folder Player'
      }) : null;
    } catch (error) {
      log(`Media Session metadata update failed: ${error?.name || 'Error'}.`);
    }
  }

  function syncMediaSessionPlaybackState() {
    if (!mediaSessionAvailable()) return;
    const media = directCurrent?.media;
    const hasCurrent = Boolean(media && currentIndex >= 0 && playlist[currentIndex] && !media.ended);
    const state = hasCurrent ? (media.paused ? 'paused' : 'playing') : 'none';
    try {
      navigator.mediaSession.playbackState = state;
    } catch {}
  }

  function clearMediaSession() {
    if (!mediaSessionAvailable()) return;
    try {
      navigator.mediaSession.playbackState = 'none';
      if (typeof MediaMetadata === 'function') navigator.mediaSession.metadata = null;
      if (typeof navigator.mediaSession.setPositionState === 'function') navigator.mediaSession.setPositionState();
    } catch {}
  }

  function setupMediaSession() {
    if (!mediaSessionAvailable()) {
      log('Media Session API unavailable; system media controls disabled.');
      return;
    }

    const handlers = {
      play: () => {
        const media = directCurrent?.media;
        if (media?.paused && !media.ended) void togglePause();
      },
      pause: () => {
        const media = directCurrent?.media;
        if (media && !media.paused && !media.ended) void togglePause();
      },
      previoustrack: () => void previousNow(),
      nexttrack: () => void nextNow()
    };

    let registered = 0;
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
        registered += 1;
      } catch (error) {
        log(`Media Session action unsupported: ${action} (${error?.name || 'Error'}).`);
      }
    }
    log(`Media Session ready: ${registered}/4 action handler(s) registered.`);
  }

  // ---------------------------------------------------------------------------
  // Drive DOM discovery
  // ---------------------------------------------------------------------------

  function extractName(element) {
    if (!(element instanceof Element)) return '';
    for (const value of [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-tooltip'),
      element.textContent
    ]) {
      if (!value || value.length > 1800) continue;
      const match = value.trim().match(MEDIA_RE);
      if (match) return match[1].trim();
    }
    return '';
  }

  function isInsidePanel(element) {
    return Boolean(element?.closest?.(`#${PANEL_ID}`));
  }

  function isRendered(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element) || isInsidePanel(node)) break;
      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (
        node.hasAttribute('data-id') || node.hasAttribute('data-target') ||
        node.hasAttribute('data-file-id') || node.hasAttribute('data-docid') ||
        node.hasAttribute('data-doc-id')
      ) fallback = node;
    }
    return fallback;
  }

  function idFromHref(value) {
    if (!value) return '';
    try {
      const url = new URL(value, location.href);
      const queryId = url.searchParams.get('id');
      if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
      const fileMatch = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
      return fileMatch?.[1] || '';
    } catch {
      return '';
    }
  }

  function getItemId(root) {
    if (!(root instanceof Element)) return '';
    const attrs = ['data-id', 'data-target', 'data-file-id', 'data-docid', 'data-doc-id'];
    const candidates = [
      root,
      ...root.querySelectorAll('[data-id], [data-target], [data-file-id], [data-docid], [data-doc-id], a[href]')
    ];
    for (const element of candidates) {
      for (const attr of attrs) {
        const value = element.getAttribute?.(attr) || '';
        if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
      }
      const hrefId = idFromHref(element.getAttribute?.('href') || '');
      if (hrefId) return hrefId;
    }
    return '';
  }

  function collectRenderedRows(scope = document) {
    const candidates = scope.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );
    const seenRoots = new Set();
    const rows = [];
    for (const element of candidates) {
      if (!(element instanceof Element) || isInsidePanel(element)) continue;
      const name = extractName(element);
      if (!name) continue;
      const root = findItemRoot(element);
      if (!root || !isRendered(root) || seenRoots.has(root)) continue;
      const id = getItemId(root);
      if (!id) continue;
      seenRoots.add(root);
      rows.push({ name, id, type: extensionOf(name), root, top: root.getBoundingClientRect().top });
    }
    rows.sort((a, b) => a.top - b.top);
    return rows;
  }

  function looksScrollable(element) {
    if (!(element instanceof Element) || isInsidePanel(element)) return false;
    const style = getComputedStyle(element);
    if (!['auto', 'scroll', 'overlay'].includes(style.overflowY)) return false;
    return element.scrollHeight > element.clientHeight + 80 && element.clientHeight > 180;
  }

  function scrollableAncestors(element) {
    const result = [];
    let node = element?.parentElement;
    for (let depth = 0; node && depth < 18; depth += 1, node = node.parentElement) {
      if (looksScrollable(node)) result.push(node);
    }
    return result;
  }

  function findScrollContainer() {
    const rendered = collectRenderedRows();
    const row = rendered[Math.floor(rendered.length / 2)]?.root || rendered[0]?.root;
    if (row) {
      const ancestors = scrollableAncestors(row);
      if (ancestors.length) {
        ancestors.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        return ancestors[0];
      }
    }
    return [...document.querySelectorAll('div, main, section')]
      .filter(looksScrollable)
      .map(element => ({ element, range: element.scrollHeight - element.clientHeight, area: element.clientWidth * element.clientHeight }))
      .filter(item => item.area > 100000)
      .sort((a, b) => b.range - a.range || b.area - a.area)[0]?.element || null;
  }

  function addRowsToMap(map, scope = document) {
    const rows = collectRenderedRows(scope);
    let added = 0;
    for (const row of rows) {
      if (map.has(row.id)) continue;
      map.set(row.id, { id: row.id, name: row.name, type: row.type });
      added += 1;
    }
    return { rows, added };
  }

  // Lowest rendered item row (any file type, in scroll-content coordinates)
  // plus the ids of all rendered item rows. Used for the coverage guard and
  // the Drive batch-boundary check.
  function itemRowExtents(scope, scroller, mediaRows) {
    const scrollerTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const ids = [];
    let bottom = 0;
    for (const row of scope.querySelectorAll('[role="row"], [role="listitem"], [role="option"]')) {
      if (isInsidePanel(row) || !isRendered(row)) continue;
      const id = getItemId(row);
      if (!id) continue;
      ids.push(id);
      bottom = Math.max(bottom, row.getBoundingClientRect().bottom - scrollerTop);
    }
    for (const row of mediaRows) {
      bottom = Math.max(bottom, row.root.getBoundingClientRect().bottom - scrollerTop);
    }
    return { ids, bottom };
  }

  // Resolves once `target` has produced no DOM mutations for `quietMs`, or
  // after `maxMs` at the latest. Fast when Drive is fast, patient when not.
  // With requireChange, the quiet window only starts after the first mutation
  // (Drive may re-render a scrolled list a little later than the scroll).
  function waitForDomQuiet(target, quietMs, maxMs, requireChange = false) {
    return new Promise(resolve => {
      let done = false;
      let quietTimer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      observer.observe(target, { childList: true, subtree: true, characterData: true });
      // No change at all within SCAN_FIRST_CHANGE_MS: the list did not need
      // re-rendering (e.g. Drive kept every loaded row in the DOM).
      quietTimer = setTimeout(finish, requireChange ? SCAN_FIRST_CHANGE_MS : quietMs);
      const maxTimer = setTimeout(finish, maxMs);
    });
  }

  function loadingIndicatorVisible(scroller) {
    const scope = scroller.parentElement || scroller;
    for (const element of scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')) {
      if (!isInsidePanel(element) && isRendered(element)) return true;
    }
    return false;
  }

  // At the bottom of the list, Drive may still be fetching its next batch.
  // Keep re-triggering its infinite-scroll listener (scroll up a little, then
  // back down) until the list grows or the patience window runs out.
  async function settleAtBottom(scroller, harvest, patienceMs) {
    const startHeight = scroller.scrollHeight;
    const startCount = scanFoundCount;
    const startedAt = performance.now();
    // Never scroll past the bottom as it was when we arrived: if a batch lands
    // mid-nudge, jumping to the *new* bottom would skip the whole new batch.
    const bottomTop = Math.max(0, startHeight - scroller.clientHeight);
    let rounds = 0;

    while (!stopDiscoveryRequested) {
      const elapsed = performance.now() - startedAt;
      const limit = loadingIndicatorVisible(scroller) ? Math.max(patienceMs, SCAN_BOTTOM_LOADING_MAX_MS) : patienceMs;
      if (elapsed >= limit) break;

      if (rounds > 0) {
        scroller.scrollTop = Math.max(0, bottomTop - Math.floor(scroller.clientHeight * 0.4));
        await sleep(90);
        if (scroller.scrollHeight > startHeight + 4) {
          scroller.scrollTop = bottomTop;
          await waitForDomQuiet(scroller, SCAN_QUIET_MS, SCAN_STEP_MAX_MS);
          harvest();
          log(`Bottom grew after ${Math.round(performance.now() - startedAt)} ms (${rounds} check(s)); unique=${scanFoundCount}.`);
          return true;
        }
      }
      scroller.scrollTop = bottomTop;
      await waitForDomQuiet(scroller, 250, 900);
      harvest();
      rounds += 1;

      if (scroller.scrollHeight > startHeight + 4 || scanFoundCount > startCount) {
        log(`Bottom grew after ${Math.round(performance.now() - startedAt)} ms (${rounds} check(s)); unique=${scanFoundCount}.`);
        return true;
      }
    }

    log(`Bottom confirmed after ${Math.round(performance.now() - startedAt)} ms (${rounds} check(s)); unique=${scanFoundCount}.`);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Folder identity and library cache
  // ---------------------------------------------------------------------------

  function currentFolderKey() {
    const folderMatch = location.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/);
    if (folderMatch) return `folder:${folderMatch[1]}`;
    const path = location.pathname.replace(/\/u\/\d+(?=\/|$)/, '');
    const query = new URL(location.href).searchParams.get('q');
    return `view:${path}${query ? `?q=${query}` : ''}`;
  }

  function currentFolderName() {
    const title = String(document.title || '').replace(/\s+[-–—]\s+Google\s.*$/i, '').trim();
    return title && !/^Google\s/i.test(title) ? title : 'This folder';
  }

  function loadLibraryCache(key) {
    const cached = readJson(localStorage, LIBRARY_KEY_PREFIX + key, null);
    if (!cached || !Array.isArray(cached.items)) return null;
    const items = cached.items
      .filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
      .map(item => ({ id: item.id, name: item.name, type: extensionOf(item.name) }));
    return items.length ? { items, name: cached.name || '', scannedAt: Number(cached.scannedAt) || 0 } : null;
  }

  function saveLibraryCache() {
    if (!libraryFolderKey || !discoveredItems.length) return;
    writeJson(localStorage, LIBRARY_KEY_PREFIX + libraryFolderKey, {
      name: libraryFolderName,
      scannedAt: libraryScannedAt,
      items: discoveredItems.map(({ id, name }) => ({ id, name }))
    });

    try {
      const entries = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith(LIBRARY_KEY_PREFIX)) continue;
        entries.push({ key, scannedAt: Number(readJson(localStorage, key, {})?.scannedAt) || 0 });
      }
      entries.sort((a, b) => b.scannedAt - a.scannedAt);
      for (const entry of entries.slice(MAX_CACHED_LIBRARIES)) localStorage.removeItem(entry.key);
    } catch {}
  }

  function adoptLibrary(items, key, name, scannedAt) {
    discoveredItems = items;
    libraryFolderKey = key;
    libraryFolderName = name;
    libraryScannedAt = scannedAt;
    failedIds.clear();
  }

  function playerHasLiveTrack() {
    return Boolean(directCurrent?.media && currentIndex >= 0 && playlist[currentIndex]);
  }

  function syncLibraryWithLocation() {
    const key = currentFolderKey();
    if (key === libraryFolderKey || discoveryRunning) {
      renderDiscoverySummary();
      return;
    }
    // While something is loaded in the player, keep its library; the user can
    // rescan to switch. Otherwise follow the folder being browsed.
    if (playerHasLiveTrack()) {
      renderDiscoverySummary();
      return;
    }
    const cached = loadLibraryCache(key);
    playlist = [];
    currentIndex = -1;
    trackSearchQuery = '';
    if (cached) {
      adoptLibrary(cached.items, key, cached.name || currentFolderName(), cached.scannedAt);
      log(`Loaded cached library for ${libraryFolderName}: ${discoveredItems.length} track(s).`);
    } else {
      adoptLibrary([], key, currentFolderName(), 0);
    }
    renderDiscoverySummary();
    renderQueue();
    updateTransportButtons();
  }

  // ---------------------------------------------------------------------------
  // Full-folder scan
  // ---------------------------------------------------------------------------

  function setStatus(text) {
    if (ui.status) {
      ui.status.textContent = text;
      ui.status.title = text;
    }
  }

  function commitLibrary(found, folderKey, folderName, detail) {
    adoptLibrary([...found.values()], folderKey, folderName, Date.now());
    saveLibraryCache();
    const mp3 = discoveredItems.filter(item => item.type === 'mp3').length;
    const webm = discoveredItems.filter(item => item.type === 'webm').length;
    setStatus(`Scan complete: ${discoveredItems.length} tracks (${mp3} MP3, ${webm} WebM).`);
    log(`Discovery completed: ${discoveredItems.length} unique item(s): ${mp3} MP3, ${webm} WebM; ${detail}.`);
    if (playlist.length) rebuildQueueAroundCurrent('rescan');
  }

  async function discoverFullFolder() {
    if (discoveryRunning) return false;

    const folderKey = currentFolderKey();
    const folderName = currentFolderName();
    const previousCount = loadLibraryCache(folderKey)?.items.length || 0;
    const scroller = findScrollContainer();

    if (!scroller) {
      const found = new Map();
      const sample = addRowsToMap(found);
      if (found.size) {
        commitLibrary(found, folderKey, folderName, `no scrolling needed, rendered=${sample.rows.length}`);
        renderDiscoverySummary();
        renderQueue();
        return true;
      }
      setStatus('No MP3/WebM files found in this view.');
      log('Discovery aborted: no scroll container or rendered media rows found.');
      return false;
    }

    discoveryRunning = true;
    stopDiscoveryRequested = false;
    scanFoundCount = 0;
    renderDiscoverySummary();
    setStatus('Scanning folder…');

    const startedAt = performance.now();
    const originalTop = scroller.scrollTop;
    const originalLeft = scroller.scrollLeft;
    const scope = collectRenderedRows(scroller).length ? scroller : document;
    const found = new Map();
    const allRowIds = new Set();
    let coveredUntil = 0;
    const harvest = () => {
      const sample = addRowsToMap(found, scope);
      const extents = itemRowExtents(scope, scroller, sample.rows);
      for (const id of extents.ids) allRowIds.add(id);
      coveredUntil = Math.max(coveredUntil, extents.bottom);
      scanFoundCount = found.size;
      renderDiscoverySummary();
      return sample;
    };

    scroller.scrollTop = 0;
    await waitForDomQuiet(scroller, 220, 1500);
    let sample = harvest();
    log(`Scan start: rendered=${sample.rows.length}, unique=${found.size}, last scan=${previousCount || 'none'}.`);

    let steps = 0;
    let stalls = 0;
    let coverageWaits = 0;
    let extendedAtCount = -1;
    let completed = false;

    while (!stopDiscoveryRequested && steps < SCAN_MAX_STEPS) {
      steps += 1;
      const before = scroller.scrollTop;
      const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

      if (range - before > 4) {
        const stepSize = Math.max(240, Math.floor(scroller.clientHeight * SCAN_STEP_RATIO));
        // Coverage guard: never scroll past the lowest row seen so far (minus
        // a small overlap). If Drive has not re-rendered yet, wait instead of
        // stepping over rows that were never in the DOM.
        let target = Math.min(range, before + stepSize);
        if (coveredUntil - 16 < target) target = Math.max(before, coveredUntil - 16);
        if (target - before < 24) {
          coverageWaits += 1;
          if (coverageWaits <= 3) {
            await waitForDomQuiet(scroller, SCAN_QUIET_MS, SCAN_STEP_MAX_MS, true);
            sample = harvest();
            continue;
          }
          log(`Step ${steps}: coverage did not advance; stepping anyway.`);
          target = Math.min(range, before + stepSize);
        }
        coverageWaits = 0;

        scroller.scrollTop = target;
        await waitForDomQuiet(scroller, SCAN_QUIET_MS, SCAN_STEP_MAX_MS, true);
        sample = harvest();
        const moved = Math.abs(scroller.scrollTop - before) >= 2;
        stalls = !moved && sample.added === 0 ? stalls + 1 : 0;
        log(`Step ${steps}: top=${Math.round(scroller.scrollTop)}/${Math.round(range)}, rendered=${sample.rows.length}, +${sample.added}, unique=${found.size}.`);
        if (stalls >= 5) {
          log('Scroller stopped moving for five steps; ending scan.');
          completed = true;
          break;
        }
        continue;
      }

      if (await settleAtBottom(scroller, harvest, SCAN_BOTTOM_PATIENCE_MS)) continue;

      // Drive appends rows in batches of 50. Ending on an exact multiple of 50
      // rows (or below the last scan's count) usually means a batch is still
      // on its way, so wait longer once before declaring the folder complete.
      const fewerThanLastScan = previousCount > found.size;
      const fullBatchBoundary = allRowIds.size >= DRIVE_BATCH_SIZE && allRowIds.size % DRIVE_BATCH_SIZE === 0;
      if (extendedAtCount !== allRowIds.size && (fewerThanLastScan || fullBatchBoundary) && !stopDiscoveryRequested) {
        extendedAtCount = allRowIds.size;
        log(fewerThanLastScan
          ? `Found ${found.size}, fewer than the ${previousCount} from the last scan; waiting longer for Drive.`
          : `List ends on exactly ${allRowIds.size} rows (a full Drive batch); waiting longer for Drive.`);
        setStatus(`Waiting for Drive to load more (${found.size} so far)…`);
        if (await settleAtBottom(scroller, harvest, SCAN_BOTTOM_EXTRA_PATIENCE_MS)) continue;
      }

      completed = true;
      break;
    }

    scroller.scrollTop = Math.min(originalTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    scroller.scrollLeft = originalLeft;

    const stopped = stopDiscoveryRequested;
    discoveryRunning = false;
    stopDiscoveryRequested = false;

    if (!stopped && found.size) {
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      commitLibrary(found, folderKey, folderName, `steps=${steps}, ${seconds}s${completed ? '' : ', step limit reached'}`);
      if (previousCount > found.size) {
        setStatus(`Scan complete: ${found.size} tracks (last scan had ${previousCount}). Rescan if files are missing.`);
      }
    } else if (stopped) {
      setStatus(`Scan stopped; kept the previous library (${discoveredItems.length} tracks).`);
      log(`Discovery stopped by user at ${found.size} temporary item(s); previous library preserved.`);
    } else {
      setStatus('No MP3/WebM files found in this folder.');
    }

    renderDiscoverySummary();
    renderQueue();
    updateTransportButtons();
    return !stopped && found.size > 0;
  }

  function stopDiscovery() {
    if (!discoveryRunning) return;
    stopDiscoveryRequested = true;
    setStatus('Stopping scan…');
    log('Stop discovery requested.');
  }

  // ---------------------------------------------------------------------------
  // Direct media playback core
  // ---------------------------------------------------------------------------

  function authuserIndex() {
    const pathMatch = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
    if (pathMatch) return pathMatch[1];
    const query = new URL(location.href).searchParams.get('authuser');
    return query && /^\d+$/.test(query) ? query : '0';
  }

  function directUrl(item) {
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(item.id)}` +
      `&export=download&confirm=t&authuser=${encodeURIComponent(authuserIndex())}`;
  }

  function createMedia(item) {
    const media = item.type === 'webm' ? document.createElement('video') : new Audio();
    media.preload = 'auto';
    media.controls = false;
    if (item.type === 'webm') {
      media.playsInline = true;
      media.style.display = 'none';
    }
    return media;
  }

  function disposeMedia(media) {
    if (!media) return;
    try {
      media.pause();
      media.removeAttribute('src');
      media.load();
      media.remove?.();
    } catch {}
  }

  function clearPrevious() {
    if (!directPrevious) return;
    disposeMedia(directPrevious.media);
    directPrevious = null;
  }

  function clearNext() {
    if (!directNext) return;
    disposeMedia(directNext.media);
    directNext = null;
  }

  function resetCachedSlot(slot, role) {
    if (!slot?.media) return null;
    try {
      slot.media.pause();
      slot.media.muted = role !== 'current';
      slot.media.currentTime = 0;
      slot.media.pause();
    } catch {}
    slot.role = role;
    slot.ready = slot.media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    return slot;
  }

  function clearCurrent() {
    if (!directCurrent) return;
    disposeMedia(directCurrent.media);
    directCurrent = null;
  }

  function clearMedia() {
    clearPrevious();
    clearCurrent();
    clearNext();
  }

  function createSlot(item, index, role) {
    const media = createMedia(item);
    const slot = { media, item: { ...item }, index, role, ready: false, failed: false };
    media.muted = role !== 'current';

    media.addEventListener('loadedmetadata', () => {
      log(`${slot.role} ${labelOf(item)} metadata: ${slot.index + 1}/${playlist.length} · ${Math.round(media.duration || 0)}s.`);
      if (slot === directCurrent) {
        syncMediaSessionMetadata(slot.item);
      }
    });
    media.addEventListener('canplay', () => {
      slot.ready = true;
      renderPlayback();
    });
    media.addEventListener('error', () => {
      slot.failed = true;
      log(`${slot.role} ${labelOf(item)} error: ${item.name}; code=${media.error?.code || 'unknown'}.`);
    });
    media.addEventListener('waiting', () => log(`${slot.role} ${labelOf(item)} waiting: ${item.name}.`));
    media.addEventListener('playing', () => {
      if (slot !== directCurrent) {
        try {
          media.muted = true;
          media.pause();
        } catch {}
        log(`Blocked unexpected playback from inactive ${slot.role} slot: ${slot.index + 1}/${playlist.length} · ${item.name}`);
        return;
      }

      media.muted = false;
      if (transitionRequestedAt) {
        log(`Audible-start latency: ${Math.round(performance.now() - transitionRequestedAt)} ms.`);
        transitionRequestedAt = 0;
      }
      autoMode = true;
      syncMediaSessionMetadata(slot.item);
      syncMediaSessionPlaybackState();
      updateTransportButtons();
      renderQueueState();
    });
    media.addEventListener('pause', () => {
      if (slot === directCurrent && !media.ended) {
        syncMediaSessionPlaybackState();
        updateTransportButtons();
        renderQueueState();
      }
    });
    media.addEventListener('ended', () => {
      // slot.index (not the creation-time index) so queue reordering by
      // Shuffle or a rescan keeps natural auto-advance working.
      if (directCurrent !== slot || currentIndex !== slot.index) return;
      log(`Natural end: ${slot.index + 1}/${playlist.length} [${labelOf(item)}].`);
      if (autoMode && !advancing) void handleEnd();
    });

    media.src = directUrl(item);
    media.load();
    return slot;
  }

  async function waitReady(slot, timeoutMs = 10000) {
    if (!slot || slot.failed) return false;
    if (slot.media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return true;
    return await new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        slot.media.removeEventListener('canplay', onCanPlay);
        slot.media.removeEventListener('error', onError);
        resolve(value);
      };
      const onCanPlay = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(slot.media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA), timeoutMs);
      slot.media.addEventListener('canplay', onCanPlay, { once: true });
      slot.media.addEventListener('error', onError, { once: true });
    });
  }

  function nextIndexForPreload() {
    if (!autoMode || !playlist.length || currentIndex < 0 || repeatMode === 'one') return -1;
    const next = currentIndex + 1;
    if (next < playlist.length) return next;
    return repeatMode === 'all' ? 0 : -1;
  }

  function prepareNext() {
    const index = nextIndexForPreload();
    if (index < 0) {
      clearNext();
      renderPlayback();
      return;
    }
    const item = playlist[index];
    if (directNext && directNext.index === index && directNext.item.id === item.id && !directNext.failed) return;
    clearNext();
    directNext = createSlot(item, index, 'next');
    log(`Preloading ${index + 1}/${playlist.length} [${labelOf(item)}]: ${item.name}`);
  }

  async function playIndex(index, reason = 'manual') {
    if (advancing || !playlist[index]) return false;
    advancing = true;
    const target = playlist[index];
    const oldCurrent = directCurrent;
    const oldIndex = oldCurrent?.index ?? -1;
    let slot;
    let promoted = false;
    let promotedFrom = '';
    renderQueueState(index);

    try {
      if (directPrevious && directPrevious.index === index && directPrevious.item.id === target.id && !directPrevious.failed) {
        slot = directPrevious;
        directPrevious = null;
        resetCachedSlot(slot, 'current');
        promoted = true;
        promotedFrom = 'previous cache';
        log(`Promoting cached previous ${index + 1}/${playlist.length}.`);
      } else if (directNext && directNext.index === index && directNext.item.id === target.id && !directNext.failed) {
        slot = directNext;
        directNext = null;
        slot.role = 'current';
        try {
          slot.media.pause();
          slot.media.muted = false;
        } catch {}
        promoted = true;
        promotedFrom = 'preload';
        log(`Promoting preloaded ${index + 1}/${playlist.length}.`);
      } else {
        slot = createSlot(target, index, 'current');
        log(`Created current media ${index + 1}/${playlist.length} [${labelOf(target)}].`);
      }

      directCurrent = slot;
      let ready = await waitReady(slot, promoted ? 6000 : 10000);

      if ((!ready || slot.failed) && promoted) {
        log(`Promoted ${promotedFrom || 'cached'} slot unavailable for ${index + 1}/${playlist.length}; retrying with fresh media.`);
        if (directCurrent === slot) directCurrent = null;
        disposeMedia(slot.media);

        slot = createSlot(target, index, 'current');
        promoted = false;
        promotedFrom = 'fresh retry';
        directCurrent = slot;
        ready = await waitReady(slot, 10000);
      }

      if (!ready || slot.failed) {
        const oldStillPlayable = Boolean(oldCurrent?.media && !oldCurrent.media.ended);
        if (directCurrent === slot) directCurrent = oldStillPlayable ? oldCurrent : null;
        disposeMedia(slot.media);
        transitionRequestedAt = 0;
        failedIds.add(target.id);

        if (!oldStillPlayable) {
          autoMode = false;
          clearNext();
          clearMediaSession();
        }

        setStatus(`Could not load: ${target.name}`);
        log(`Load failed after recovery attempt for ${index + 1}/${playlist.length}: ${target.name}`);
        renderPlayback();
        renderQueue();
        renderDiscoverySummary();
        updateTransportButtons();
        return false;
      }

      if (promotedFrom === 'fresh retry') {
        log(`Fresh retry ready for ${index + 1}/${playlist.length}: ${target.name}`);
      }

      if (oldCurrent && oldCurrent !== slot) {
        try {
          oldCurrent.media.muted = true;
          oldCurrent.media.pause();
        } catch {}
      }
      try { slot.media.muted = false; } catch {}
      setupMediaSession();
      syncMediaSessionMetadata(target);
      transitionRequestedAt = performance.now();
      autoMode = true;
      await slot.media.play();
      failedIds.delete(target.id);

      if (oldCurrent && oldCurrent !== slot) {
        const movedForwardOne =
          oldIndex === index - 1 ||
          (repeatMode === 'all' && index === 0 && oldIndex === playlist.length - 1);
        const movedBackwardOne =
          oldIndex === index + 1 ||
          (repeatMode === 'all' && index === playlist.length - 1 && oldIndex === 0);

        if (movedForwardOne) {
          clearPrevious();
          directPrevious = resetCachedSlot(oldCurrent, 'previous');
          log(`Cached previous ${oldIndex + 1}/${playlist.length} for instant back navigation.`);
        } else if (movedBackwardOne) {
          clearNext();
          directNext = resetCachedSlot(oldCurrent, 'next');
          log(`Reused former current ${oldIndex + 1}/${playlist.length} as next cache.`);
        } else {
          disposeMedia(oldCurrent.media);
          clearPrevious();
        }
      }

      currentIndex = index;
      syncMediaSessionMetadata(target);
      syncMediaSessionPlaybackState();
      const sourceNote = promotedFrom ? ` · ${promotedFrom}` : '';
      setStatus(`Playing ${index + 1}/${playlist.length}${sourceNote}`);
      log(`Playing ${index + 1}/${playlist.length} via direct media (${reason})${promotedFrom ? ` from ${promotedFrom}` : ''}.`);
      prepareNext();
      if (directPrevious?.media) {
        try {
          directPrevious.media.muted = true;
          directPrevious.media.pause();
        } catch {}
      }
      if (directNext?.media) {
        try {
          directNext.media.muted = true;
          directNext.media.pause();
        } catch {}
      }
      renderPlayback();
      renderQueue();
      renderDiscoverySummary();
      updateTransportButtons();
      return true;
    } catch (error) {
      transitionRequestedAt = 0;
      if (slot && directCurrent === slot) directCurrent = oldCurrent;
      if (slot) disposeMedia(slot.media);
      if (!oldCurrent) autoMode = false;
      setStatus(`Playback failed: ${error?.name || 'Error'}`);
      log(`play() failed for ${target.name}: ${error?.name || 'Error'}.`);
      updateTransportButtons();
      renderQueueState();
      return false;
    } finally {
      advancing = false;
    }
  }

  function shuffleCopy(items) {
    const copy = items.map(item => ({ ...item }));
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function buildPlaylist() {
    return shuffleMode ? shuffleCopy(discoveredItems) : discoveredItems.map(item => ({ ...item }));
  }

  // Re-order the live queue while keeping the current track playing:
  // used when Shuffle is toggled mid-playback and after a rescan.
  function rebuildQueueAroundCurrent(reason) {
    if (advancing) {
      setTimeout(() => rebuildQueueAroundCurrent(reason), 200);
      return;
    }
    if (!playerHasLiveTrack()) {
      if (!directCurrent) {
        playlist = [];
        currentIndex = -1;
      }
      renderQueue();
      updateTransportButtons();
      return;
    }

    const current = playlist[currentIndex];
    let next;
    if (shuffleMode) {
      next = [{ ...current }, ...shuffleCopy(discoveredItems.filter(item => item.id !== current.id))];
    } else {
      next = discoveredItems.map(item => ({ ...item }));
      if (!next.some(item => item.id === current.id)) next.unshift({ ...current });
    }

    playlist = next;
    currentIndex = playlist.findIndex(item => item.id === current.id);
    directCurrent.index = currentIndex;
    clearPrevious();
    clearNext();
    prepareNext();
    log(`Queue rebuilt around current track (${reason}): ${currentIndex + 1}/${playlist.length}, ${shuffleMode ? 'SHUFFLE' : 'ORDERED'}.`);
    renderQueue();
    renderPlayback();
    updateTransportButtons();
  }

  async function startQueue() {
    if (discoveryRunning) return;
    if (!discoveredItems.length) {
      const ok = await discoverFullFolder();
      if (!ok) return;
    }
    clearMedia();
    playlist = buildPlaylist();
    currentIndex = -1;
    autoMode = true;
    renderDiscoverySummary();
    log(`Queue built: ${playlist.length} track(s), mode=${shuffleMode ? 'SHUFFLE' : 'ORDERED'}, repeat=${repeatMode.toUpperCase()}.`);
    renderQueue();
    await playIndex(0, 'start');
  }

  async function previousNow() {
    if (!playlist.length || currentIndex < 0) {
      setStatus('Start playback first.');
      return;
    }
    // Familiar player behaviour: a few seconds in, Previous restarts the track.
    const media = directCurrent?.media;
    if (media && !media.ended && media.currentTime > 3) {
      media.currentTime = 0;
      log(`Previous restarted track ${currentIndex + 1}/${playlist.length}.`);
      renderPlayback();
      return;
    }
    autoMode = true;
    let previous = currentIndex - 1;
    if (previous < 0) {
      if (repeatMode === 'all') previous = playlist.length - 1;
      else {
        if (media) media.currentTime = 0;
        updateTransportButtons();
        return;
      }
    }
    await playIndex(previous, 'Previous');
  }

  async function nextNow() {
    if (!playlist.length || currentIndex < 0) {
      setStatus('Start playback first.');
      return;
    }
    autoMode = true;
    let next = currentIndex + 1;
    if (next >= playlist.length) {
      if (repeatMode === 'all') next = 0;
      else {
        setStatus('End of queue.');
        updateTransportButtons();
        return;
      }
    }
    await playIndex(next, 'Next');
  }

  async function playSelectedTrack(itemId) {
    if (discoveryRunning || advancing) return;

    const discoveredIndex = discoveredItems.findIndex(item => item.id === itemId);
    if (discoveredIndex < 0) {
      setStatus('Selected track is no longer available in the scanned folder.');
      return;
    }

    let targetIndex = playlist.findIndex(item => item.id === itemId);

    if (targetIndex < 0) {
      if (shuffleMode) {
        const selected = { ...discoveredItems[discoveredIndex] };
        const remaining = shuffleCopy(discoveredItems.filter(item => item.id !== itemId));
        playlist = [selected, ...remaining];
        targetIndex = 0;
        log(`Queue built from selected track: ${playlist.length} track(s), mode=SHUFFLE.`);
      } else {
        playlist = discoveredItems.map(item => ({ ...item }));
        targetIndex = discoveredIndex;
        log(`Queue built from selected track: ${playlist.length} track(s), mode=ORDERED, start=${targetIndex + 1}.`);
      }
    }

    autoMode = true;
    renderDiscoverySummary();
    renderQueue();
    await playIndex(targetIndex, 'track selection');
  }

  async function togglePause() {
    const media = directCurrent?.media;
    const item = playlist[currentIndex];
    if (!media || !item || media.ended) {
      setStatus('Nothing is currently available to pause or resume.');
      updateTransportButtons();
      return;
    }

    if (!media.paused) {
      transitionRequestedAt = 0;
      media.pause();
      autoMode = false;
      setStatus(`Paused ${currentIndex + 1}/${playlist.length}`);
      log(`Paused track ${currentIndex + 1}/${playlist.length}.`);
      updateTransportButtons();
      renderPlayback();
      renderQueueState();
      return;
    }

    try {
      autoMode = true;
      await media.play();
      setStatus(`Playing ${currentIndex + 1}/${playlist.length}`);
      log(`Resumed track ${currentIndex + 1}/${playlist.length}.`);
      prepareNext();
    } catch (error) {
      autoMode = false;
      setStatus(`Resume failed: ${error?.name || 'Error'}`);
      log(`Resume failed for ${item.name}: ${error?.name || 'Error'}.`);
    }
    updateTransportButtons();
    renderPlayback();
    renderQueueState();
  }

  // One button for everything: start the queue (scanning first if needed),
  // pause, or resume.
  function togglePlay() {
    const media = directCurrent?.media;
    if (media && currentIndex >= 0 && playlist[currentIndex] && !media.ended) return void togglePause();
    return void startQueue();
  }

  async function repeatCurrent() {
    const media = directCurrent?.media;
    if (!media) return false;
    try {
      media.currentTime = 0;
      transitionRequestedAt = performance.now();
      await media.play();
      log(`Repeat ONE restarted track ${currentIndex + 1}/${playlist.length}.`);
      return true;
    } catch {
      return false;
    }
  }

  async function handleEnd() {
    if (!autoMode || advancing || currentIndex < 0) return;
    if (repeatMode === 'one') {
      await repeatCurrent();
      return;
    }

    let next = currentIndex;
    for (let attempt = 0; attempt <= MAX_AUTO_SKIPS; attempt += 1) {
      next += 1;
      if (next >= playlist.length) {
        if (repeatMode === 'all') next = 0;
        else {
          autoMode = false;
          clearNext();
          clearMediaSession();
          setStatus(`Queue finished (${playlist.length} tracks).`);
          renderPlayback();
          renderDiscoverySummary();
          updateTransportButtons();
          renderQueueState();
          return;
        }
      }
      if (next === currentIndex) return;
      autoMode = true;
      if (await playIndex(next, attempt ? 'auto-skip after failure' : 'natural next')) return;
      log(`Skipping unavailable track ${next + 1}/${playlist.length}.`);
    }
  }

  function stopPlayback() {
    autoMode = false;
    transitionRequestedAt = 0;
    clearMedia();
    clearMediaSession();
    setStatus('Playback stopped.');
    renderPlayback();
    renderDiscoverySummary();
    updateTransportButtons();
    renderQueueState();
  }

  function seekLast5s() {
    const media = directCurrent?.media;
    if (!media || !Number.isFinite(media.duration) || media.duration <= 6) {
      setStatus('Current media duration is not ready.');
      return;
    }
    media.currentTime = media.duration - 5;
    log(`Seeked current track to last ~5 seconds (${media.currentTime.toFixed(1)}/${media.duration.toFixed(1)}).`);
  }

  function savePrefs() {
    writeJson(localStorage, PREFS_KEY, { shuffle: shuffleMode, repeat: repeatMode });
  }

  function toggleShuffle() {
    shuffleMode = !shuffleMode;
    savePrefs();
    updateButtons();
    if (playlist.length) rebuildQueueAroundCurrent(shuffleMode ? 'shuffle on' : 'shuffle off');
    setStatus(`Shuffle ${shuffleMode ? 'on' : 'off'}.`);
  }

  function toggleRepeat() {
    repeatMode = REPEAT_MODES[(REPEAT_MODES.indexOf(repeatMode) + 1) % REPEAT_MODES.length];
    savePrefs();
    updateButtons();
    prepareNext();
    setStatus({ off: 'Repeat off.', all: 'Repeat all.', one: 'Repeat one.' }[repeatMode]);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const ICONS = {
    play: 'M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z',
    pause: 'M7 5h3.2v14H7zM13.8 5H17v14h-3.2z',
    previous: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    shuffle: 'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    minimize: 'M6 11h12v2H6z',
    expand: 'M4 14h2v4h4v2H4v-6zm0-4V4h6v2H6v4H4zm16 4v6h-6v-2h4v-4h2zM14 4h6v6h-2V6h-4V4z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    note: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
    locate: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z'
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(name, size = 20) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function setIcon(button, name, size) {
    const old = button.querySelector('svg');
    const next = icon(name, size || Number(old?.getAttribute('width')) || 20);
    if (old) old.replaceWith(next);
    else button.prepend(next);
  }

  // Small DOM builder (no innerHTML: Drive enforces Trusted Types).
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  function iconButton(name, label, handler, className = 'gdfp-icon-btn', size = 20) {
    return h('button', { type: 'button', class: className, title: label, 'aria-label': label, onclick: handler }, icon(name, size));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
  }

  function formatAgo(timestamp) {
    if (!timestamp) return '';
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
  }

  const CSS = `
#${PANEL_ID} {
  --gdfp-surface: #ffffff;
  --gdfp-surface-2: #f0f4f9;
  --gdfp-surface-3: #e3e9f2;
  --gdfp-text: #1f1f1f;
  --gdfp-muted: #5f6368;
  --gdfp-accent: #0b57d0;
  --gdfp-on-accent: #ffffff;
  --gdfp-accent-soft: #d3e3fd;
  --gdfp-border: rgba(0, 0, 0, .08);
  --gdfp-hover: rgba(0, 0, 0, .05);
  --gdfp-danger: #b3261e;
  --gdfp-shadow: 0 1px 3px rgba(0,0,0,.12), 0 12px 32px rgba(0,0,0,.16);
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  width: 360px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--gdfp-surface); color: var(--gdfp-text);
  border: 1px solid var(--gdfp-border); border-radius: 20px; box-shadow: var(--gdfp-shadow);
  font: 13px/1.4 "Google Sans Text", "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal;
}
@media (prefers-color-scheme: dark) {
  #${PANEL_ID}:not([data-theme="light"]) {
    --gdfp-surface: #1e1f22;
    --gdfp-surface-2: #2a2b2f;
    --gdfp-surface-3: #36373c;
    --gdfp-text: #e8eaed;
    --gdfp-muted: #9aa0a6;
    --gdfp-accent: #a8c7fa;
    --gdfp-on-accent: #062e6f;
    --gdfp-accent-soft: rgba(168, 199, 250, .16);
    --gdfp-border: rgba(255, 255, 255, .08);
    --gdfp-hover: rgba(255, 255, 255, .06);
    --gdfp-danger: #f2b8b5;
    --gdfp-shadow: 0 1px 3px rgba(0,0,0,.4), 0 12px 32px rgba(0,0,0,.45);
  }
}
#${PANEL_ID}[data-theme="dark"] {
    --gdfp-surface: #1e1f22;
    --gdfp-surface-2: #2a2b2f;
    --gdfp-surface-3: #36373c;
    --gdfp-text: #e8eaed;
    --gdfp-muted: #9aa0a6;
    --gdfp-accent: #a8c7fa;
    --gdfp-on-accent: #062e6f;
    --gdfp-accent-soft: rgba(168, 199, 250, .16);
    --gdfp-border: rgba(255, 255, 255, .08);
    --gdfp-hover: rgba(255, 255, 255, .06);
    --gdfp-danger: #f2b8b5;
    --gdfp-shadow: 0 1px 3px rgba(0,0,0,.4), 0 12px 32px rgba(0,0,0,.45);
}
#${PANEL_ID}, #${PANEL_ID} * { box-sizing: border-box; }
:where(#${PANEL_ID}) button {
  appearance: none; -webkit-appearance: none; margin: 0; padding: 0; border: 0; background: none;
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
}
:where(#${PANEL_ID}) button:disabled { cursor: default; opacity: .38; }
#${PANEL_ID} button:focus-visible, #${PANEL_ID} [tabindex]:focus-visible, #${PANEL_ID} input:focus-visible {
  outline: 2px solid var(--gdfp-accent); outline-offset: 2px;
}
#${PANEL_ID} svg { display: block; flex: none; }
#${PANEL_ID} [hidden] { display: none !important; }

.gdfp-header { display: flex; align-items: center; gap: 8px; padding: 10px 10px 4px 16px; cursor: grab; user-select: none; touch-action: none; }
.gdfp-header.is-dragging { cursor: grabbing; }
.gdfp-brand { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; color: var(--gdfp-muted); font-size: 12px; font-weight: 500; }
.gdfp-brand svg { color: var(--gdfp-accent); }
.gdfp-icon-btn { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: var(--gdfp-muted); transition: background-color .15s, color .15s; }
.gdfp-icon-btn:hover:not(:disabled) { background: var(--gdfp-hover); color: var(--gdfp-text); }

.gdfp-now { display: flex; gap: 12px; align-items: center; padding: 6px 16px 0; }
.gdfp-art { width: 52px; height: 52px; border-radius: 12px; flex: none; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--gdfp-accent-soft), var(--gdfp-surface-3)); color: var(--gdfp-accent); }
.gdfp-now-text { min-width: 0; flex: 1; }
.gdfp-title { font-size: 15px; font-weight: 500; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.gdfp-sub { margin-top: 2px; font-size: 12px; color: var(--gdfp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.gdfp-seek { padding: 10px 16px 0; }
.gdfp-range { --pct: 0%; width: 100%; height: 16px; margin: 0; background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none; display: block; }
.gdfp-range:disabled { cursor: default; }
.gdfp-range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--gdfp-accent) var(--pct), var(--gdfp-surface-3) var(--pct)); }
.gdfp-range::-moz-range-track { height: 4px; border-radius: 2px; background: var(--gdfp-surface-3); }
.gdfp-range::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--gdfp-accent); }
.gdfp-range::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: var(--gdfp-accent); border: 0; transform: scale(0); transition: transform .12s; }
.gdfp-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--gdfp-accent); border: 0; transform: scale(0); transition: transform .12s; }
.gdfp-seek:hover .gdfp-range:not(:disabled)::-webkit-slider-thumb, .gdfp-range:active::-webkit-slider-thumb { transform: scale(1); }
.gdfp-seek:hover .gdfp-range:not(:disabled)::-moz-range-thumb, .gdfp-range:active::-moz-range-thumb { transform: scale(1); }
.gdfp-times { display: flex; justify-content: space-between; font-size: 11px; color: var(--gdfp-muted); font-variant-numeric: tabular-nums; margin-top: 1px; }

.gdfp-transport { display: flex; align-items: center; justify-content: space-between; padding: 4px 28px 10px; }
.gdfp-transport .gdfp-icon-btn { width: 40px; height: 40px; color: var(--gdfp-text); }
.gdfp-toggle { position: relative; }
.gdfp-toggle.is-on { color: var(--gdfp-accent) !important; background: var(--gdfp-accent-soft); }
.gdfp-toggle.is-on:hover { background: var(--gdfp-accent-soft) !important; }
.gdfp-play { width: 56px; height: 56px; border-radius: 18px; display: inline-flex; align-items: center; justify-content: center; background: var(--gdfp-accent); color: var(--gdfp-on-accent); transition: border-radius .2s, transform .1s, filter .15s; }
.gdfp-play:hover:not(:disabled) { filter: brightness(1.08); }
.gdfp-play:active:not(:disabled) { transform: scale(.96); }
.gdfp-play.is-playing { border-radius: 50%; }

.gdfp-library { margin: 0 8px 8px; padding: 10px 8px 8px; border-radius: 16px; background: var(--gdfp-surface-2); display: flex; flex-direction: column; min-height: 0; flex: 1; }
.gdfp-lib-head { display: flex; align-items: center; gap: 8px; padding: 0 4px 0 8px; }
.gdfp-lib-info { flex: 1; min-width: 0; }
.gdfp-lib-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gdfp-lib-meta { font-size: 12px; color: var(--gdfp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gdfp-chip { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px 0 10px; border-radius: 16px; font-size: 13px; font-weight: 500; color: var(--gdfp-accent); border: 1px solid var(--gdfp-border); background: var(--gdfp-surface); flex: none; transition: background-color .15s; }
.gdfp-chip:hover:not(:disabled) { background: var(--gdfp-accent-soft); }
.gdfp-chip.is-primary { background: var(--gdfp-accent); color: var(--gdfp-on-accent); border-color: transparent; }
.gdfp-chip.is-primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--gdfp-accent); }
.gdfp-chip.is-stop { color: var(--gdfp-danger); }
.gdfp-scanbar { height: 3px; margin: 8px 8px 0; border-radius: 2px; overflow: hidden; background: var(--gdfp-surface-3); position: relative; }
.gdfp-scanbar::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 35%; border-radius: 2px; background: var(--gdfp-accent); animation: gdfp-indeterminate 1.1s ease-in-out infinite; }
@keyframes gdfp-indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(290%); } }

.gdfp-search { display: flex; align-items: center; gap: 4px; margin: 8px 0 4px; }
.gdfp-search-box { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 4px 0 12px; border-radius: 18px; background: var(--gdfp-surface); color: var(--gdfp-muted); border: 1px solid transparent; }
.gdfp-search-box:focus-within { border-color: var(--gdfp-accent); }
.gdfp-search-box input { flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0; border: 0; outline: none; background: transparent; color: var(--gdfp-text); font: inherit; box-shadow: none; }
.gdfp-search-box input::placeholder { color: var(--gdfp-muted); }
.gdfp-search-box input::-webkit-search-cancel-button { -webkit-appearance: none; }
.gdfp-search-box .gdfp-icon-btn { width: 28px; height: 28px; }

.gdfp-list { overflow-y: auto; overflow-x: hidden; min-height: 0; max-height: 260px; flex: 1; scrollbar-width: thin; margin: 0 -2px; padding: 0 2px; }
.gdfp-row { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 6px 0 8px; border-radius: 10px; cursor: default; }
.gdfp-row:hover { background: var(--gdfp-hover); }
.gdfp-row.is-current { background: var(--gdfp-accent-soft); color: var(--gdfp-accent); }
.gdfp-row.is-failed .gdfp-row-name { text-decoration: line-through; opacity: .55; }
.gdfp-row-idx { width: 26px; flex: none; text-align: right; font-size: 12px; color: var(--gdfp-muted); font-variant-numeric: tabular-nums; display: flex; justify-content: flex-end; }
.gdfp-row.is-current .gdfp-row-idx { color: var(--gdfp-accent); }
.gdfp-row-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gdfp-row.is-current .gdfp-row-name { font-weight: 500; }
.gdfp-badge { flex: none; font-size: 10px; font-weight: 600; letter-spacing: .04em; padding: 2px 6px; border-radius: 6px; background: var(--gdfp-surface-3); color: var(--gdfp-muted); }
.gdfp-row-play { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; opacity: 0; color: var(--gdfp-text); flex: none; }
.gdfp-row:hover .gdfp-row-play, .gdfp-row:focus-within .gdfp-row-play { opacity: 1; }
.gdfp-row-play:hover { background: var(--gdfp-hover); }
.gdfp-empty { padding: 18px 8px; text-align: center; color: var(--gdfp-muted); font-size: 12px; }

.gdfp-eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.gdfp-eq i { width: 3px; border-radius: 1px; background: currentColor; animation: gdfp-eq .9s ease-in-out infinite; }
.gdfp-eq i:nth-child(1) { height: 60%; }
.gdfp-eq i:nth-child(2) { height: 100%; animation-delay: -.3s; }
.gdfp-eq i:nth-child(3) { height: 40%; animation-delay: -.6s; }
.gdfp-eq.is-paused i { animation-play-state: paused; }
@keyframes gdfp-eq { 0%, 100% { transform: scaleY(.35); } 50% { transform: scaleY(1); } }
.gdfp-eq i { transform-origin: bottom; }

.gdfp-footer { padding: 0 16px 10px; }
.gdfp-status { font-size: 11px; color: var(--gdfp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gdfp-diag { margin-top: 4px; font-size: 11px; color: var(--gdfp-muted); }
.gdfp-diag summary { cursor: pointer; user-select: none; width: max-content; }
.gdfp-diag-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.gdfp-diag-actions button { padding: 5px 10px; border-radius: 8px; background: var(--gdfp-surface-2); color: var(--gdfp-text); font-size: 11px; }
.gdfp-diag-actions button:hover { background: var(--gdfp-surface-3); }
.gdfp-log { margin: 0; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 8px; border-radius: 8px; background: var(--gdfp-surface-2); color: var(--gdfp-text); }

.gdfp-mini { display: none; align-items: center; gap: 2px; padding: 6px 6px 6px 8px; cursor: grab; user-select: none; touch-action: none; }
.gdfp-mini .gdfp-art { width: 36px; height: 36px; border-radius: 10px; margin-right: 6px; }
.gdfp-mini-text { flex: 1; min-width: 0; margin-right: 2px; }
.gdfp-mini-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gdfp-mini-progress { height: 2px; margin-top: 5px; border-radius: 1px; background: var(--gdfp-surface-3); overflow: hidden; }
.gdfp-mini-progress span { display: block; height: 100%; width: 0; background: var(--gdfp-accent); }
.gdfp-mini .gdfp-play { width: 36px; height: 36px; border-radius: 12px; }
.gdfp-mini .gdfp-play.is-playing { border-radius: 50%; }
#${PANEL_ID}.is-min { width: 320px; border-radius: 16px; }
#${PANEL_ID}.is-min .gdfp-full { display: none; }
#${PANEL_ID}.is-min .gdfp-mini { display: flex; }
.gdfp-full { display: flex; flex-direction: column; min-height: 0; }
`;

  function injectStyles() {
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        return;
      }
    } catch {}
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // Match Drive's own light/dark theme (which can differ from the OS theme).
  // Falls back to prefers-color-scheme when the page colour is unreadable.
  function syncTheme() {
    if (!ui.panel) return;
    let theme = '';
    for (const element of [document.body, document.documentElement]) {
      const match = getComputedStyle(element).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (!match || (match[4] !== undefined && Number(match[4]) < 0.5)) continue;
      const [r, g, b] = match.slice(1, 4).map(Number);
      theme = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? 'dark' : 'light';
      break;
    }
    if (theme) ui.panel.dataset.theme = theme;
    else delete ui.panel.dataset.theme;
  }

  function setTransportButtonState(node, enabled) {
    if (node) node.disabled = !enabled;
  }

  function updateTransportButtons() {
    if (!ui.panel) return;
    const media = directCurrent?.media;
    const hasCurrent = Boolean(media && currentIndex >= 0 && playlist[currentIndex] && !media.ended);
    const playing = hasCurrent && !media.paused;
    const hasQueuePosition = playlist.length > 0 && currentIndex >= 0;
    const canPrevious = hasQueuePosition && hasCurrent;
    const canNext = hasQueuePosition && (currentIndex < playlist.length - 1 || repeatMode === 'all');
    const canPlay = !discoveryRunning || hasCurrent;

    for (const node of ui.previousButtons) setTransportButtonState(node, canPrevious);
    for (const node of ui.nextButtons) setTransportButtonState(node, canNext);
    for (const node of ui.playButtons) {
      setTransportButtonState(node, canPlay);
      const wanted = playing ? 'pause' : 'play';
      if (node.dataset.icon !== wanted) {
        node.dataset.icon = wanted;
        setIcon(node, wanted);
      }
      node.classList.toggle('is-playing', playing);
      const label = playing ? 'Pause' : hasCurrent ? 'Resume' : discoveredItems.length ? 'Play folder' : 'Scan folder and play';
      node.title = label;
      node.setAttribute('aria-label', label);
    }
  }

  function updateButtons() {
    if (!ui.panel) return;
    ui.shuffle.classList.toggle('is-on', shuffleMode);
    ui.shuffle.setAttribute('aria-pressed', String(shuffleMode));
    ui.shuffle.title = shuffleMode ? 'Shuffle: on' : 'Shuffle: off';
    ui.shuffle.setAttribute('aria-label', ui.shuffle.title);

    ui.repeat.classList.toggle('is-on', repeatMode !== 'off');
    ui.repeat.setAttribute('aria-pressed', String(repeatMode !== 'off'));
    setIcon(ui.repeat, repeatMode === 'one' ? 'repeatOne' : 'repeat');
    ui.repeat.title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[repeatMode];
    ui.repeat.setAttribute('aria-label', ui.repeat.title);
    updateTransportButtons();
  }

  function renderDiscoverySummary() {
    if (!ui.panel) return;
    const browsingOtherFolder = libraryFolderKey && libraryFolderKey !== currentFolderKey();

    ui.libName.textContent = discoveredItems.length || discoveryRunning
      ? (discoveryRunning ? currentFolderName() : libraryFolderName || 'This folder')
      : currentFolderName();

    let meta;
    if (discoveryRunning) {
      meta = `Scanning… ${scanFoundCount} found`;
    } else if (discoveredItems.length) {
      const webm = discoveredItems.filter(item => item.type === 'webm').length;
      const parts = [`${discoveredItems.length} tracks`];
      if (webm) parts.push(`${webm} WebM`);
      if (libraryScannedAt) parts.push(`scanned ${formatAgo(libraryScannedAt)}`);
      if (browsingOtherFolder) parts.push('not the open folder');
      meta = parts.join(' · ');
    } else {
      meta = 'Not scanned yet';
    }
    ui.libMeta.textContent = meta;
    ui.libMeta.title = meta;

    const scanLabel = discoveryRunning ? 'Stop' : !discoveredItems.length ? 'Scan' : browsingOtherFolder ? 'Scan this' : 'Rescan';
    if (ui.scanLabel.textContent !== scanLabel) ui.scanLabel.textContent = scanLabel;
    const wantedIcon = discoveryRunning ? 'close' : 'refresh';
    if (ui.scan.dataset.icon !== wantedIcon) {
      ui.scan.dataset.icon = wantedIcon;
      setIcon(ui.scan, wantedIcon, 18);
    }
    ui.scan.classList.toggle('is-stop', discoveryRunning);
    ui.scan.classList.toggle('is-primary', !discoveryRunning && (!discoveredItems.length || browsingOtherFolder));
    ui.scan.title = discoveryRunning ? 'Stop scanning' : 'Scan the open Drive folder for MP3/WebM files';
    ui.scanBar.hidden = !discoveryRunning;
    updateTransportButtons();
  }

  function renderPlayback() {
    if (!ui.panel) return;
    updateTransportButtons();

    const item = directCurrent && currentIndex >= 0 ? playlist[currentIndex] : null;
    const media = item ? directCurrent.media : null;
    const title = item ? mediaTitleOf(item) : discoveredItems.length ? 'Ready to play' : 'Nothing playing';
    if (ui.title.textContent !== title) {
      ui.title.textContent = title;
      ui.title.title = item ? item.name : '';
      ui.miniTitle.textContent = title;
    }

    let sub;
    if (item) {
      sub = `${currentIndex + 1} of ${playlist.length}`;
      if (item.type === 'webm') sub += ' · WebM';
      if (libraryFolderName) sub += ` · ${libraryFolderName}`;
    } else if (discoveredItems.length) {
      sub = `${discoveredItems.length} tracks in ${libraryFolderName || 'this folder'}`;
    } else {
      sub = 'Open a Drive folder with MP3/WebM files';
    }
    if (ui.sub.textContent !== sub) ui.sub.textContent = sub;

    const duration = media && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    const position = media ? media.currentTime : 0;
    ui.seek.disabled = !duration;
    if (!seekDragging) {
      const pct = duration ? Math.max(0, Math.min(1, position / duration)) : 0;
      ui.seek.value = String(Math.round(pct * 1000));
      ui.seek.style.setProperty('--pct', `${pct * 100}%`);
      ui.elapsed.textContent = formatTime(position);
      ui.miniBar.style.width = `${pct * 100}%`;
    }
    ui.duration.textContent = duration ? formatTime(duration) : '0:00';
  }

  function equalizer(paused) {
    return h('span', { class: `gdfp-eq${paused ? ' is-paused' : ''}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  }

  function normalizeTrackSearch(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLocaleLowerCase()
      .trim();
  }

  // Cheap refresh of the "current" highlight without rebuilding the list.
  function renderQueueState(pendingIndex = -1) {
    if (!ui.list) return;
    const media = directCurrent?.media;
    const paused = !media || media.paused || media.ended;
    for (const row of ui.list.children) {
      if (!row.dataset.index) continue;
      const index = Number(row.dataset.index);
      const isCurrent = playlist.length > 0 && Boolean(directCurrent) && index === currentIndex;
      row.classList.toggle('is-current', isCurrent);
      const idx = row.firstChild;
      const hasEq = Boolean(idx.querySelector('.gdfp-eq'));
      if (isCurrent && !hasEq) idx.replaceChildren(equalizer(paused));
      else if (!isCurrent && hasEq) idx.replaceChildren(String(index + 1));
      if (isCurrent) idx.firstChild.classList.toggle('is-paused', paused);
      row.style.opacity = pendingIndex >= 0 && index === pendingIndex ? '.6' : '';
    }
  }

  function scrollCurrentIntoView(force = false) {
    const row = ui.list?.querySelector('.gdfp-row.is-current');
    if (!row) return;
    const listRect = ui.list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (force || rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
      ui.list.scrollTop += rowRect.top - listRect.top - (listRect.height - rowRect.height) / 2;
    }
  }

  function renderQueue() {
    if (!ui.list) return;
    const items = playlist.length ? playlist : discoveredItems;
    const previousScrollTop = ui.list.scrollTop;
    ui.searchWrap.hidden = !items.length;

    const query = normalizeTrackSearch(trackSearchQuery);
    const filtered = items
      .map((item, index) => ({ item, index }))
      .filter(entry => !query || normalizeTrackSearch(entry.item.name).includes(query));

    ui.clearSearch.hidden = !trackSearchQuery;
    ui.list.replaceChildren();

    if (!items.length) {
      ui.list.append(h('div', { class: 'gdfp-empty' },
        discoveryRunning ? 'Scanning the folder…' : 'Press Scan (or Play) to find the MP3/WebM files in this folder.'));
      return;
    }
    if (!filtered.length) {
      ui.list.append(h('div', { class: 'gdfp-empty' }, 'No matching tracks.'));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const { item, index } of filtered) {
      const play = () => void playSelectedTrack(item.id);
      const row = h('div', {
        class: `gdfp-row${failedIds.has(item.id) ? ' is-failed' : ''}`,
        tabindex: '0',
        role: 'button',
        title: `${item.name}\nDouble-click to play`,
        'data-index': String(index),
        ondblclick: event => { event.preventDefault(); play(); },
        onkeydown: event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          play();
        }
      },
      h('span', { class: 'gdfp-row-idx' }, String(index + 1)),
      h('span', { class: 'gdfp-row-name' }, mediaTitleOf(item)),
      item.type === 'webm' ? h('span', { class: 'gdfp-badge' }, 'WEBM') : null,
      h('button', {
        type: 'button', class: 'gdfp-row-play', title: 'Play', 'aria-label': `Play ${mediaTitleOf(item)}`, tabindex: '-1',
        onclick: event => { event.stopPropagation(); play(); }
      }, icon('play', 16)));
      fragment.appendChild(row);
    }
    ui.list.appendChild(fragment);
    renderQueueState();
    ui.list.scrollTop = previousScrollTop;
    requestAnimationFrame(() => scrollCurrentIntoView());
  }

  function clampPanelPosition(panel, left, top) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, left)),
      top: Math.min(maxTop, Math.max(margin, top))
    };
  }

  function placePanel(panel, left, top) {
    const position = clampPanelPosition(panel, left, top);
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.dataset.gdfpDragged = 'true';
    return position;
  }

  function enablePanelDragging(panel, handle) {
    let dragging = false;
    let pointerId = null;
    let offsetX = 0;
    let offsetY = 0;
    let previousBodyUserSelect = '';

    const finishDrag = event => {
      if (!dragging || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      if (document.body) document.body.style.userSelect = previousBodyUserSelect;
      try {
        if (pointerId !== null && handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {}
      pointerId = null;
      const rect = panel.getBoundingClientRect();
      writeJson(localStorage, POSITION_KEY, { left: rect.left, top: rect.top });
    };

    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest('button, input')) return;
      const rect = panel.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      placePanel(panel, rect.left, rect.top);
      dragging = true;
      pointerId = event.pointerId;
      handle.classList.add('is-dragging');
      previousBodyUserSelect = document.body?.style.userSelect || '';
      if (document.body) document.body.style.userSelect = 'none';
      try { handle.setPointerCapture?.(event.pointerId); } catch {}
      event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== pointerId) return;
      placePanel(panel, event.clientX - offsetX, event.clientY - offsetY);
      event.preventDefault();
    });

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);
  }

  function keepPanelInViewport() {
    if (ui.panel?.dataset.gdfpDragged !== 'true') return;
    const rect = ui.panel.getBoundingClientRect();
    placePanel(ui.panel, rect.left, rect.top);
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    injectStyles();

    const prefs = readJson(localStorage, PREFS_KEY, {});
    shuffleMode = Boolean(prefs.shuffle);
    repeatMode = REPEAT_MODES.includes(prefs.repeat) ? prefs.repeat : 'off';

    // Expanded view
    const minimizeButton = iconButton('minimize', 'Minimize player', () => applyMinimizedState(true));
    const header = h('div', { class: 'gdfp-header', title: 'Drag to move' },
      h('div', { class: 'gdfp-brand' }, icon('note', 16), h('span', {}, 'Drive Folder Player')),
      minimizeButton);

    ui.title = h('div', { class: 'gdfp-title' });
    ui.sub = h('div', { class: 'gdfp-sub' });
    const now = h('div', { class: 'gdfp-now' },
      h('div', { class: 'gdfp-art' }, icon('note', 26)),
      h('div', { class: 'gdfp-now-text' }, ui.title, ui.sub));

    ui.seek = h('input', { type: 'range', class: 'gdfp-range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Seek' });
    ui.elapsed = h('span', {}, '0:00');
    ui.duration = h('span', {}, '0:00');
    const seek = h('div', { class: 'gdfp-seek' }, ui.seek, h('div', { class: 'gdfp-times' }, ui.elapsed, ui.duration));

    ui.shuffle = iconButton('shuffle', 'Shuffle', toggleShuffle, 'gdfp-icon-btn gdfp-toggle');
    ui.repeat = iconButton('repeat', 'Repeat', toggleRepeat, 'gdfp-icon-btn gdfp-toggle');
    const previous = iconButton('previous', 'Previous', () => void previousNow(), 'gdfp-icon-btn', 26);
    const next = iconButton('next', 'Next', () => void nextNow(), 'gdfp-icon-btn', 26);
    const play = iconButton('play', 'Play', togglePlay, 'gdfp-play', 28);
    const transport = h('div', { class: 'gdfp-transport' }, ui.shuffle, previous, play, next, ui.repeat);

    ui.libName = h('div', { class: 'gdfp-lib-name' });
    ui.libMeta = h('div', { class: 'gdfp-lib-meta' });
    ui.scanLabel = h('span', {}, 'Scan');
    ui.scan = h('button', {
      type: 'button', class: 'gdfp-chip',
      onclick: () => (discoveryRunning ? stopDiscovery() : void discoverFullFolder())
    }, icon('refresh', 18), ui.scanLabel);
    ui.scanBar = h('div', { class: 'gdfp-scanbar', hidden: true });

    ui.searchInput = h('input', {
      type: 'search', placeholder: 'Search tracks', 'aria-label': 'Search tracks', autocomplete: 'off', spellcheck: 'false'
    });
    ui.clearSearch = iconButton('close', 'Clear search', () => {
      trackSearchQuery = '';
      ui.searchInput.value = '';
      renderQueue();
      ui.searchInput.focus();
    }, 'gdfp-icon-btn', 16);
    const locate = iconButton('locate', 'Show current track', () => {
      if (trackSearchQuery) {
        trackSearchQuery = '';
        ui.searchInput.value = '';
        renderQueue();
      }
      scrollCurrentIntoView(true);
    }, 'gdfp-icon-btn', 18);
    ui.searchWrap = h('div', { class: 'gdfp-search' },
      h('label', { class: 'gdfp-search-box' }, icon('search', 18), ui.searchInput, ui.clearSearch),
      locate);
    ui.list = h('div', { class: 'gdfp-list', role: 'list', 'aria-label': 'Tracks' });

    const library = h('div', { class: 'gdfp-library' },
      h('div', { class: 'gdfp-lib-head' }, h('div', { class: 'gdfp-lib-info' }, ui.libName, ui.libMeta), ui.scan),
      ui.scanBar, ui.searchWrap, ui.list);

    ui.status = h('div', { class: 'gdfp-status' }, 'Ready.');
    ui.log = h('pre', { class: 'gdfp-log' });
    const diagnostics = h('details', { class: 'gdfp-diag' },
      h('summary', {}, `Diagnostics · v${VERSION}`),
      h('div', { class: 'gdfp-diag-actions' },
        h('button', { type: 'button', onclick: stopPlayback }, 'Stop playback'),
        h('button', { type: 'button', onclick: seekLast5s }, 'Jump to last 5 s')),
      ui.log);
    const footer = h('div', { class: 'gdfp-footer' }, ui.status, diagnostics);

    const full = h('div', { class: 'gdfp-full' }, header, now, seek, transport, library, footer);

    // Minimized view
    ui.miniTitle = h('div', { class: 'gdfp-mini-title' });
    ui.miniBar = h('span');
    const miniPrevious = iconButton('previous', 'Previous', () => void previousNow());
    const miniPlay = iconButton('play', 'Play', togglePlay, 'gdfp-play', 22);
    const miniNext = iconButton('next', 'Next', () => void nextNow());
    const restore = iconButton('expand', 'Expand player', () => applyMinimizedState(false), 'gdfp-icon-btn', 18);
    const mini = h('div', { class: 'gdfp-mini', title: 'Drag to move' },
      h('div', { class: 'gdfp-art' }, icon('note', 18)),
      h('div', { class: 'gdfp-mini-text' }, ui.miniTitle, h('div', { class: 'gdfp-mini-progress' }, ui.miniBar)),
      miniPrevious, miniPlay, miniNext, restore);

    const panel = h('section', { id: PANEL_ID, 'aria-label': 'Google Drive Folder Player' }, full, mini);
    ui.panel = panel;
    ui.previousButtons = [previous, miniPrevious];
    ui.nextButtons = [next, miniNext];
    ui.playButtons = [play, miniPlay];

    // Seek bar
    ui.seek.addEventListener('input', () => {
      seekDragging = true;
      const media = directCurrent?.media;
      const pct = Number(ui.seek.value) / 1000;
      ui.seek.style.setProperty('--pct', `${pct * 100}%`);
      if (media && Number.isFinite(media.duration)) ui.elapsed.textContent = formatTime(pct * media.duration);
    });
    ui.seek.addEventListener('change', () => {
      const media = directCurrent?.media;
      if (media && Number.isFinite(media.duration) && media.duration > 0) {
        media.currentTime = (Number(ui.seek.value) / 1000) * media.duration;
        log(`Seeked to ${formatTime(media.currentTime)} / ${formatTime(media.duration)}.`);
      }
      seekDragging = false;
      renderPlayback();
    });

    // Search
    ui.searchInput.addEventListener('input', () => {
      trackSearchQuery = ui.searchInput.value;
      renderQueue();
      ui.list.scrollTop = 0;
    });
    ui.searchInput.addEventListener('keydown', event => {
      if (event.key === 'Escape' && trackSearchQuery) {
        event.preventDefault();
        trackSearchQuery = '';
        ui.searchInput.value = '';
        renderQueue();
      } else if (event.key === 'Enter') {
        const first = ui.list.querySelector('.gdfp-row');
        if (first) {
          event.preventDefault();
          const items = playlist.length ? playlist : discoveredItems;
          const item = items[Number(first.dataset.index)];
          if (item) void playSelectedTrack(item.id);
        }
      }
    });

    document.body.appendChild(panel);
    enablePanelDragging(panel, header);
    enablePanelDragging(panel, mini);

    let minimized = false;
    try {
      minimized = sessionStorage.getItem(MINIMIZED_KEY) === '1';
    } catch {}

    function applyMinimizedState(value) {
      minimized = Boolean(value);
      panel.classList.toggle('is-min', minimized);
      try {
        sessionStorage.setItem(MINIMIZED_KEY, minimized ? '1' : '0');
      } catch {}
      requestAnimationFrame(keepPanelInViewport);
      if (!minimized) requestAnimationFrame(() => scrollCurrentIntoView());
    }

    applyMinimizedState(minimized);

    const saved = readJson(localStorage, POSITION_KEY, null);
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      requestAnimationFrame(() => placePanel(panel, saved.left, saved.top));
    }
    window.addEventListener('resize', keepPanelInViewport);

    syncLibraryWithLocation();
    renderDiscoverySummary();
    renderPlayback();
    renderQueue();
    updateButtons();
    setupMediaSession();
    setInterval(renderPlayback, 300);

    // Drive is a single-page app: follow folder navigation.
    syncTheme();
    let lastHref = location.href;
    let lastTitle = document.title;
    let themeTick = 0;
    setInterval(() => {
      if ((themeTick = (themeTick + 1) % 5) === 0) syncTheme();
      if (location.href === lastHref && document.title === lastTitle) return;
      lastHref = location.href;
      lastTitle = document.title;
      syncLibraryWithLocation();
    }, 800);
    setInterval(renderDiscoverySummary, 30000);

    log(`Version ${VERSION} mounted; authuser=${authuserIndex()}; folder=${currentFolderKey()}.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mount();
  }

  init();
})();
