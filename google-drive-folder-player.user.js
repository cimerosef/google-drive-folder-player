// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.7
// @description  Prototype continuous Google Drive media playback with preview-title based transition detection.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.7';
  const PANEL_ID = 'gdfp-probe-panel';
  const MEDIA_EXTENSIONS = [
    'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma',
    'webm', 'aiff', 'aif', 'm4b', 'mp4'
  ];
  const MEDIA_RE = new RegExp(
    `([^\\/\\n\\r]{1,320}\\.(?:${MEDIA_EXTENSIONS.join('|')}))(?=\\s|$)`,
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
  let diagnosticHistory = [];

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log('[GDFP Probe]', ...args);

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  }

  function isRendered(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return getComputedStyle(element).display !== 'none';
  }

  function isInsidePanel(element) {
    return Boolean(element.closest?.(`#${PANEL_ID}`));
  }

  function extractMediaName(element) {
    const values = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('data-tooltip'),
      element.textContent
    ];
    for (const value of values) {
      if (!value || value.length > 900) continue;
      const match = value.trim().match(MEDIA_RE);
      if (match) return match[1].trim();
    }
    return null;
  }

  function normalizeName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getItemId(root) {
    if (!(root instanceof Element)) return '';
    const direct = root.getAttribute('data-id') || root.getAttribute('data-target');
    if (direct) return direct;
    const child = root.querySelector('[data-id], [data-target]');
    return child?.getAttribute('data-id') || child?.getAttribute('data-target') || '';
  }

  function collectFolderRows() {
    const roots = [...document.querySelectorAll('[role="row"], [role="listitem"], [role="gridcell"]')]
      .filter(root => isVisible(root) && !isInsidePanel(root));

    const seen = new Set();
    const results = [];
    for (const root of roots) {
      const name = extractMediaName(root);
      if (!name) continue;
      const id = getItemId(root);
      const key = id || normalizeName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ name, id, root });
    }
    return results;
  }

  function scanCurrentView() {
    const results = collectFolderRows();
    if (results.length) detectedItems = results;
    renderResults();
    setStatus(results.length
      ? `Scan finished: ${results.length} visible media row(s) cached.`
      : 'No new media rows found. The previous successful scan, if any, is kept.');
    addDiagnostic(`Scan: ${results.length} live row(s); cache now ${detectedItems.length}.`);
    return results;
  }

  function findProgressSlider() {
    const sliders = [...document.querySelectorAll('[role="slider"][aria-valuenow], input[type="range"][aria-valuenow], [aria-valuenow][aria-valuemin][aria-valuemax]')]
      .filter(element => !isInsidePanel(element) && isRendered(element))
      .map(element => {
        const now = Number(element.getAttribute('aria-valuenow'));
        const min = Number(element.getAttribute('aria-valuemin'));
        const max = Number(element.getAttribute('aria-valuemax'));
        const span = max - min;
        const rect = element.getBoundingClientRect();
        return { element, now, min, max, span, width: rect.width };
      })
      .filter(item => [item.now, item.min, item.max].every(Number.isFinite) && item.max > item.min);

    if (!sliders.length) return null;
    sliders.sort((a, b) => {
      const ap = a.span > 100 ? 1 : 0;
      const bp = b.span > 100 ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.span !== b.span) return b.span - a.span;
      return b.width - a.width;
    });
    return sliders[0].element;
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

  function findPreviewTitle() {
    const candidates = [...document.querySelectorAll('[aria-label], [title], span, div')];
    let best = null;

    for (const element of candidates) {
      if (isInsidePanel(element) || !isVisible(element)) continue;
      if (element.closest('[role="row"], [role="listitem"], [role="gridcell"]')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 115 || rect.left < 25) continue;
      const name = extractMediaName(element);
      if (!name) continue;
      const score = (element.children.length === 0 ? 20 : 0) + Math.max(0, 500 - rect.left) / 100;
      if (!best || score > best.score) best = { element, name, score };
    }
    return best;
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
      .filter(({ rect }) => rect.top >= 0 && rect.top < 105 && rect.left >= 0 && rect.left < 105 && rect.width <= 90 && rect.height <= 90)
      .sort((a, b) => (a.rect.top + a.rect.left) - (b.rect.top + b.rect.left))[0]?.element || null;
  }

  function getPreviewEvidence() {
    const title = findPreviewTitle();
    const progress = getProgressState();
    return {
      open: Boolean(title || progress),
      titleName: title?.name || '',
      titleElement: title?.element || null,
      progress
    };
  }

  function previewIsOpen() {
    return getPreviewEvidence().open;
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

  async function closePreview() {
    const before = getPreviewEvidence();
    if (!before.open) return true;

    const close = findPreviewCloseButton();
    if (!close) {
      setStatus('Transition blocked: preview is open but its close control was not found.');
      addDiagnostic(`Close failed: no close control. Preview title: ${before.titleName || '(none)'}.`);
      return false;
    }

    addDiagnostic(`Closing preview: ${before.titleName || '(title not detected)'}.`);
    clickElement(close);

    for (let i = 0; i < 30; i += 1) {
      await sleep(100);
      if (!getPreviewEvidence().open) {
        await sleep(350);
        addDiagnostic('Preview closed and folder view settled.');
        return true;
      }
    }

    setStatus('Transition blocked: Drive ignored the scripted close-button click.');
    addDiagnostic('Close timed out after 3 seconds.');
    return false;
  }

  function matchesTarget(item, target) {
    if (!item || !target) return false;
    if (target.id && item.id) return item.id === target.id;
    return normalizeName(item.name) === normalizeName(target.name);
  }

  async function resolveFreshItem(target) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const rows = collectFolderRows();
      let item = rows.find(row => matchesTarget(row, target));
      if (item?.root?.isConnected && isVisible(item.root)) {
        item.root.scrollIntoView({ block: 'center', inline: 'nearest' });
        await sleep(220);
        item = collectFolderRows().find(row => matchesTarget(row, target));
        if (item?.root?.isConnected && isVisible(item.root)) {
          addDiagnostic(`Resolved row on attempt ${attempt}; stable id: ${target.id ? 'yes' : 'no'}.`);
          return item;
        }
      }
      await sleep(180);
    }

    addDiagnostic(`Row resolution failed: ${target.name}`);
    return null;
  }

  async function waitForPreview(target, timeoutMs = 6500) {
    const started = Date.now();
    let lastTitle = '';
    while (Date.now() - started < timeoutMs) {
      const evidence = getPreviewEvidence();
      if (evidence.titleName) lastTitle = evidence.titleName;
      if (evidence.open) {
        if (!evidence.titleName || normalizeName(evidence.titleName) === normalizeName(target.name)) {
          return { ok: true, evidence };
        }
      }
      await sleep(120);
    }
    return { ok: false, lastTitle };
  }

  async function tryOpenTarget(target, index, reason, attempt) {
    const live = await resolveFreshItem(target);
    if (!live?.root?.isConnected) {
      setStatus(`Transition failed: no fresh Drive row for ${target.name}`);
      return false;
    }

    setStatus(`Opening ${index + 1}/${playlist.length} (${reason}, attempt ${attempt}): ${target.name}`);
    addDiagnostic(`Open attempt ${attempt}: ${target.name}`);
    dispatchDoubleClick(live.root);

    const result = await waitForPreview(target, 6500);
    if (result.ok) {
      addDiagnostic(`Preview confirmed: ${result.evidence.titleName || '(no title; progress control detected)'}.`);
      return true;
    }

    addDiagnostic(`Open attempt ${attempt} timed out. Last preview title: ${result.lastTitle || '(none)'}.`);
    return false;
  }

  async function openPlaylistIndex(index, reason = 'manual') {
    if (!playlist.length || advancing || index < 0 || index >= playlist.length) return false;
    advancing = true;
    endArmed = false;
    lastRatio = null;

    try {
      const target = playlist[index];
      const previousIndex = currentIndex;

      if (getPreviewEvidence().open && !(await closePreview())) return false;

      let opened = await tryOpenTarget(target, index, reason, 1);
      if (!opened) {
        const evidence = getPreviewEvidence();
        if (evidence.open && (!evidence.titleName || normalizeName(evidence.titleName) === normalizeName(target.name))) {
          opened = true;
          addDiagnostic('Late preview detected after timeout; accepting transition.');
        }
      }

      if (!opened) {
        if (getPreviewEvidence().open) await closePreview();
        await sleep(300);
        opened = await tryOpenTarget(target, index, reason, 2);
      }

      if (!opened) {
        setStatus(`Transition failed: Drive preview did not open for ${target.name}`);
        currentIndex = previousIndex;
        renderPlaybackState('Transition failed; current index preserved');
        addDiagnostic(`Transition failed; index remains ${previousIndex + 1}/${playlist.length}.`);
        return false;
      }

      currentIndex = index;
      setStatus(`Playing ${index + 1}/${playlist.length}: ${target.name}`);
      renderPlaybackState('Waiting for progress');
      addDiagnostic(`Transition accepted -> track ${index + 1}/${playlist.length}.`);
      startMonitor();
      return true;
    } finally {
      advancing = false;
    }
  }

  async function startContinuousTest() {
    if (!detectedItems.length) scanCurrentView();
    if (!detectedItems.length) {
      setStatus('No media rows cached. Close preview, scan the folder, then retry.');
      return;
    }

    autoMode = true;
    playlist = detectedItems.map(item => ({ name: item.name, id: item.id || '' }));
    currentIndex = -1;
    diagnosticHistory = [];
    addDiagnostic(`Playlist captured: ${playlist.length}; ${playlist.filter(item => item.id).length} with stable Drive ids.`);
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
    addDiagnostic('Continuous test stopped.');
  }

  async function nextNow() {
    if (!playlist.length) playlist = detectedItems.map(item => ({ name: item.name, id: item.id || '' }));
    if (!playlist.length) {
      setStatus('No cached media items. Scan the folder first.');
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
      addDiagnostic('Playlist finished.');
      return;
    }
    setStatus(`End detected. Advancing to ${nextIndex + 1}/${playlist.length}…`);
    addDiagnostic(`End inferred for track ${currentIndex + 1}; advancing.`);
    await openPlaylistIndex(nextIndex, 'automatic next');
  }

  function monitorTick() {
    if (!autoMode || advancing || currentIndex < 0) return;
    const progress = getProgressState();
    if (!progress) {
      renderPlaybackState('Preview open; progress control unavailable/hidden');
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

  function probeTransition() {
    const evidence = getPreviewEvidence();
    const close = findPreviewCloseButton();
    const title = evidence.titleName || '(none)';
    const progress = evidence.progress
      ? `${Math.round(evidence.progress.ratio * 1000) / 10}% [${evidence.progress.min}..${evidence.progress.max}]`
      : '(none)';
    const closeDesc = close
      ? `${close.tagName.toLowerCase()} label="${close.getAttribute('aria-label') || close.getAttribute('title') || '(none)'}"`
      : '(none)';
    addDiagnostic(`Probe -> open=${evidence.open}; title=${title}; progress=${progress}; close=${closeDesc}`);
  }

  function setStatus(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (node) node.textContent = text;
  }

  function addDiagnostic(text) {
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    diagnosticHistory.push(`${stamp}  ${text}`);
    diagnosticHistory = diagnosticHistory.slice(-8);
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="diagnostic"]`);
    if (node) node.textContent = diagnosticHistory.join('\n');
    log(text);
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
    count.textContent = `${detectedItems.length} cached visible media item(s)`;
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
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647',
      width: '410px', maxHeight: '78vh', overflow: 'auto', boxSizing: 'border-box',
      padding: '12px', borderRadius: '12px', background: 'rgba(32,33,36,.97)',
      color: '#f1f3f4', boxShadow: '0 8px 30px rgba(0,0,0,.32)',
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
    Object.assign(controls.style, { display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '9px' });
    controls.append(
      makeButton('Scan folder view', scanCurrentView),
      makeButton('Start continuous test', startContinuousTest),
      makeButton('Next now', nextNow),
      makeButton('Stop', stopContinuousTest),
      makeButton('Probe transition', probeTransition)
    );

    const playback = document.createElement('div');
    playback.dataset.gdfp = 'playback-status';
    playback.textContent = 'Continuous: OFF | Track: —';
    Object.assign(playback.style, {
      marginBottom: '9px', padding: '8px', borderRadius: '7px', whiteSpace: 'pre-wrap',
      background: 'rgba(129,201,149,.12)', border: '1px solid rgba(129,201,149,.28)', overflowWrap: 'anywhere'
    });

    const diagnostic = document.createElement('div');
    diagnostic.dataset.gdfp = 'diagnostic';
    diagnostic.textContent = 'Transition history will appear here.';
    Object.assign(diagnostic.style, {
      marginBottom: '9px', padding: '8px', borderRadius: '7px', whiteSpace: 'pre-wrap',
      background: 'rgba(138,180,248,.12)', border: '1px solid rgba(138,180,248,.28)', overflowWrap: 'anywhere',
      fontSize: '11px'
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
    note.textContent = 'Probe 0.0.7 no longer treats a visible progress slider as the only proof that a preview is open. It also detects the preview title, so WebM/video previews with auto-hidden controls can be confirmed. Still @grant none; no Google API.';
    Object.assign(note.style, {
      marginTop: '9px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.65', fontSize: '11px'
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
