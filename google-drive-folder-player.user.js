// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.24
// @description  Full-folder MP3/WebM discovery with direct playback, preload, Shuffle/Repeat and background-safe handoff.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.24';
  const PANEL_ID = 'gdfp-probe-panel';
  const MEDIA_RE = /([^\/\n\r]{1,320}\.(?:mp3|webm))(?=\s|$)/i;
  const REPEAT_MODES = ['off', 'all', 'one'];
  const STEP_SETTLE_MS = 360;
  const BOTTOM_SETTLE_MS = 650;
  const MAX_STEPS = 240;

  let discoveredItems = [];
  let playlist = [];
  let currentIndex = -1;
  let shuffleMode = false;
  let repeatMode = 'off';
  let autoMode = false;
  let advancing = false;
  let discoveryRunning = false;
  let stopDiscoveryRequested = false;
  let directCurrent = null;
  let directNext = null;
  let transitionRequestedAt = 0;
  let logLines = [];

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-120);
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="log"]`);
    if (node) node.textContent = logLines.join('\n');
    console.log('[GDFP]', text);
  }

  function extensionOf(name) {
    return String(name || '').toLowerCase().endsWith('.webm') ? 'webm' : 'mp3';
  }

  function labelOf(item) {
    return extensionOf(item?.name).toUpperCase();
  }

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

  function collectRenderedRows() {
    const candidates = document.querySelectorAll(
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

  function addRowsToMap(map) {
    const rows = collectRenderedRows();
    let added = 0;
    for (const row of rows) {
      if (map.has(row.id)) continue;
      map.set(row.id, { id: row.id, name: row.name, type: row.type });
      added += 1;
    }
    return { rows, added };
  }

  function setStatus(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (node) node.textContent = text;
  }

  function renderDiscoverySummary() {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="summary"]`);
    if (!node) return;
    const mp3 = discoveredItems.filter(item => item.type === 'mp3').length;
    const webm = discoveredItems.filter(item => item.type === 'webm').length;
    node.textContent = `${discoveryRunning ? 'DISCOVERING' : 'READY'} | ${discoveredItems.length} full-folder item(s) | ${mp3} MP3 | ${webm} WebM`;
  }

  async function discoverFullFolder() {
    if (discoveryRunning || autoMode) {
      if (autoMode) setStatus('Stop playback before running full-folder discovery.');
      return false;
    }

    const scroller = findScrollContainer();
    if (!scroller) {
      setStatus('Could not identify the Drive folder scroll container.');
      log('Discovery aborted: no scroll container found.');
      return false;
    }

    discoveryRunning = true;
    stopDiscoveryRequested = false;
    renderDiscoverySummary();

    const originalTop = scroller.scrollTop;
    const originalLeft = scroller.scrollLeft;
    const found = new Map();
    scroller.scrollTo({ top: 0, behavior: 'auto' });
    await sleep(BOTTOM_SETTLE_MS);
    let sample = addRowsToMap(found);
    log(`Discovery top pass: rendered=${sample.rows.length}, unique=${found.size}.`);

    let lastTop = scroller.scrollTop;
    let noMovementRounds = 0;
    let noNewRounds = 0;
    let steps = 0;

    while (!stopDiscoveryRequested && steps < MAX_STEPS) {
      steps += 1;
      const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const stepSize = Math.max(260, Math.floor(scroller.clientHeight * 0.72));
      const target = Math.min(range, scroller.scrollTop + stepSize);
      scroller.scrollTo({ top: target, behavior: 'auto' });
      await sleep(STEP_SETTLE_MS);

      sample = addRowsToMap(found);
      const currentTop = scroller.scrollTop;
      const currentRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atBottom = currentRange - currentTop <= 8;
      noMovementRounds = Math.abs(currentTop - lastTop) < 2 ? noMovementRounds + 1 : 0;
      noNewRounds = sample.added === 0 ? noNewRounds + 1 : 0;
      lastTop = currentTop;
      setStatus(`Discovering full folder… ${found.size} unique item(s), step ${steps}.`);
      log(`Step ${steps}: top=${Math.round(currentTop)}/${Math.round(currentRange)}, rendered=${sample.rows.length}, +${sample.added}, unique=${found.size}${atBottom ? ' · bottom' : ''}.`);

      if (atBottom) {
        await sleep(BOTTOM_SETTLE_MS);
        const finalSample = addRowsToMap(found);
        const finalRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const stillBottom = finalRange - scroller.scrollTop <= 8;
        log(`Bottom settle: +${finalSample.added}, unique=${found.size}, stillBottom=${stillBottom}.`);
        if (stillBottom && finalSample.added === 0) break;
      }

      if (noMovementRounds >= 4 && noNewRounds >= 4) {
        log('Discovery stopped after four unchanged rounds.');
        break;
      }
    }

    scroller.scrollTo({ top: Math.min(originalTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight)), behavior: 'auto' });
    scroller.scrollLeft = originalLeft;
    await sleep(250);

    const stopped = stopDiscoveryRequested;
    if (!stopped && found.size) {
      discoveredItems = [...found.values()];
      const mp3 = discoveredItems.filter(item => item.type === 'mp3').length;
      const webm = discoveredItems.filter(item => item.type === 'webm').length;
      setStatus(`Full-folder discovery complete: ${discoveredItems.length} item(s) (${mp3} MP3, ${webm} WebM).`);
      log(`Discovery completed: ${discoveredItems.length} unique item(s): ${mp3} MP3, ${webm} WebM; steps=${steps}.`);
    } else if (stopped) {
      setStatus(`Discovery stopped; previous complete result kept (${discoveredItems.length} item(s)).`);
      log(`Discovery stopped by user at ${found.size} temporary item(s); previous complete result preserved.`);
    }

    discoveryRunning = false;
    stopDiscoveryRequested = false;
    renderDiscoverySummary();
    renderQueue();
    return !stopped && found.size > 0;
  }

  function stopDiscovery() {
    if (!discoveryRunning) return;
    stopDiscoveryRequested = true;
    log('Stop discovery requested.');
  }

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

  function clearNext() {
    if (!directNext) return;
    disposeMedia(directNext.media);
    directNext = null;
  }

  function clearCurrent() {
    if (!directCurrent) return;
    disposeMedia(directCurrent.media);
    directCurrent = null;
  }

  function clearMedia() {
    clearCurrent();
    clearNext();
  }

  function createSlot(item, index, role) {
    const media = createMedia(item);
    const slot = { media, item: { ...item }, index, role, ready: false, failed: false };

    media.addEventListener('loadedmetadata', () => log(`${slot.role} ${labelOf(item)} metadata: ${index + 1}/${playlist.length} · ${Math.round(media.duration || 0)}s.`));
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
      if (slot === directCurrent && transitionRequestedAt) {
        log(`Audible-start latency: ${Math.round(performance.now() - transitionRequestedAt)} ms.`);
        transitionRequestedAt = 0;
      }
    });
    media.addEventListener('ended', () => {
      if (directCurrent !== slot || currentIndex !== index) return;
      log(`Natural end: ${index + 1}/${playlist.length} [${labelOf(item)}].`);
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
    let slot;
    let promoted = false;

    try {
      if (directNext && directNext.index === index && directNext.item.id === target.id && !directNext.failed) {
        slot = directNext;
        directNext = null;
        slot.role = 'current';
        promoted = true;
        log(`Promoting preloaded ${index + 1}/${playlist.length}.`);
      } else {
        slot = createSlot(target, index, 'current');
        log(`Created current media ${index + 1}/${playlist.length} [${labelOf(target)}].`);
      }

      directCurrent = slot;
      const ready = await waitReady(slot, promoted ? 6000 : 10000);
      if (!ready || slot.failed) {
        if (directCurrent === slot) directCurrent = oldCurrent;
        disposeMedia(slot.media);
        setStatus(`Direct media failed to become ready: ${target.name}`);
        return false;
      }

      if (oldCurrent && oldCurrent !== slot) oldCurrent.media.pause();
      transitionRequestedAt = performance.now();
      await slot.media.play();
      if (oldCurrent && oldCurrent !== slot) disposeMedia(oldCurrent.media);
      currentIndex = index;
      setStatus(`Playing ${index + 1}/${playlist.length} [${labelOf(target)}]${promoted ? ' from preload' : ''}: ${target.name}`);
      log(`Playing ${index + 1}/${playlist.length} via direct media (${reason})${promoted ? ' from preload' : ''}.`);
      prepareNext();
      renderPlayback();
      renderQueue();
      return true;
    } catch (error) {
      transitionRequestedAt = 0;
      if (slot && directCurrent === slot) directCurrent = oldCurrent;
      if (slot) disposeMedia(slot.media);
      setStatus(`play() failed: ${error?.name || 'Error'}`);
      log(`play() failed for ${target.name}: ${error?.name || 'Error'}.`);
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
    log(`Queue built: ${playlist.length} track(s), mode=${shuffleMode ? 'SHUFFLE' : 'ORDERED'}, repeat=${repeatMode.toUpperCase()}.`);
    renderQueue();
    await playIndex(0, 'start');
  }

  async function nextNow() {
    if (!playlist.length) {
      setStatus('Start a queue first.');
      return;
    }
    autoMode = true;
    let next = currentIndex + 1;
    if (next >= playlist.length) {
      if (repeatMode === 'all') next = 0;
      else {
        setStatus('Queue end reached.');
        return;
      }
    }
    await playIndex(next, 'Next now');
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
    let next = currentIndex + 1;
    if (next >= playlist.length) {
      if (repeatMode === 'all') next = 0;
      else {
        autoMode = false;
        clearNext();
        setStatus(`Queue finished (${playlist.length} track(s)).`);
        renderPlayback();
        return;
      }
    }
    await playIndex(next, 'natural next');
  }

  function stopPlayback() {
    autoMode = false;
    transitionRequestedAt = 0;
    clearMedia();
    setStatus('Playback stopped.');
    renderPlayback();
  }

  function toggleShuffle() {
    shuffleMode = !shuffleMode;
    updateButtons();
    setStatus(`Shuffle ${shuffleMode ? 'ON' : 'OFF'}; applies when the queue is rebuilt.`);
  }

  function toggleRepeat() {
    repeatMode = REPEAT_MODES[(REPEAT_MODES.indexOf(repeatMode) + 1) % REPEAT_MODES.length];
    updateButtons();
    prepareNext();
    setStatus(`Repeat ${repeatMode.toUpperCase()}.`);
  }

  function updateButtons() {
    const shuffle = document.querySelector(`#${PANEL_ID} [data-gdfp="shuffle"]`);
    const repeat = document.querySelector(`#${PANEL_ID} [data-gdfp="repeat"]`);
    if (shuffle) {
      shuffle.textContent = `Shuffle: ${shuffleMode ? 'ON' : 'OFF'}`;
      shuffle.style.background = shuffleMode ? 'rgba(129,201,149,.22)' : 'rgba(255,255,255,.10)';
    }
    if (repeat) {
      repeat.textContent = `Repeat: ${repeatMode.toUpperCase()}`;
      repeat.style.background = repeatMode === 'off' ? 'rgba(255,255,255,.10)' : repeatMode === 'all' ? 'rgba(138,180,248,.22)' : 'rgba(196,181,253,.22)';
    }
  }

  function renderPlayback() {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="playback"]`);
    if (!node) return;
    if (currentIndex < 0 || !playlist[currentIndex]) {
      node.textContent = `Playback: OFF | Queue: ${playlist.length || 0}`;
      return;
    }
    const current = playlist[currentIndex];
    const media = directCurrent?.media;
    const ratio = media && Number.isFinite(media.duration) && media.duration > 0 ? media.currentTime / media.duration : 0;
    const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 1000) / 10;
    const preload = directNext ? (directNext.ready ? 'next preloaded' : 'next loading') : 'no next preload';
    node.textContent = `${autoMode ? 'ON' : 'PAUSED'} | ${currentIndex + 1}/${playlist.length} | ${labelOf(current)} | ${percent}% | ${preload}\n${current.name}`;
  }

  function renderQueue() {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="queue"]`);
    if (!node) return;
    if (!playlist.length) {
      node.textContent = discoveredItems.length
        ? `Full-folder cache ready: ${discoveredItems.length} item(s). Build a queue to play.`
        : 'No full-folder cache yet.';
      return;
    }
    const start = currentIndex >= 0 ? currentIndex : 0;
    const end = Math.min(playlist.length, start + 6);
    const lines = [`Queue: ${playlist.length} track(s) · ${shuffleMode ? 'SHUFFLE' : 'ORDERED'} · Repeat ${repeatMode.toUpperCase()}`];
    for (let i = start; i < end; i += 1) lines.push(`${i === currentIndex ? '▶' : ' '} ${i + 1}. [${labelOf(playlist[i])}] ${playlist[i].name}`);
    if (end < playlist.length) lines.push(`… +${playlist.length - end} later`);
    node.textContent = lines.join('\n');
  }

  function button(label, handler, role = '') {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    if (role) node.dataset.gdfp = role;
    Object.assign(node.style, {
      padding: '7px 10px', borderRadius: '7px', border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)', color: 'inherit', cursor: 'pointer', font: 'inherit'
    });
    node.addEventListener('click', handler);
    return node;
  }

  function clampPanelPosition(panel, left, top) {
    const margin = 4;
    const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, left)),
      top: Math.min(maxTop, Math.max(margin, top))
    };
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
      handle.style.cursor = 'grab';
      if (document.body) document.body.style.userSelect = previousBodyUserSelect;
      try {
        if (pointerId !== null && handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {}
      pointerId = null;
    };

    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.dataset.gdfpDragged = 'true';
      dragging = true;
      pointerId = event.pointerId;
      handle.style.cursor = 'grabbing';
      previousBodyUserSelect = document.body?.style.userSelect || '';
      if (document.body) document.body.style.userSelect = 'none';
      try { handle.setPointerCapture?.(event.pointerId); } catch {}
      event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== pointerId) return;
      const position = clampPanelPosition(panel, event.clientX - offsetX, event.clientY - offsetY);
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      event.preventDefault();
    });

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);

    window.addEventListener('resize', () => {
      if (panel.dataset.gdfpDragged !== 'true') return;
      const rect = panel.getBoundingClientRect();
      const position = clampPanelPosition(panel, rect.left, rect.top);
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
    });
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647', width: '540px', maxHeight: '84vh',
      overflow: 'auto', boxSizing: 'border-box', padding: '12px', borderRadius: '12px', background: 'rgba(32,33,36,.97)',
      color: '#f1f3f4', border: '1px solid rgba(255,255,255,.18)', boxShadow: '0 8px 30px rgba(0,0,0,.32)',
      font: '13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Google Drive Folder Player — Probe ${VERSION}`;
    title.title = 'Drag this title bar to move the panel';
    Object.assign(title.style, {
      fontWeight: '650', marginBottom: '7px', cursor: 'grab', userSelect: 'none', touchAction: 'none'
    });

    const note = document.createElement('div');
    note.textContent = '0.0.24 integrates verified full-folder MP3/WebM discovery with the validated direct-media/preload player. The current Music-folder baseline is 160 files (144 MP3 + 16 WebM).';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '9px' });
    controls.append(
      button('Discover full folder', () => void discoverFullFolder()),
      button('Stop discovery', stopDiscovery),
      button('Shuffle: OFF', toggleShuffle, 'shuffle'),
      button('Repeat: OFF', toggleRepeat, 'repeat'),
      button('Start full queue', () => void startQueue()),
      button('Next now', () => void nextNow()),
      button('Seek last 5s', seekLast5s),
      button('Stop playback', stopPlayback)
    );

    const summary = document.createElement('div');
    summary.dataset.gdfp = 'summary';
    Object.assign(summary.style, {
      marginBottom: '8px', padding: '8px', borderRadius: '7px',
      background: 'rgba(129,201,149,.10)', border: '1px solid rgba(129,201,149,.20)'
    });

    const status = document.createElement('div');
    status.dataset.gdfp = 'status';
    status.textContent = 'Ready. Discover the full folder, choose Shuffle/Repeat, then start the full queue.';
    Object.assign(status.style, {
      marginBottom: '8px', padding: '8px', borderRadius: '7px',
      background: 'rgba(129,201,149,.10)', border: '1px solid rgba(129,201,149,.20)'
    });

    const playback = document.createElement('div');
    playback.dataset.gdfp = 'playback';
    Object.assign(playback.style, {
      marginBottom: '8px', padding: '8px', borderRadius: '7px', whiteSpace: 'pre-wrap',
      background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', overflowWrap: 'anywhere'
    });

    const queue = document.createElement('div');
    queue.dataset.gdfp = 'queue';
    Object.assign(queue.style, {
      marginBottom: '8px', padding: '8px', borderRadius: '7px', whiteSpace: 'pre-wrap',
      background: 'rgba(251,188,4,.08)', border: '1px solid rgba(251,188,4,.20)', overflowWrap: 'anywhere', fontSize: '11px'
    });

    const logBox = document.createElement('div');
    logBox.dataset.gdfp = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '7px',
      background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '160px', fontSize: '11px'
    });

    panel.append(title, note, controls, summary, status, playback, queue, logBox);
    document.body.appendChild(panel);
    enablePanelDragging(panel, title);
    renderDiscoverySummary();
    renderPlayback();
    renderQueue();
    updateButtons();
    setInterval(renderPlayback, 300);
    log(`Probe ${VERSION} mounted; full-folder direct player ready; authuser=${authuserIndex()}.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mount();
  }

  init();
})();
