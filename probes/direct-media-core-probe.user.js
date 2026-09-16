// ==UserScript==
// @name         Google Drive Folder Player - Direct Media Core Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Mixed MP3/WebM direct-media queue with next-track preload and no Google Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-direct-media-core-probe';
  const MEDIA_RE = /([^\/\n\r]{1,320}\.(?:mp3|webm))(?=\s|$)/i;

  let queue = [];
  let currentIndex = -1;
  let currentSlot = null;
  let nextSlot = null;
  let autoMode = false;
  let advancing = false;
  let transitionRequestedAt = 0;
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-90);
    const box = document.querySelector(`#${PANEL_ID} [data-dm="log"]`);
    if (box) box.textContent = logLines.join('\n');
    console.log('[GDFP Direct Media Probe]', text);
  }

  function extensionOf(name) {
    return String(name || '').toLowerCase().endsWith('.webm') ? 'webm' : 'mp3';
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

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element) || node.closest?.(`#${PANEL_ID}`)) break;
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
      const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
      return match?.[1] || '';
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

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
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

  function scanVisible() {
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );
    const seenRoots = new Set();
    const seenIds = new Set();
    const items = [];

    for (const element of candidates) {
      if (!(element instanceof Element) || element.closest(`#${PANEL_ID}`)) continue;
      const name = extractName(element);
      if (!name) continue;
      const root = findItemRoot(element);
      if (!root || !isVisible(root) || seenRoots.has(root)) continue;
      const id = getItemId(root);
      if (!id || seenIds.has(id)) continue;
      seenRoots.add(root);
      seenIds.add(id);
      items.push({ name, id, type: extensionOf(name) });
    }

    queue = items;
    currentIndex = -1;
    disposeSlot(currentSlot);
    disposeSlot(nextSlot);
    currentSlot = null;
    nextSlot = null;
    autoMode = false;
    render();

    const mp3 = items.filter(item => item.type === 'mp3').length;
    const webm = items.filter(item => item.type === 'webm').length;
    log(`Scan complete: ${items.length} direct media item(s): ${mp3} MP3, ${webm} WebM; authuser=${authuserIndex()}.`);
  }

  function createElementFor(item) {
    const media = item.type === 'webm' ? document.createElement('video') : new Audio();
    media.preload = 'auto';
    media.controls = false;
    if (item.type === 'webm') {
      media.playsInline = true;
      media.style.display = 'none';
    }
    return media;
  }

  function bufferedText(media) {
    if (!media?.buffered?.length) return '(empty)';
    try {
      return `${media.buffered.start(0).toFixed(1)}-${media.buffered.end(media.buffered.length - 1).toFixed(1)}`;
    } catch {
      return '(unavailable)';
    }
  }

  function attachEvents(slot, role) {
    const { media, item, index } = slot;
    for (const eventName of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'ended', 'error']) {
      media.addEventListener(eventName, () => {
        const duration = Number.isFinite(media.duration) ? media.duration.toFixed(1) : 'n/a';
        const error = media.error ? ` errorCode=${media.error.code}` : '';
        log(`${role} ${index + 1}/${queue.length} ${item.type.toUpperCase()} ${eventName}: ready=${media.readyState} net=${media.networkState} paused=${media.paused} t=${media.currentTime.toFixed(1)}/${duration} buffered=${bufferedText(media)}${error}`);

        if (eventName === 'canplay') {
          slot.ready = true;
          render();
        }
        if (eventName === 'error') slot.failed = true;

        if (role === 'current' && eventName === 'ended' && currentSlot === slot && currentIndex === index) {
          if (autoMode && !advancing) void advanceTo(index + 1, 'natural end');
        }

        if (role === 'current' && eventName === 'playing' && transitionRequestedAt) {
          log(`Transition audible-start latency: ${Math.round(performance.now() - transitionRequestedAt)} ms.`);
          transitionRequestedAt = 0;
        }
      });
    }
  }

  function createSlot(item, index, role) {
    const media = createElementFor(item);
    const slot = { media, item: { ...item }, index, ready: false, failed: false };
    attachEvents(slot, role);
    media.src = directUrl(item);
    media.load();
    log(`${role} preload requested: ${index + 1}/${queue.length} [${item.type.toUpperCase()}] ${item.name}`);
    return slot;
  }

  function disposeSlot(slot) {
    if (!slot?.media) return;
    try {
      slot.media.pause();
      slot.media.removeAttribute('src');
      slot.media.load();
      slot.media.remove();
    } catch {}
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

  function preloadNext() {
    const index = currentIndex + 1;
    if (index < 0 || index >= queue.length) {
      disposeSlot(nextSlot);
      nextSlot = null;
      render();
      return;
    }
    if (nextSlot && nextSlot.index === index && nextSlot.item.id === queue[index].id && !nextSlot.failed) return;
    disposeSlot(nextSlot);
    nextSlot = createSlot(queue[index], index, 'next');
    render();
  }

  async function playSlotAsCurrent(slot, index, reason, promoted) {
    const old = currentSlot;
    currentSlot = slot;
    currentIndex = index;
    const ready = await waitReady(slot, promoted ? 6000 : 10000);
    if (!ready || slot.failed) {
      log(`Target failed to become ready: ${queue[index]?.name || 'unknown'}.`);
      currentSlot = old;
      return false;
    }

    if (old && old !== slot) disposeSlot(old);
    transitionRequestedAt = performance.now();
    try {
      await slot.media.play();
    } catch (error) {
      transitionRequestedAt = 0;
      log(`play() rejected for ${queue[index].name}: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
      return false;
    }

    log(`Playing ${index + 1}/${queue.length} [${queue[index].type.toUpperCase()}] via direct media${promoted ? ' from preload' : ''}: ${queue[index].name} (${reason}).`);
    render();
    preloadNext();
    return true;
  }

  async function advanceTo(index, reason) {
    if (advancing || index < 0 || index >= queue.length) {
      if (index >= queue.length && autoMode) {
        autoMode = false;
        log('Queue finished.');
        render();
      }
      return false;
    }

    advancing = true;
    try {
      let slot;
      let promoted = false;
      if (nextSlot && nextSlot.index === index && nextSlot.item.id === queue[index].id && !nextSlot.failed) {
        slot = nextSlot;
        nextSlot = null;
        promoted = true;
        log(`Promoting preloaded track ${index + 1}/${queue.length}.`);
      } else {
        slot = createSlot(queue[index], index, 'current');
      }
      return await playSlotAsCurrent(slot, index, reason, promoted);
    } finally {
      advancing = false;
    }
  }

  async function startQueue() {
    if (!queue.length) scanVisible();
    if (!queue.length) return log('No visible MP3/WebM rows with stable Drive IDs were found.');
    autoMode = true;
    disposeSlot(currentSlot);
    disposeSlot(nextSlot);
    currentSlot = null;
    nextSlot = null;
    currentIndex = -1;
    log(`Starting mixed direct-media queue (${queue.length} tracks). No Drive Preview should open.`);
    await advanceTo(0, 'start');
  }

  async function nextNow() {
    if (!queue.length) return log('Scan visible MP3/WebM rows first.');
    autoMode = true;
    const target = currentIndex >= 0 ? currentIndex + 1 : 0;
    if (target >= queue.length) return log('Already at queue end.');
    await advanceTo(target, 'Next now');
  }

  function seekNearEnd() {
    const media = currentSlot?.media;
    if (!media || !Number.isFinite(media.duration) || media.duration <= 6) {
      return log('Current media duration is not ready yet.');
    }
    media.currentTime = Math.max(0, media.duration - 5);
    log(`Current ${currentSlot.item.type.toUpperCase()} seeked to last ~5 seconds (${media.currentTime.toFixed(1)}/${media.duration.toFixed(1)}).`);
  }

  function stopAll() {
    autoMode = false;
    disposeSlot(currentSlot);
    disposeSlot(nextSlot);
    currentSlot = null;
    nextSlot = null;
    currentIndex = -1;
    transitionRequestedAt = 0;
    render();
    log('Stopped and released direct media elements.');
  }

  function render() {
    const status = document.querySelector(`#${PANEL_ID} [data-dm="status"]`);
    const queueBox = document.querySelector(`#${PANEL_ID} [data-dm="queue"]`);
    if (status) {
      const current = currentIndex >= 0 ? queue[currentIndex] : null;
      const nextReady = nextSlot?.ready ? ' · next preloaded' : nextSlot ? ' · next loading' : '';
      const progress = currentSlot?.media && Number.isFinite(currentSlot.media.duration) && currentSlot.media.duration > 0
        ? `${Math.round((currentSlot.media.currentTime / currentSlot.media.duration) * 1000) / 10}%`
        : '—';
      status.textContent = current
        ? `Direct ON | Track ${currentIndex + 1}/${queue.length} | ${progress} | ${current.type.toUpperCase()}${nextReady}\n${current.name}`
        : `Direct ${autoMode ? 'ON' : 'OFF'} | ${queue.length || 0} queued item(s) | authuser=${authuserIndex()}`;
    }
    if (queueBox) {
      if (!queue.length) {
        queueBox.textContent = 'Queue: not scanned yet.';
      } else {
        const start = Math.max(0, currentIndex >= 0 ? currentIndex : 0);
        const end = Math.min(queue.length, start + 8);
        const lines = [`Mixed direct queue: ${queue.length} track(s)`];
        for (let i = start; i < end; i += 1) {
          lines.push(`${i === currentIndex ? '▶' : ' '} ${i + 1}. [${queue[i].type.toUpperCase()}] ${queue[i].name}`);
        }
        if (end < queue.length) lines.push(`… +${queue.length - end} later`);
        queueBox.textContent = lines.join('\n');
      }
    }
  }

  function button(label, handler) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    Object.assign(node.style, {
      padding: '6px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)', color: 'inherit', cursor: 'pointer', font: 'inherit'
    });
    node.addEventListener('click', handler);
    return node;
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', width: '700px',
      maxHeight: '78vh', overflow: 'auto', boxSizing: 'border-box', padding: '10px', borderRadius: '10px',
      background: 'rgba(25,27,30,.97)', color: '#f1f3f4', border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)', font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Direct Media Core Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'MP3 + WebM only. No Drive Preview. Scans currently visible rows, plays a mixed direct-media queue, and always preloads one next track. Full-folder discovery, Shuffle and Repeat are intentionally excluded from this probe.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(
      button('Scan visible MP3+WebM', scanVisible),
      button('Start direct queue', startQueue),
      button('Next now', nextNow),
      button('Seek current to last 5s', seekNearEnd),
      button('Stop', stopAll)
    );

    const status = document.createElement('div');
    status.dataset.dm = 'status';
    Object.assign(status.style, {
      marginBottom: '8px', padding: '7px', borderRadius: '6px', whiteSpace: 'pre-wrap',
      background: 'rgba(129,201,149,.10)', border: '1px solid rgba(129,201,149,.20)'
    });

    const queueBox = document.createElement('div');
    queueBox.dataset.dm = 'queue';
    Object.assign(queueBox.style, {
      marginBottom: '8px', padding: '7px', borderRadius: '6px', whiteSpace: 'pre-wrap',
      background: 'rgba(251,188,4,.08)', border: '1px solid rgba(251,188,4,.20)'
    });

    const logBox = document.createElement('div');
    logBox.dataset.dm = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '6px',
      background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '160px'
    });

    panel.append(title, note, controls, status, queueBox, logBox);
    document.body.appendChild(panel);
    render();
    log(`Probe ${VERSION} mounted. Mixed direct-media core ready; authuser=${authuserIndex()}.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mount();
  }

  init();
})();
