// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.6
// @description  Prototype continuous Google Drive audio playback with fresh row resolution between preview transitions.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.6';
  const PANEL_ID = 'gdfp-probe-panel';
  const AUDIO_EXTENSIONS = [
    'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma',
    'webm', 'aiff', 'aif', 'm4b'
  ];
  const AUDIO_RE = new RegExp(
    `([^\\/\\n\\r]{1,240}\\.(?:${AUDIO_EXTENSIONS.join('|')}))(?=\\s|$)`,
    'i'
  );

  let detectedItems = [];
  let playlist = [];
  let currentIndex = -1;
  let autoMode = false;
  let advancing = false;
  let endArmed = false;
  let monitorTimer = null;
  let lastRatio = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log('[GDFP Probe]', ...args);

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  }

  function isInsidePanel(element) {
    return Boolean(element.closest?.(`#${PANEL_ID}`));
  }

  function extractAudioName(element) {
    const values = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('data-tooltip'),
      element.textContent
    ];
    for (const value of values) {
      if (!value || value.length > 600) continue;
      const match = value.trim().match(AUDIO_RE);
      if (match) return match[1].trim();
    }
    return null;
  }

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element) || isInsidePanel(node)) break;
      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (node.hasAttribute('data-id') || node.hasAttribute('data-target')) fallback = node;
    }
    return fallback;
  }

  function getItemId(root) {
    if (!(root instanceof Element)) return '';
    const direct = root.getAttribute('data-id') || root.getAttribute('data-target');
    if (direct) return direct;
    const child = root.querySelector('[data-id], [data-target]');
    return child?.getAttribute('data-id') || child?.getAttribute('data-target') || '';
  }

  function getVisibleSliders() {
    return [...document.querySelectorAll('[role="slider"], input[type="range"], [aria-valuenow]')]
      .filter(element => isVisible(element) && !isInsidePanel(element))
      .filter(element => {
        const now = Number(element.getAttribute('aria-valuenow'));
        const min = Number(element.getAttribute('aria-valuemin'));
        const max = Number(element.getAttribute('aria-valuemax'));
        return [now, min, max].every(Number.isFinite) && max > min;
      });
  }

  function findProgressSlider() {
    const sliders = getVisibleSliders();
    if (!sliders.length) return null;
    return sliders
      .map(element => {
        const min = Number(element.getAttribute('aria-valuemin'));
        const max = Number(element.getAttribute('aria-valuemax'));
        const span = max - min;
        const rect = element.getBoundingClientRect();
        return { element, span, width: rect.width };
      })
      .sort((a, b) => {
        const ap = a.span > 100 ? 1 : 0;
        const bp = b.span > 100 ? 1 : 0;
        if (ap !== bp) return bp - ap;
        if (a.span !== b.span) return b.span - a.span;
        return b.width - a.width;
      })[0]?.element || null;
  }

  function getProgressState() {
    const slider = findProgressSlider();
    if (!slider) return null;
    const now = Number(slider.getAttribute('aria-valuenow'));
    const min = Number(slider.getAttribute('aria-valuemin'));
    const max = Number(slider.getAttribute('aria-valuemax'));
    if (![now, min, max].every(Number.isFinite) || max <= min) return null;
    return {
      slider,
      now,
      min,
      max,
      ratio: Math.max(0, Math.min(1, (now - min) / (max - min)))
    };
  }

  function previewIsOpen() {
    return Boolean(findProgressSlider());
  }

  function isLikelyPreviewElement(element) {
    if (!(element instanceof Element) || !isVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.top < 140 || Boolean(element.closest?.('[role="dialog"]'));
  }

  function collectFolderRows() {
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );
    const seenRoots = new Set();
    const seenKeys = new Set();
    const results = [];

    for (const element of candidates) {
      if (isInsidePanel(element)) continue;
      const name = extractAudioName(element);
      if (!name) continue;
      if (previewIsOpen() && isLikelyPreviewElement(element) && !element.closest('[role="row"], [role="listitem"]')) continue;

      const root = findItemRoot(element);
      if (!root || !isVisible(root)) continue;
      const role = root.getAttribute('role');
      if (previewIsOpen() && role !== 'row' && role !== 'listitem' && isLikelyPreviewElement(root)) continue;

      const rect = root.getBoundingClientRect();
      const id = getItemId(root);
      const key = `${id || name.toLowerCase()}::${Math.round(rect.top)}::${Math.round(rect.left)}`;
      if (seenRoots.has(root) || seenKeys.has(key)) continue;
      seenRoots.add(root);
      seenKeys.add(key);
      results.push({ name, id, root });
    }
    return results;
  }

  function scanCurrentView() {
    const results = collectFolderRows();
    if (results.length) detectedItems = results;
    renderResults();
    setStatus(results.length
      ? `Scan finished: ${results.length} visible audio row(s) cached.`
      : 'No new folder rows found. The previous successful scan, if any, is kept.');
    return results;
  }

  function dispatchDoubleClick(element) {
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1
    };
    element.dispatchEvent(new MouseEvent('mousedown', { ...common, detail: 1 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...common, detail: 1 }));
    element.dispatchEvent(new MouseEvent('click', { ...common, detail: 1 }));
    element.dispatchEvent(new MouseEvent('mousedown', { ...common, detail: 2 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...common, detail: 2 }));
    element.dispatchEvent(new MouseEvent('click', { ...common, detail: 2 }));
    element.dispatchEvent(new MouseEvent('dblclick', { ...common, detail: 2 }));
  }

  function findPreviewCloseButton() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(element => isVisible(element) && !isInsidePanel(element));

    const textMatch = /close|fermer|schlie|cerrar|chiudi|fechar|sluiten|关闭|關閉|閉じ|닫기/i;
    const labelled = buttons.find(element => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
      return textMatch.test(label);
    });
    if (labelled) return labelled;

    return buttons
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top >= 0 && rect.top < 110 && rect.left >= 0 && rect.left < 110 && rect.width <= 90 && rect.height <= 90)
      .sort((a, b) => (a.rect.top + a.rect.left) - (b.rect.top + b.rect.left))[0]?.element || null;
  }

  function clickElement(element) {
    if (!element) return;
    try {
      element.click();
    } catch {
      element.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      }));
    }
  }

  async function closePreview() {
    if (!previewIsOpen()) return true;

    const close = findPreviewCloseButton();
    if (!close) {
      setStatus('Transition blocked: preview is open but its close control was not found.');
      return false;
    }

    setStatus('Closing the current Drive preview via its visible close control…');
    clickElement(close);

    for (let i = 0; i < 20; i += 1) {
      await sleep(100);
      if (!previewIsOpen()) {
        // Give Drive time to restore/rebuild the folder list after the preview disappears.
        await sleep(300);
        return true;
      }
    }

    setStatus('Transition blocked: Drive ignored the scripted close-button click.');
    return false;
  }

  function matchesTarget(item, target) {
    if (!item || !target) return false;
    if (target.id && item.id) return item.id === target.id;
    return item.name.toLowerCase() === target.name.toLowerCase();
  }

  async function resolveFreshItem(target) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const rows = collectFolderRows();
      let item = rows.find(row => matchesTarget(row, target));

      if (item?.root?.isConnected && isVisible(item.root)) {
        item.root.scrollIntoView({ block: 'center', inline: 'nearest' });
        // Scrolling can trigger Drive virtualization, so reacquire the row afterwards.
        await sleep(220);
        const settledRows = collectFolderRows();
        item = settledRows.find(row => matchesTarget(row, target));
        if (item?.root?.isConnected && isVisible(item.root)) {
          setDiagnostic(`Fresh row resolved on attempt ${attempt}. Stable id: ${target.id ? 'yes' : 'no'}.`);
          return item;
        }
      }

      await sleep(180);
    }

    setDiagnostic(`Fresh row resolution failed for: ${target.name}`);
    return null;
  }

  async function waitForPreview(timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (previewIsOpen()) return true;
      await sleep(100);
    }
    return false;
  }

  async function tryOpenTarget(target, index, reason, attempt) {
    const live = await resolveFreshItem(target);
    if (!live?.root?.isConnected) {
      setStatus(`Transition failed: no fresh Drive row for ${target.name}`);
      return false;
    }

    setStatus(`Opening ${index + 1}/${playlist.length} (${reason}, attempt ${attempt}): ${target.name}`);
    dispatchDoubleClick(live.root);
    return waitForPreview(4500);
  }

  async function openPlaylistIndex(index, reason = 'manual') {
    if (!playlist.length || advancing || index < 0 || index >= playlist.length) return false;
    advancing = true;
    endArmed = false;
    lastRatio = null;

    try {
      const target = playlist[index];
      const previousIndex = currentIndex;

      if (previewIsOpen() && !(await closePreview())) return false;

      let opened = await tryOpenTarget(target, index, reason, 1);
      if (!opened) {
        setDiagnostic(`First open attempt failed for ${target.name}. Reacquiring the live row and retrying once.`);
        await sleep(300);
        opened = await tryOpenTarget(target, index, reason, 2);
      }

      if (!opened) {
        setStatus(`Transition failed: Drive preview did not open for ${target.name}`);
        currentIndex = previousIndex;
        renderPlaybackState('Transition failed; current index preserved');
        return false;
      }

      // Only commit the new playlist position after Drive confirms that the preview opened.
      currentIndex = index;
      setStatus(`Playing ${index + 1}/${playlist.length}: ${target.name}`);
      renderPlaybackState('Waiting for progress');
      setDiagnostic(`Transition succeeded to track ${index + 1}/${playlist.length}.`);
      startMonitor();
      return true;
    } finally {
      advancing = false;
    }
  }

  async function startContinuousTest() {
    if (!detectedItems.length) scanCurrentView();
    if (!detectedItems.length) {
      setStatus('No audio rows cached. Close preview, scan the folder, then retry.');
      return;
    }

    autoMode = true;
    playlist = detectedItems.map(item => ({ name: item.name, id: item.id || '' }));
    currentIndex = -1;
    setDiagnostic(`Playlist captured: ${playlist.length} item(s); ${playlist.filter(item => item.id).length} with stable Drive ids.`);
    await openPlaylistIndex(0, 'start');
  }

  function stopContinuousTest() {
    autoMode = false;
    endArmed = false;
    lastRatio = null;
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    setStatus('Continuous test stopped. Drive playback itself was left untouched.');
    renderPlaybackState('Stopped');
  }

  async function nextNow() {
    if (!playlist.length) {
      playlist = detectedItems.map(item => ({ name: item.name, id: item.id || '' }));
    }
    if (!playlist.length) {
      setStatus('No cached audio items. Scan the folder first.');
      return;
    }

    autoMode = true;
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    if (nextIndex >= playlist.length) {
      stopContinuousTest();
      setStatus('Reached the end of the cached test playlist.');
      return;
    }
    await openPlaylistIndex(nextIndex, 'Next now');
  }

  async function handleTrackEnd() {
    if (!autoMode || advancing || currentIndex < 0) return;
    endArmed = false;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= playlist.length) {
      autoMode = false;
      setStatus(`Cached playlist finished (${playlist.length} track(s)).`);
      renderPlaybackState('Playlist finished');
      return;
    }
    setStatus(`End detected. Advancing to ${nextIndex + 1}/${playlist.length}…`);
    await openPlaylistIndex(nextIndex, 'automatic next');
  }

  function monitorTick() {
    if (!autoMode || advancing || !previewIsOpen()) return;
    const progress = getProgressState();
    if (!progress) {
      renderPlaybackState('No progress slider');
      return;
    }

    const ratio = progress.ratio;
    if (!endArmed && ratio < 0.95) endArmed = true;
    const percent = Math.round(ratio * 1000) / 10;
    renderPlaybackState(`${percent}%${endArmed ? ' · armed' : ' · waiting reset'}`);

    if (endArmed && ratio >= 0.995 && (lastRatio === null || lastRatio < 0.995)) {
      log('Track end inferred from Drive progress slider.', progress);
      void handleTrackEnd();
    }
    lastRatio = ratio;
  }

  function startMonitor() {
    if (monitorTimer) return;
    monitorTimer = setInterval(monitorTick, 250);
  }

  function probePreviewUi() {
    const progress = getProgressState();
    const close = findPreviewCloseButton();
    if (!previewIsOpen()) {
      setDiagnostic('No Drive audio preview detected.');
      return;
    }

    const closeDesc = close
      ? `${close.tagName.toLowerCase()} label="${close.getAttribute('aria-label') || close.getAttribute('title') || '(none)'}" @ ${Math.round(close.getBoundingClientRect().left)},${Math.round(close.getBoundingClientRect().top)}`
      : 'not found';
    setDiagnostic(
      `Progress: ${progress ? `${Math.round(progress.ratio * 1000) / 10}% [${progress.min}..${progress.max}]` : 'not found'}\n` +
      `Close control: ${closeDesc}\n` +
      `Current playlist index: ${currentIndex >= 0 ? currentIndex + 1 : 'none'}`
    );
  }

  function setStatus(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (node) node.textContent = text;
  }

  function setDiagnostic(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="diagnostic"]`);
    if (node) node.textContent = text;
  }

  function renderPlaybackState(detail = '') {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="playback-status"]`);
    if (!box) return;
    const name = currentIndex >= 0 && playlist[currentIndex] ? playlist[currentIndex].name : '—';
    const position = currentIndex >= 0 && playlist.length ? `${currentIndex + 1}/${playlist.length}` : '—';
    box.textContent = `Continuous: ${autoMode ? 'ON' : 'OFF'} | Track: ${position} | ${detail}\n${name}`;
  }

  function renderResults() {
    const count = document.querySelector(`#${PANEL_ID} [data-gdfp="count"]`);
    const list = document.querySelector(`#${PANEL_ID} [data-gdfp="list"]`);
    if (!count || !list) return;

    count.textContent = `${detectedItems.length} cached visible audio item(s)`;
    list.replaceChildren();
    for (const item of detectedItems.slice(0, 8)) {
      const row = document.createElement('div');
      row.textContent = item.name;
      row.title = item.name;
      row.style.whiteSpace = 'nowrap';
      row.style.overflow = 'hidden';
      row.style.textOverflow = 'ellipsis';
      list.appendChild(row);
    }
    if (detectedItems.length > 8) {
      const more = document.createElement('div');
      more.textContent = `… +${detectedItems.length - 8} more`;
      more.style.opacity = '0.7';
      list.appendChild(more);
    }
  }

  function makeButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      border: '1px solid rgba(255,255,255,.28)',
      borderRadius: '7px',
      padding: '7px 10px',
      background: 'rgba(255,255,255,.11)',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      zIndex: '2147483647',
      width: '400px',
      maxHeight: '78vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(32,33,36,.97)',
      color: '#f1f3f4',
      boxShadow: '0 8px 30px rgba(0,0,0,.32)',
      font: '13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Google Drive Folder Player — Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '8px';

    const status = document.createElement('div');
    status.dataset.gdfp = 'status';
    status.textContent = 'Ready. Close preview, scan the music folder, then start the test.';
    status.style.marginBottom = '9px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '7px',
      flexWrap: 'wrap',
      marginBottom: '9px'
    });
    controls.append(
      makeButton('Scan folder view', scanCurrentView),
      makeButton('Start continuous test', startContinuousTest),
      makeButton('Next now', nextNow),
      makeButton('Stop', stopContinuousTest),
      makeButton('Probe transition', probePreviewUi)
    );

    const playback = document.createElement('div');
    playback.dataset.gdfp = 'playback-status';
    playback.textContent = 'Continuous: OFF | Track: —';
    Object.assign(playback.style, {
      marginBottom: '9px',
      padding: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(129,201,149,.12)',
      border: '1px solid rgba(129,201,149,.28)',
      overflowWrap: 'anywhere'
    });

    const diagnostic = document.createElement('div');
    diagnostic.dataset.gdfp = 'diagnostic';
    diagnostic.textContent = 'Transition diagnostic: not run yet.';
    Object.assign(diagnostic.style, {
      marginBottom: '9px',
      padding: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(138,180,248,.12)',
      border: '1px solid rgba(138,180,248,.28)',
      overflowWrap: 'anywhere'
    });

    const count = document.createElement('div');
    count.dataset.gdfp = 'count';
    count.textContent = 'Not scanned yet';
    count.style.fontWeight = '600';
    count.style.marginBottom = '5px';

    const list = document.createElement('div');
    list.dataset.gdfp = 'list';
    Object.assign(list.style, { display: 'grid', gap: '2px' });

    const note = document.createElement('div');
    note.textContent = 'Probe 0.0.6 reacquires a fresh Drive row after every preview close and after scrolling, then retries one failed open. Failed transitions no longer advance the playlist index. Still @grant none; no Google API.';
    Object.assign(note.style, {
      marginTop: '9px',
      paddingTop: '8px',
      borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.65',
      fontSize: '11px'
    });

    panel.append(title, status, controls, playback, diagnostic, count, list, note);
    document.body.appendChild(panel);
    log(`Probe ${VERSION} mounted.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mountPanel();
  }

  init();
})();
