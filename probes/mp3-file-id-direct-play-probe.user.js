// ==UserScript==
// @name         Google Drive Folder Player - MP3 File-ID Direct Play Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.4
// @description  Test Google Drive MP3 direct-play URL variants from a clicked file ID without opening Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.4';
  const PANEL_ID = 'gdfp-file-id-direct-play-probe';
  const MP3_RE = /([^\/\n\r]{1,320}\.mp3)(?=\s|$)/i;

  let captured = null;
  let lastClicked = null;
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
    logLines = logLines.slice(-80);
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
      if (!(node instanceof Element) || node.closest?.(`#${PANEL_ID}`)) break;
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
    const attributeNames = ['data-id', 'data-target', 'data-file-id', 'data-docid', 'data-doc-id'];
    const candidates = [
      root,
      ...root.querySelectorAll('[data-id], [data-target], [data-file-id], [data-docid], [data-doc-id], a[href]')
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

  function rememberDriveClick(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(`#${PANEL_ID}`)) return;

    const root = findItemRoot(target);
    if (!root) return;
    const name = extractName(root) || extractName(target);
    if (!name) return;

    const id = getItemId(root);
    lastClicked = { name, id };
    renderSelected(lastClicked);
    log(`Remembered clicked MP3 snapshot: ${name}${id ? ' | stable id captured.' : ' | no stable id found.'}`);
  }

  function captureClicked() {
    if (!lastClicked?.name || !lastClicked?.id) {
      log('No clicked MP3 with a stable Drive ID is available. Click an MP3 filename row first.');
      return;
    }
    captured = { ...lastClicked };
    renderSelected(captured);
    log(`Captured MP3: ${captured.name} | stable id retained.`);
  }

  function renderSelected(item = captured || lastClicked) {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-idprobe="selected"]`);
    if (!box) return;
    box.textContent = item
      ? `Selected: ${item.name}\nDrive ID captured: ${item.id ? 'yes' : 'no'}`
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

    for (const eventName of events) {
      audio.addEventListener(eventName, () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : 'n/a';
        const time = Number.isFinite(audio.currentTime) ? audio.currentTime.toFixed(1) : 'n/a';
        const error = audio.error ? ` errorCode=${audio.error.code}` : '';
        log(`${mode} event ${eventName}: ready=${audio.readyState} network=${audio.networkState} paused=${audio.paused} t=${time}/${duration}${error}`);
      });
    }

    audio.src = url;
    audio.load();
    log(`${mode} load requested: ${sanitizeUrl(url)}`);
  }

  function requireCaptured() {
    if (captured?.id) return true;
    if (lastClicked?.id) {
      captured = { ...lastClicked };
      renderSelected(captured);
      log('Auto-captured the last clicked MP3 snapshot.');
      return true;
    }
    log('Click and capture an MP3 row first.');
    return false;
  }

  function currentAuthUser() {
    const match = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
    return match ? match[1] : '0';
  }

  function tryPlainUsercontent() {
    if (!requireCaptured()) return;
    const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(captured.id)}&export=download`;
    makeAudio(url, 'usercontent plain');
  }

  function tryConfirm() {
    if (!requireCaptured()) return;
    const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(captured.id)}&export=download&confirm=t`;
    makeAudio(url, 'usercontent confirm=t');
  }

  function tryConfirmAuthuser() {
    if (!requireCaptured()) return;
    const authuser = currentAuthUser();
    const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(captured.id)}&export=download&confirm=t&authuser=${encodeURIComponent(authuser)}`;
    makeAudio(url, `usercontent confirm=t authuser=${authuser}`);
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
      width: '660px', maxHeight: '62vh', overflow: 'auto', boxSizing: 'border-box',
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
    note.textContent = 'No Preview required. 0.0.4 tests whether Drive usercontent becomes playable when confirm=t and the active Drive authuser index are added. Query values are never logged.';
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
      makeButton('Capture clicked MP3', captureClicked),
      makeButton('Try usercontent plain', tryPlainUsercontent),
      makeButton('Try confirm=t', tryConfirm),
      makeButton('Try confirm=t + authuser', tryConfirmAuthuser),
      makeButton('Play loaded candidate', playLoaded),
      makeButton('Pause', pauseLoaded)
    );

    const logBox = document.createElement('div');
    logBox.dataset.gdfpIdprobe = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px',
      borderRadius: '6px', background: 'rgba(138,180,248,.10)',
      border: '1px solid rgba(138,180,248,.22)', minHeight: '100px'
    });

    panel.append(title, note, selectedBox, controls, logBox);
    document.body.appendChild(panel);
    renderSelected();
    log(`Probe ${VERSION} mounted. Click-time snapshot tracking active.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    document.addEventListener('click', rememberDriveClick, true);
    mountPanel();
  }

  init();
})();