// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.4
// @description  Prototype continuous audio playback in a Google Drive folder using Drive's native preview UI.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.4';
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

  function log(...args) {
    console.log('[GDFP Probe]', ...args);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  }

  function isInsideOurPanel(element) {
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
      if (!(node instanceof Element)) break;
      if (isInsideOurPanel(node)) break;

      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (node.hasAttribute('data-id') || node.hasAttribute('data-target')) fallback = node;
    }

    return fallback;
  }

  function looksLikePreview(element) {
    if (!(element instanceof Element) || !isVisible(element)) return false;
    const text = (element.innerText || element.textContent || '').slice(0, 4000);
    return AUDIO_RE.test(text) || Boolean(element.querySelector('[role="slider"], [role="progressbar"], input[type="range"], [aria-valuenow]'));
  }

  function getPreviewRoots() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter(element => !isInsideOurPanel(element) && looksLikePreview(element));

    if (dialogs.length) return dialogs;

    const sliders = [...document.querySelectorAll('[role="slider"], input[type="range"]')]
      .filter(element => !isInsideOurPanel(element) && isVisible(element));

    const roots = [];
    for (const slider of sliders) {
      let node = slider;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (!(node instanceof Element)) break;
        const rect = node.getBoundingClientRect();
        if (rect.width > 420 && rect.height > 220) {
          roots.push(node);
          break;
        }
      }
    }
    return [...new Set(roots)];
  }

  function previewIsOpen() {
    return getPreviewRoots().length > 0;
  }

  function isInPreview(element) {
    return getPreviewRoots().some(root => root.contains(element));
  }

  function scanCurrentView() {
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );

    const seenRoots = new Set();
    const seenKeys = new Set();
    const results = [];

    for (const element of candidates) {
      if (isInsideOurPanel(element) || isInPreview(element)) continue;

      const name = extractAudioName(element);
      if (!name) continue;

      const root = findItemRoot(element);
      if (!root || !isVisible(root) || isInPreview(root)) continue;

      const rect = root.getBoundingClientRect();
      const key = `${name.toLowerCase()}::${Math.round(rect.top)}::${Math.round(rect.left)}`;
      if (seenRoots.has(root) || seenKeys.has(key)) continue;

      seenRoots.add(root);
      seenKeys.add(key);
      results.push({ name, root });
    }

    if (results.length) {
      detectedItems = results;
      log(`Detected ${results.length} visible audio item(s).`, results.map(item => item.name));
      renderResults();
      setStatus(
        previewIsOpen()
          ? `Scan found ${results.length} folder item(s) while Drive preview is open.`
          : 'Scan finished. You can now start the continuous playback test.'
      );
      return results;
    }

    renderResults();
    if (previewIsOpen()) {
      setStatus('Drive preview is open and no folder rows were found. Close the preview with Esc, then scan again. The previous scan is kept.');
    } else {
      setStatus('Scan finished. No visible audio file detected. Scroll the Drive folder so audio rows are rendered, then scan again.');
    }
    return [];
  }

  function dispatchDoubleClick(element) {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });

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

  function dispatchEscape() {
    const target = document.activeElement || document.body || document.documentElement;
    const options = {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown', options));
    target.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  async function closePreviewIfNeeded() {
    if (!previewIsOpen()) return true;

    dispatchEscape();
    for (let i = 0; i < 10; i += 1) {
      await sleep(150);
      if (!previewIsOpen()) return true;
    }

    setStatus('Drive preview is still open. Close it manually with Esc or ×, then try again.');
    return false;
  }

  function findCurrentItemByName(name) {
    const lower = name.toLowerCase();

    const cached = detectedItems.find(
      item => item.name.toLowerCase() === lower && item.root?.isConnected
    );
    if (cached) return cached;

    if (!previewIsOpen()) scanCurrentView();
    return detectedItems.find(
      item => item.name.toLowerCase() === lower && item.root?.isConnected
    ) || null;
  }

  async function waitForPreview(timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (previewIsOpen()) return true;
      await sleep(100);
    }
    return false;
  }

  async function openPlaylistIndex(index, reason = 'manual') {
    if (!playlist.length || advancing) return false;
    if (index < 0 || index >= playlist.length) return false;

    advancing = true;
    endArmed = false;
    lastRatio = null;

    try {
      if (!(await closePreviewIfNeeded())) return false;

      const target = playlist[index];
      const live = findCurrentItemByName(target.name);
      if (!live?.root?.isConnected) {
        setStatus(`Could not find the cached Drive row for: ${target.name}`);
        return false;
      }

      currentIndex = index;
      renderPlaybackState(`Opening (${reason})`);
      log(`Opening playlist item ${index + 1}/${playlist.length}:`, target.name);
      dispatchDoubleClick(live.root);

      if (!(await waitForPreview())) {
        setStatus(`Drive preview did not open for: ${target.name}`);
        return false;
      }

      setStatus(`Playing ${currentIndex + 1}/${playlist.length}: ${target.name}`);
      renderPlaybackState('Waiting for progress');
      startMonitor();
      return true;
    } finally {
      advancing = false;
    }
  }

  async function startContinuousTest() {
    if (!detectedItems.length) scanCurrentView();
    if (!detectedItems.length) {
      setStatus('No audio rows cached. Close preview, press Scan, then retry.');
      return;
    }

    autoMode = true;
    playlist = detectedItems.map(item => ({ name: item.name }));
    currentIndex = -1;
    endArmed = false;
    lastRatio = null;
    setStatus(`Continuous test armed with ${playlist.length} cached audio item(s).`);
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
      playlist = detectedItems.map(item => ({ name: item.name }));
    }
    if (!playlist.length) {
      setStatus('No cached audio items. Scan the folder first.');
      return;
    }

    autoMode = true;
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    if (nextIndex >= playlist.length) {
      setStatus('Reached the end of the cached test playlist.');
      stopContinuousTest();
      return;
    }

    await openPlaylistIndex(nextIndex, 'Next now');
  }

  function compactText(value, max = 72) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function getPreviewControls() {
    const root = getPreviewRoots()[0];
    if (!root) return { root: null, controls: [], sliders: [] };

    const controls = [...root.querySelectorAll(
      'button, [role="button"], [role="slider"], [role="progressbar"], input[type="range"], [aria-valuenow]'
    )].filter(element => isVisible(element) && !isInsideOurPanel(element));

    const sliders = controls.filter(element => {
      const now = Number(element.getAttribute('aria-valuenow'));
      const min = Number(element.getAttribute('aria-valuemin'));
      const max = Number(element.getAttribute('aria-valuemax'));
      return Number.isFinite(now) && Number.isFinite(min) && Number.isFinite(max) && max > min;
    });

    return { root, controls, sliders };
  }

  function findProgressSlider() {
    const { sliders } = getPreviewControls();
    if (!sliders.length) return null;

    const scored = sliders
      .map(element => {
        const min = Number(element.getAttribute('aria-valuemin'));
        const max = Number(element.getAttribute('aria-valuemax'));
        const span = max - min;
        const rect = element.getBoundingClientRect();
        return { element, span, width: rect.width };
      })
      .sort((a, b) => {
        const aProgressish = a.span > 100 ? 1 : 0;
        const bProgressish = b.span > 100 ? 1 : 0;
        if (aProgressish !== bProgressish) return bProgressish - aProgressish;
        if (a.span !== b.span) return b.span - a.span;
        return b.width - a.width;
      });

    return scored[0]?.element || null;
  }

  function getProgressState() {
    const slider = findProgressSlider();
    if (!slider) return null;

    const now = Number(slider.getAttribute('aria-valuenow'));
    const min = Number(slider.getAttribute('aria-valuemin'));
    const max = Number(slider.getAttribute('aria-valuemax'));
    if (![now, min, max].every(Number.isFinite) || max <= min) return null;

    const ratio = Math.max(0, Math.min(1, (now - min) / (max - min)));
    return { slider, now, min, max, ratio };
  }

  function describeControl(element) {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role') || '';
    const label = compactText(element.getAttribute('aria-label'));
    const title = compactText(element.getAttribute('title'));
    const text = compactText(element.textContent, 48);
    const valueNow = element.getAttribute('aria-valuenow');
    const valueMin = element.getAttribute('aria-valuemin');
    const valueMax = element.getAttribute('aria-valuemax');

    const parts = [`<${tag}>`];
    if (role) parts.push(`role=${role}`);
    if (label) parts.push(`label="${label}"`);
    else if (title) parts.push(`title="${title}"`);
    else if (text) parts.push(`text="${text}"`);
    if (valueNow !== null) {
      parts.push(`value=${valueNow}${valueMin !== null && valueMax !== null ? ` [${valueMin}..${valueMax}]` : ''}`);
    }
    return parts.join(' | ');
  }

  function probePreviewUi() {
    const { root, controls } = getPreviewControls();

    if (!root) {
      setUiStatus('No Drive preview root detected. Open an audio preview first.');
      setStatus('Preview UI probe could not find an open Drive preview.');
      return [];
    }

    const descriptions = [...new Set(controls.map(describeControl))].slice(0, 18);
    renderUiResults(descriptions);

    const progress = getProgressState();
    if (progress) {
      setStatus(`Preview UI probe found ${controls.length} controls. Progress slider: ${Math.round(progress.ratio * 100)}%.`);
    } else {
      setStatus(`Preview UI probe found ${controls.length} controls, but no progress slider was identified.`);
    }

    log('Preview UI controls:', controls, descriptions);
    return controls;
  }

  async function handleTrackEnd() {
    if (!autoMode || advancing || currentIndex < 0) return;

    endArmed = false;
    const finished = playlist[currentIndex];
    setStatus(`End detected: ${finished?.name || `track ${currentIndex + 1}`}`);

    const nextIndex = currentIndex + 1;
    if (nextIndex >= playlist.length) {
      autoMode = false;
      setStatus(`Cached playlist finished (${playlist.length} track(s)). Repeat is not enabled in this prototype yet.`);
      renderPlaybackState('Playlist finished');
      return;
    }

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

    if (!endArmed && ratio < 0.95) {
      endArmed = true;
    }

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

  function setStatus(text) {
    const status = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (status) status.textContent = text;
  }

  function setUiStatus(text) {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="ui-status"]`);
    if (box) box.textContent = text;
  }

  function renderPlaybackState(detail = '') {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="playback-status"]`);
    if (!box) return;

    const name = currentIndex >= 0 && playlist[currentIndex]
      ? playlist[currentIndex].name
      : '—';
    const position = currentIndex >= 0 && playlist.length
      ? `${currentIndex + 1}/${playlist.length}`
      : '—';

    box.textContent = `Continuous: ${autoMode ? 'ON' : 'OFF'} | Track: ${position} | ${detail}\n${name}`;
  }

  function renderUiResults(descriptions = []) {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="ui-status"]`);
    if (!box) return;

    box.replaceChildren();

    const heading = document.createElement('div');
    heading.textContent = descriptions.length
      ? `Preview controls detected (${descriptions.length} shown):`
      : 'Preview detected, but no standard button/slider controls were found.';
    heading.style.fontWeight = '600';
    heading.style.marginBottom = '4px';
    box.appendChild(heading);

    for (const description of descriptions) {
      const line = document.createElement('div');
      line.textContent = description;
      line.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
      line.style.fontSize = '11px';
      line.style.marginTop = '2px';
      line.style.overflowWrap = 'anywhere';
      box.appendChild(line);
    }
  }

  function renderResults() {
    const count = document.querySelector(`#${PANEL_ID} [data-gdfp="count"]`);
    const list = document.querySelector(`#${PANEL_ID} [data-gdfp="list"]`);
    if (!count || !list) return;

    count.textContent = `${detectedItems.length} cached visible audio item(s)`;
    list.replaceChildren();

    if (!detectedItems.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No folder audio rows cached yet.';
      empty.style.opacity = '0.72';
      list.appendChild(empty);
      return;
    }

    for (const item of detectedItems.slice(0, 10)) {
      const row = document.createElement('div');
      row.textContent = item.name;
      row.title = item.name;
      row.style.whiteSpace = 'nowrap';
      row.style.overflow = 'hidden';
      row.style.textOverflow = 'ellipsis';
      list.appendChild(row);
    }

    if (detectedItems.length > 10) {
      const more = document.createElement('div');
      more.textContent = `… +${detectedItems.length - 10} more`;
      more.style.opacity = '0.72';
      list.appendChild(more);
    }
  }

  function createButton(label, onClick) {
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
    button.addEventListener('click', onClick);
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
      width: '390px',
      maxHeight: '76vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(32, 33, 36, .97)',
      color: '#f1f3f4',
      boxShadow: '0 8px 30px rgba(0,0,0,.32)',
      font: '13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Google Drive Folder Player — Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '8px';

    const status = document.createElement('div');
    status.dataset.gdfp = 'status';
    status.textContent = 'Ready. Close preview, scan the music folder, then start the continuous test.';
    status.style.marginBottom = '9px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '7px',
      flexWrap: 'wrap',
      marginBottom: '9px'
    });
    controls.append(
      createButton('Scan folder view', scanCurrentView),
      createButton('Start continuous test', startContinuousTest),
      createButton('Next now', nextNow),
      createButton('Stop', stopContinuousTest),
      createButton('Probe preview UI', probePreviewUi)
    );

    const playbackBox = document.createElement('div');
    playbackBox.dataset.gdfp = 'playback-status';
    playbackBox.textContent = 'Continuous: OFF | Track: —';
    Object.assign(playbackBox.style, {
      marginBottom: '9px',
      padding: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(129,201,149,.12)',
      border: '1px solid rgba(129,201,149,.28)',
      overflowWrap: 'anywhere'
    });

    const uiBox = document.createElement('div');
    uiBox.dataset.gdfp = 'ui-status';
    uiBox.textContent = 'Preview UI probe: optional diagnostic.';
    Object.assign(uiBox.style, {
      marginBottom: '9px',
      padding: '8px',
      borderRadius: '7px',
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
    Object.assign(list.style, {
      display: 'grid',
      gap: '2px',
      paddingTop: '2px'
    });

    const note = document.createElement('div');
    note.textContent = 'Probe 0.0.4 infers track end from Drive’s native progress slider and tries to open the next cached audio row automatically. Repeat and shuffle are not enabled yet.';
    Object.assign(note.style, {
      marginTop: '9px',
      paddingTop: '8px',
      borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.65',
      fontSize: '11px'
    });

    panel.append(title, status, controls, playbackBox, uiBox, count, list, note);
    document.body.appendChild(panel);
    log(`Probe ${VERSION} mounted.`, location.href);
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 100);
      return;
    }
    mountPanel();
  }

  init();
})();
