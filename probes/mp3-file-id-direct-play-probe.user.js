// ==UserScript==
// @name         Google Drive Folder Player - MP3 File-ID Direct Play Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.3
// @description  Test whether a clicked Google Drive MP3 can play directly from a captured stable file ID without opening Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.3';
  const PANEL_ID = 'gdfp-file-id-direct-play-probe';
  const MP3_RE = /([^\/\n\r]{1,320}\.mp3)(?=\s|$)/i;

  let clickedSnapshot = null;
  let selected = null;
  let testAudio = null;
  let currentMode = '';
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function log(text) {
    const line = `${stamp()}  ${text}`;
    logLines.push(line);
    logLines = logLines.slice(-70);
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-idprobe="log"]`);
    if (box) box.textContent = logLines.join('\n');
    console.log('[GDFP File-ID Probe]', text);
  }

  function sanitizeUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      const keys = [...new Set([...url.searchParams.keys()])];
      return `${url.origin}${url.pathname}${keys.length ? `?<keys:${keys.join(',')}>` : ''}`;
    } catch {
      return String(value || '(none)');
    }
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
        node.hasAttribute('data-docid') ||
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
      if (fileMatch) return fileMatch[1];
    } catch {
      const text = String(value);
      const fileMatch = text.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
      if (fileMatch) return fileMatch[1];
      const queryMatch = text.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
      if (queryMatch) return queryMatch[1];
    }
    return '';
  }

  function getItemId(root) {
    if (!(root instanceof Element)) return '';

    const attributeNames = [
      'data-id', 'data-target', 'data-file-id', 'data-docid', 'data-doc-id'
    ];
    const candidates = [
      root,
      ...root.querySelectorAll(
        '[data-id], [data-target], [data-file-id], [data-docid], [data-doc-id], a[href]'
      )
    ];

    for (const element of candidates) {
      for (const attr of attributeNames) {
        const value = element.getAttribute?.(attr) || '';
        if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
      }
      const hrefId = idFromHref(element.getAttribute?.('href') || '');
      if (hrefId) return hrefId;
    }
    return '';
  }

  function renderSelected() {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-idprobe="selected"]`);
    if (!box) return;
    box.textContent = selected
      ? `Selected: ${selected.name}\nDrive ID captured: yes`
      : clickedSnapshot
        ? `Clicked: ${clickedSnapshot.name}\nDrive ID captured: yes — press Capture`
        : 'Selected: none';
  }

  function rememberDriveClick(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(`#${PANEL_ID}`)) return;

    const root = findItemRoot(target);
    if (!root || root.closest?.(`#${PANEL_ID}`)) return;

    const name = extractName(root) || extractName(target);
    if (!name) return;

    const id = getItemId(root);
    if (!id) {
      log(`Clicked MP3 row detected but no stable ID was available yet: ${name}`);
      return;
    }

    // Important: snapshot the values immediately. Drive may replace the selected
    // row DOM node after the click because its file list is virtualized.
    clickedSnapshot = { name, id };
    renderSelected();
    log(`Remembered clicked MP3 row snapshot: ${name} | stable id captured.`);
  }

  function captureClickedRow() {
    if (!clickedSnapshot?.name || !clickedSnapshot?.id) {
      selected = null;
      renderSelected();
      log('No valid clicked MP3 snapshot is available. Single-click an MP3 filename row, then try again.');
      return;
    }

    selected = { ...clickedSnapshot };
    renderSelected();
    log(`Captured MP3 snapshot: ${selected.name} | stable id retained even if Drive replaced the row DOM.`);
  }

  function destroyAudio() {
    if (!testAudio) return;
    try {
      testAudio.pause();
      testAudio.removeAttribute('src');
      testAudio.load();
    } catch {
      // Probe cleanup only.
    }
    testAudio = null;
  }

  function makeAudio(url, mode) {
    destroyAudio();
    currentMode = mode;
    const audio = new Audio();
    testAudio = audio;
    audio.preload = 'auto';

    const events = [
      'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing',
      'waiting', 'stalled', 'suspend', 'ended', 'error'
    ];
    for (const name of events) {
      audio.addEventListener(name, () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : 'n/a';
        const time = Number.isFinite(audio.currentTime) ? audio.currentTime.toFixed(1) : 'n/a';
        const error = audio.error ? ` errorCode=${audio.error.code}` : '';
        log(`${mode} event ${name}: ready=${audio.readyState} network=${audio.networkState} paused=${audio.paused} t=${time}/${duration}${error}`);
      });
    }

    audio.src = url;
    audio.load();
    log(`${mode} load requested: ${sanitizeUrl(url)}`);
  }

  function requireSelected() {
    if (selected?.id) return true;
    log('Capture the clicked MP3 snapshot first.');
    return false;
  }

  function tryDriveUc() {
    if (!requireSelected()) return;
    makeAudio(
      `https://drive.google.com/uc?export=download&id=${encodeURIComponent(selected.id)}`,
      'drive.google.com/uc'
    );
  }

  function tryUsercontent() {
    if (!requireSelected()) return;
    makeAudio(
      `https://drive.usercontent.google.com/download?id=${encodeURIComponent(selected.id)}&export=download`,
      'drive.usercontent'
    );
  }

  async function playLoaded() {
    if (!testAudio) {
      log('No candidate is loaded yet.');
      return;
    }
    try {
      await testAudio.play();
      log(`${currentMode} play() resolved.`);
    } catch (error) {
      log(`${currentMode} play() rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
    }
  }

  function pauseLoaded() {
    if (!testAudio) return;
    testAudio.pause();
    log(`${currentMode} paused by probe.`);
  }

  function makeButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      padding: '6px 9px', borderRadius: '6px',
      border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)', color: 'inherit',
      cursor: 'pointer', font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mountPanel() {
    if (!document.body || document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647',
      width: '570px', maxHeight: '58vh', overflow: 'auto', boxSizing: 'border-box',
      padding: '10px', borderRadius: '10px', background: 'rgba(25,27,30,.96)',
      color: '#f1f3f4', border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)',
      font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `MP3 File-ID Direct Play Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'No Preview required. This version snapshots the MP3 filename + Drive ID at click time, so Drive DOM replacement after selection cannot erase the captured target.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const selectedBox = document.createElement('div');
    selectedBox.dataset.gdfpIdprobe = 'selected';
    selectedBox.textContent = 'Selected: none';
    Object.assign(selectedBox.style, {
      marginBottom: '8px', padding: '7px', borderRadius: '6px',
      background: 'rgba(129,201,149,.10)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
    });

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px'
    });
    controls.append(
      makeButton('Capture clicked MP3', captureClickedRow),
      makeButton('Try drive.google.com/uc', tryDriveUc),
      makeButton('Try drive.usercontent', tryUsercontent),
      makeButton('Play loaded candidate', playLoaded),
      makeButton('Pause', pauseLoaded)
    );

    const logBox = document.createElement('div');
    logBox.dataset.gdfpIdprobe = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px',
      borderRadius: '6px', background: 'rgba(138,180,248,.10)',
      border: '1px solid rgba(138,180,248,.22)', minHeight: '90px'
    });

    panel.append(title, note, selectedBox, controls, logBox);
    document.body.appendChild(panel);
    log(`Probe ${VERSION} mounted. Click-time snapshot tracking active.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    document.addEventListener('click', rememberDriveClick, true);
    mountPanel();
  }

  init();
})();