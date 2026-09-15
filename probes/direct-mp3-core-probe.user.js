// ==UserScript==
// @name         Google Drive Folder Player - Direct MP3 Core Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Multi-track direct MP3 playback core: scan visible Drive MP3 rows, preload the next track, and advance without Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-direct-mp3-core-probe';
  const MP3_RE = /([^\/\n\r]{1,320}\.mp3)(?=\s|$)/i;

  let queue = [];
  let currentIndex = -1;
  let currentAudio = null;
  let nextAudio = null;
  let nextAudioIndex = -1;
  let autoMode = false;
  let switching = false;
  let pendingSwitchStartedAt = 0;
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-80);
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-direct="log"]`);
    if (box) box.textContent = logLines.join('\n');
    console.log('[GDFP Direct MP3 Core Probe]', text);
  }

  function extractName(element) {
    if (!(element instanceof Element)) return '';
    const values = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-tooltip'),
      element.textContent
    ];
    for (const value of values) {
      if (!value || value.length > 1800) continue;
      const match = value.trim().match(MP3_RE);
      if (match) return match[1].trim();
    }
    return '';
  }

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element)) break;
      if (node.closest?.(`#${PANEL_ID}`)) break;
      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (
        node.hasAttribute('data-id') ||
        node.hasAttribute('data-target') ||
        node.hasAttribute('data-file-id') ||
        node.hasAttribute('data-docid')
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
      return url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/)?.[1] || '';
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
    if (!(element instanceof Element)) return false;
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
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(item.id)}&export=download&confirm=t&authuser=${encodeURIComponent(authuserIndex())}`;
  }

  function scanVisibleMp3s() {
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );
    const seenRoots = new Set();
    const seenIds = new Set();
    const results = [];

    for (const element of candidates) {
      if (element.closest?.(`#${PANEL_ID}`)) continue;
      const name = extractName(element);
      if (!name) continue;
      const root = findItemRoot(element);
      if (!root || !isVisible(root) || seenRoots.has(root)) continue;
      const id = getItemId(root);
      if (!id || seenIds.has(id)) continue;
      seenRoots.add(root);
      seenIds.add(id);
      results.push({ name, id });
    }

    queue = results;
    currentIndex = -1;
    renderState('Scanned');
    renderQueue();
    log(`Scan complete: ${queue.length} visible MP3 item(s), ${queue.length} stable Drive id(s), authuser=${authuserIndex()}.`);
  }

  function audioSummary(audio) {
    if (!audio) return 'none';
    const duration = Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : 'n/a';
    const buffered = audio.buffered?.length
      ? `${audio.buffered.start(0).toFixed(1)}-${audio.buffered.end(audio.buffered.length - 1).toFixed(1)}`
      : '(empty)';
    return `ready=${audio.readyState} net=${audio.networkState} paused=${audio.paused} t=${audio.currentTime.toFixed(1)}/${duration} buffered=${buffered}`;
  }

  function attachAudioEvents(audio, index, role) {
    const item = queue[index];
    const events = ['loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'error'];
    for (const eventName of events) {
      audio.addEventListener(eventName, () => {
        const error = audio.error ? ` errorCode=${audio.error.code}` : '';
        log(`${role} ${index + 1}/${queue.length} ${eventName}: ${audioSummary(audio)}${error}`);

        if (eventName === 'playing' && role === 'current' && pendingSwitchStartedAt) {
          const elapsed = Math.round(performance.now() - pendingSwitchStartedAt);
          log(`Direct transition audible-start latency: ${elapsed} ms.`);
          pendingSwitchStartedAt = 0;
        }
      });
    }

    audio.addEventListener('timeupdate', () => {
      if (audio !== currentAudio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const percent = Math.max(0, Math.min(100, (audio.currentTime / audio.duration) * 100));
      renderState(`${percent.toFixed(1)}% · direct MP3${nextAudioIndex >= 0 ? ' · next preloaded' : ''}`);
    });

    audio.addEventListener('ended', () => {
      if (audio !== currentAudio || !autoMode || switching) return;
      log(`Track ${index + 1}/${queue.length} ended naturally.`);
      void advanceTo(index + 1, 'automatic next');
    });

    log(`${role} Audio created for ${item?.name || '(unknown)'} using authuser=${authuserIndex()}.`);
  }

  function makeAudio(index, role) {
    const item = queue[index];
    if (!item) return null;
    const audio = new Audio();
    audio.preload = 'auto';
    attachAudioEvents(audio, index, role);
    audio.src = directUrl(item);
    audio.load();
    return audio;
  }

  function disposeAudio(audio) {
    if (!audio) return;
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch {
      // Experimental cleanup only.
    }
  }

  function prepareNext(index) {
    const targetIndex = index + 1;
    disposeAudio(nextAudio);
    nextAudio = null;
    nextAudioIndex = -1;

    if (targetIndex >= queue.length) {
      renderState('Playing · no later track to preload');
      return;
    }

    nextAudioIndex = targetIndex;
    nextAudio = makeAudio(targetIndex, 'next');
    renderState('Playing · preloading next MP3');
    log(`Preload requested for next track ${targetIndex + 1}/${queue.length}: ${queue[targetIndex].name}`);
  }

  async function playCurrent(index, reason) {
    currentIndex = index;
    renderQueue();
    renderState(`${reason} · direct MP3`);
    try {
      await currentAudio.play();
      log(`Playing ${index + 1}/${queue.length}: ${queue[index].name}`);
      prepareNext(index);
      return true;
    } catch (error) {
      log(`Play rejected for ${queue[index].name}: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
      return false;
    }
  }

  async function advanceTo(index, reason) {
    if (switching || index < 0) return false;
    if (index >= queue.length) {
      autoMode = false;
      renderState('Queue finished');
      log('Queue finished. Repeat is intentionally not implemented in this probe.');
      return false;
    }

    switching = true;
    try {
      const oldAudio = currentAudio;
      let candidate = null;

      if (nextAudio && nextAudioIndex === index) {
        candidate = nextAudio;
        nextAudio = null;
        nextAudioIndex = -1;
        log(`Promoting preloaded track ${index + 1}/${queue.length} to current.`);
      } else {
        candidate = makeAudio(index, 'current');
        log(`No reusable preload for track ${index + 1}; created a fresh direct Audio.`);
      }

      try { oldAudio?.pause(); } catch {}
      currentAudio = candidate;
      pendingSwitchStartedAt = performance.now();

      const ok = await playCurrent(index, reason);
      if (oldAudio && oldAudio !== currentAudio) disposeAudio(oldAudio);
      return ok;
    } finally {
      switching = false;
    }
  }

  async function start() {
    if (!queue.length) scanVisibleMp3s();
    if (!queue.length) {
      log('No visible MP3 queue found. Keep the Drive list visible and scan again.');
      return;
    }

    stop(false);
    autoMode = true;
    currentAudio = makeAudio(0, 'current');
    currentIndex = 0;
    renderQueue();
    renderState('Starting direct MP3');

    try {
      await currentAudio.play();
      log(`Started direct MP3 queue at 1/${queue.length}: ${queue[0].name}`);
      prepareNext(0);
    } catch (error) {
      autoMode = false;
      log(`Initial play rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
    }
  }

  async function nextNow() {
    if (!queue.length) return log('Scan the MP3 list first.');
    autoMode = true;
    const target = currentIndex >= 0 ? currentIndex + 1 : 0;
    await advanceTo(target, 'manual next');
  }

  function seekNearEnd() {
    if (!currentAudio || !Number.isFinite(currentAudio.duration) || currentAudio.duration <= 6) {
      log('Current MP3 duration is not ready yet.');
      return;
    }
    currentAudio.currentTime = Math.max(0, currentAudio.duration - 5);
    log(`Current track seeked to last ~5 seconds (${currentAudio.currentTime.toFixed(1)}/${currentAudio.duration.toFixed(1)}).`);
  }

  function stop(report = true) {
    autoMode = false;
    switching = false;
    pendingSwitchStartedAt = 0;
    disposeAudio(currentAudio);
    disposeAudio(nextAudio);
    currentAudio = null;
    nextAudio = null;
    nextAudioIndex = -1;
    currentIndex = -1;
    renderQueue();
    renderState('Stopped');
    if (report) log('Direct MP3 playback stopped.');
  }

  function renderState(detail = '') {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-direct="state"]`);
    if (!box) return;
    const name = currentIndex >= 0 && queue[currentIndex] ? queue[currentIndex].name : '—';
    const pos = currentIndex >= 0 ? `${currentIndex + 1}/${queue.length}` : '—';
    box.textContent = `Direct: ${autoMode ? 'ON' : 'OFF'} | Track: ${pos} | ${detail}\n${name}`;
  }

  function renderQueue() {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-direct="queue"]`);
    if (!box) return;
    if (!queue.length) {
      box.textContent = 'Queue: not scanned';
      return;
    }
    const start = currentIndex >= 0 ? currentIndex : 0;
    const lines = [`Visible MP3 queue: ${queue.length} track(s)`];
    for (let i = start; i < Math.min(queue.length, start + 7); i += 1) {
      lines.push(`${i === currentIndex ? '▶' : ' '} ${i + 1}. ${queue[i].name}`);
    }
    if (start + 7 < queue.length) lines.push(`… +${queue.length - (start + 7)} later`);
    box.textContent = lines.join('\n');
  }

  function makeButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      padding: '6px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)', color: 'inherit', cursor: 'pointer', font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mountPanel() {
    if (!document.body || document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', width: '650px', maxHeight: '74vh', overflow: 'auto',
      boxSizing: 'border-box', padding: '10px', borderRadius: '10px', background: 'rgba(25,27,30,.97)', color: '#f1f3f4',
      border: '1px solid rgba(255,255,255,.18)', boxShadow: '0 6px 22px rgba(0,0,0,.3)',
      font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Direct MP3 Core Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'MP3 only. No Drive Preview. Scans currently visible Drive MP3 rows, plays them through direct Audio, and always preloads one next track. Ordered queue only; Shuffle/Repeat/WebM are intentionally excluded from this first core test.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const state = document.createElement('div');
    state.dataset.gdfpDirect = 'state';
    Object.assign(state.style, { marginBottom: '8px', padding: '7px', borderRadius: '6px', background: 'rgba(129,201,149,.10)', whiteSpace: 'pre-wrap' });

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(
      makeButton('Scan visible MP3s', scanVisibleMp3s),
      makeButton('Start direct queue', start),
      makeButton('Next now', nextNow),
      makeButton('Seek current to last 5s', seekNearEnd),
      makeButton('Stop', () => stop(true))
    );

    const queueBox = document.createElement('div');
    queueBox.dataset.gdfpDirect = 'queue';
    Object.assign(queueBox.style, { marginBottom: '8px', padding: '7px', borderRadius: '6px', background: 'rgba(251,188,4,.09)', border: '1px solid rgba(251,188,4,.22)', whiteSpace: 'pre-wrap', fontSize: '11px' });

    const logBox = document.createElement('div');
    logBox.dataset.gdfpDirect = 'log';
    Object.assign(logBox.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '6px', background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '160px' });

    panel.append(title, note, state, controls, queueBox, logBox);
    document.body.appendChild(panel);
    renderState('Ready');
    renderQueue();
    log(`Probe ${VERSION} mounted. authuser=${authuserIndex()}.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mountPanel();
  }

  init();
})();
