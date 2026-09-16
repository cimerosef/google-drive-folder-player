// ==UserScript==
// @name         Google Drive Folder Player - WebM Direct Play Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Test direct WebM playback from a Google Drive file ID without opening Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-webm-direct-play-probe';
  const WEBM_RE = /([^\/\n\r]{1,320}\.webm)(?=\s|$)/i;

  let lastClicked = null;
  let selected = null;
  let testMedia = null;
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-80);
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-webm="log"]`);
    if (box) box.textContent = logLines.join('\n');
    console.log('[GDFP WebM Direct Probe]', text);
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
      const match = value.trim().match(WEBM_RE);
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

  function rememberClick(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(`#${PANEL_ID}`)) return;
    const root = findItemRoot(target);
    if (!root) return;
    const name = extractName(root) || extractName(target);
    const id = getItemId(root);
    if (!name || !id) return;

    lastClicked = { name, id };
    renderSelection();
    log(`Remembered WebM snapshot: ${name} | stable id captured.`);
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

  function captureClicked() {
    if (!lastClicked) {
      log('No clicked WebM captured yet. Single-click a .webm row first.');
      return;
    }
    selected = { ...lastClicked };
    renderSelection();
    log(`Captured WebM: ${selected.name} | stable id retained.`);
  }

  function destroyMedia() {
    if (!testMedia) return;
    try {
      testMedia.pause();
      testMedia.removeAttribute('src');
      testMedia.load();
    } catch {}
    testMedia = null;
  }

  function bufferedText(media) {
    if (!media?.buffered?.length) return '(empty)';
    try {
      return `${media.buffered.start(0).toFixed(1)}-${media.buffered.end(media.buffered.length - 1).toFixed(1)}`;
    } catch {
      return '(unreadable)';
    }
  }

  function loadDirect() {
    if (!selected?.id) {
      log('Capture a clicked WebM first.');
      return;
    }

    destroyMedia();
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    testMedia = video;

    const events = [
      'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
      'playing', 'waiting', 'stalled', 'suspend', 'ended', 'error'
    ];

    for (const eventName of events) {
      video.addEventListener(eventName, () => {
        const duration = Number.isFinite(video.duration) ? video.duration.toFixed(1) : 'n/a';
        const time = Number.isFinite(video.currentTime) ? video.currentTime.toFixed(1) : 'n/a';
        const dimensions = `${video.videoWidth || 0}x${video.videoHeight || 0}`;
        const error = video.error ? ` errorCode=${video.error.code}` : '';
        log(`WEBM ${eventName}: ready=${video.readyState} net=${video.networkState} paused=${video.paused} t=${time}/${duration} buffered=${bufferedText(video)} video=${dimensions}${error}`);
      });
    }

    video.src = directUrl(selected);
    video.load();
    log(`Direct WebM load requested using authuser=${authuserIndex()}.`);
    log(`Browser canPlayType(video/webm)=${video.canPlayType('video/webm') || '(empty)'}.`);
  }

  async function playDirect() {
    if (!testMedia) {
      log('Load the direct WebM first.');
      return;
    }
    try {
      await testMedia.play();
      log('Direct WebM play() resolved.');
    } catch (error) {
      log(`Direct WebM play() rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
    }
  }

  function pauseDirect() {
    if (!testMedia) return;
    testMedia.pause();
    log('Direct WebM paused.');
  }

  function seekNearEnd() {
    if (!testMedia || !Number.isFinite(testMedia.duration) || testMedia.duration <= 6) {
      log('WebM metadata/duration is not ready yet.');
      return;
    }
    testMedia.currentTime = Math.max(0, testMedia.duration - 5);
    log(`WebM seeked to last ~5 seconds (${testMedia.currentTime.toFixed(1)}/${testMedia.duration.toFixed(1)}).`);
  }

  function renderSelection() {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-webm="selection"]`);
    if (!box) return;
    box.textContent = [
      `Last clicked: ${lastClicked?.name || '—'}`,
      `Selected: ${selected?.name || '—'}`,
      `Drive ID captured: ${selected?.id ? 'yes' : 'no'}`,
      `authuser=${authuserIndex()}`
    ].join('\n');
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
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', width: '650px',
      maxHeight: '70vh', overflow: 'auto', boxSizing: 'border-box', padding: '10px', borderRadius: '10px',
      background: 'rgba(25,27,30,.97)', color: '#f1f3f4', border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)', font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `WebM Direct Play Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'No Drive Preview. Single-click a .webm row, capture it, then load and play the same direct usercontent URL form already validated for MP3.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const selection = document.createElement('div');
    selection.dataset.gdfpWebm = 'selection';
    Object.assign(selection.style, {
      marginBottom: '8px', padding: '7px', borderRadius: '6px',
      background: 'rgba(129,201,149,.10)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
    });

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(
      makeButton('Capture clicked WebM', captureClicked),
      makeButton('Load direct WebM', loadDirect),
      makeButton('Play direct WebM', playDirect),
      makeButton('Seek to last 5s', seekNearEnd),
      makeButton('Pause', pauseDirect)
    );

    const logBox = document.createElement('div');
    logBox.dataset.gdfpWebm = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '6px',
      background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '140px'
    });

    panel.append(title, note, selection, controls, logBox);
    document.body.appendChild(panel);
    renderSelection();
    log(`Probe ${VERSION} mounted. Direct WebM test ready.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    document.addEventListener('click', rememberClick, true);
    mountPanel();
  }

  init();
})();
