// ==UserScript==
// @name         Google Drive Folder Player - MP3 File-ID Direct Play Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Test whether a selected Google Drive MP3 can play directly from its stable file ID without opening Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-file-id-direct-play-probe';
  const MP3_RE = /([^\/\n\r]{1,320}\.mp3)(?=\s|$)/i;

  let selected = null;
  let testAudio = null;
  let currentMode = '';
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function log(text) {
    const line = `${stamp()}  ${text}`;
    logLines.push(line);
    logLines = logLines.slice(-60);
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
      if (!value || value.length > 1000) continue;
      const match = value.trim().match(MP3_RE);
      if (match) return match[1].trim();
    }
    return '';
  }

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element)) break;
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

  function candidateSelectedElements() {
    return [...document.querySelectorAll(
      '[aria-selected="true"], [data-is-selected="true"], [data-selected="true"]'
    )].filter(element => !element.closest(`#${PANEL_ID}`));
  }

  function captureSelectedRow() {
    const candidates = candidateSelectedElements();

    for (const element of candidates) {
      const root = findItemRoot(element);
      const name = extractName(root) || extractName(element);
      const id = getItemId(root);
      if (name && id) {
        selected = { name, id };
        renderSelected();
        log(`Captured selected MP3 row: ${name} | stable id present.`);
        return;
      }
    }

    selected = null;
    renderSelected();
    log('No selected MP3 row with a stable Drive ID was found. Single-click one MP3 in the file list, then try again.');
  }

  function renderSelected() {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-idprobe="selected"]`);
    if (!box) return;
    box.textContent = selected
      ? `Selected: ${selected.name}\nDrive ID: ${selected.id}`
      : 'Selected: none';
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
    return audio;
  }

  function requireSelected() {
    if (selected?.id) return true;
    log('Capture a selected MP3 row first.');
    return false;
  }

  function tryDriveUc() {
    if (!requireSelected()) return;
    const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(selected.id)}`;
    makeAudio(url, 'drive.google.com/uc');
  }

  function tryUsercontent() {
    if (!requireSelected()) return;
    const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(selected.id)}&export=download`;
    makeAudio(url, 'drive.usercontent');
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
      padding: '6px 9px',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mountPanel() {
    if (!document.body || document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '520px',
      maxHeight: '58vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '10px',
      borderRadius: '10px',
      background: 'rgba(25,27,30,.96)',
      color: '#f1f3f4',
      border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)',
      font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `MP3 File-ID Direct Play Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'No Preview required for the test. Single-click one MP3 row in Drive, capture it here, then try the two direct URL forms. The probe never logs query values.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const selectedBox = document.createElement('div');
    selectedBox.dataset.gdfpIdprobe = 'selected';
    selectedBox.textContent = 'Selected: none';
    Object.assign(selectedBox.style, {
      marginBottom: '8px',
      padding: '7px',
      borderRadius: '6px',
      background: 'rgba(129,201,149,.10)',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere'
    });

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '6px',
      flexWrap: 'wrap',
      marginBottom: '8px'
    });
    controls.append(
      makeButton('Capture selected MP3 row', captureSelectedRow),
      makeButton('Try drive.google.com/uc', tryDriveUc),
      makeButton('Try drive.usercontent', tryUsercontent),
      makeButton('Play loaded candidate', playLoaded),
      makeButton('Pause', pauseLoaded)
    );

    const logBox = document.createElement('div');
    logBox.dataset.gdfpIdprobe = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      padding: '8px',
      borderRadius: '6px',
      background: 'rgba(138,180,248,.10)',
      border: '1px solid rgba(138,180,248,.22)',
      minHeight: '90px'
    });

    panel.append(title, note, selectedBox, controls, logBox);
    document.body.appendChild(panel);
    log(`Probe ${VERSION} mounted.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mountPanel();
  }

  init();
})();