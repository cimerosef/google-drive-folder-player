// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.2
// @description  Probe Google Drive audio folders, Drive preview playback, and end-of-track events.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.2';
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
  let activeMedia = null;
  const observedMedia = new WeakSet();

  function log(...args) {
    console.log('[GDFP Probe]', ...args);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
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

    for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element)) break;

      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (node.hasAttribute('data-id') || node.hasAttribute('data-target')) fallback = node;
    }

    return fallback;
  }

  function scanCurrentView() {
    const main = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    const candidates = main.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );

    const seenRoots = new Set();
    const seenKeys = new Set();
    const results = [];

    for (const element of candidates) {
      const name = extractAudioName(element);
      if (!name) continue;

      const root = findItemRoot(element);
      if (!isVisible(root)) continue;

      const rect = root.getBoundingClientRect();
      const key = `${name.toLowerCase()}::${Math.round(rect.top)}::${Math.round(rect.left)}`;
      if (seenRoots.has(root) || seenKeys.has(key)) continue;

      seenRoots.add(root);
      seenKeys.add(key);
      results.push({ name, root });
    }

    detectedItems = results;
    log(`Detected ${results.length} visible audio item(s).`, results.map(item => item.name));
    renderResults();
    return results;
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

  function collectMediaElements(doc = document, depth = 0) {
    const media = [...doc.querySelectorAll('audio, video')];
    if (depth >= 2) return media;

    for (const frame of doc.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) {
          media.push(...collectMediaElements(frame.contentDocument, depth + 1));
        }
      } catch {
        // Cross-origin frame; ignore it in the probe.
      }
    }

    return [...new Set(media)];
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '?';
    const rounded = Math.floor(seconds);
    const mins = Math.floor(rounded / 60);
    const secs = String(rounded % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function describeMedia(media) {
    if (!media) return 'No HTML audio/video element detected.';
    return `${media.tagName.toLowerCase()} | ${media.paused ? 'paused' : 'playing'} | ${formatTime(media.currentTime)} / ${formatTime(media.duration)} | ended=${media.ended}`;
  }

  function updateMediaStatus(prefix = '') {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="media-status"]`);
    if (!box) return;
    box.textContent = `${prefix}${prefix ? ' — ' : ''}${describeMedia(activeMedia)}`;

    const seek = document.querySelector(`#${PANEL_ID} [data-gdfp="seek-end"]`);
    if (seek) {
      seek.disabled = !(activeMedia && Number.isFinite(activeMedia.duration) && activeMedia.duration > 4);
      seek.style.opacity = seek.disabled ? '0.45' : '1';
    }
  }

  function attachMediaDiagnostics(media) {
    activeMedia = media;
    if (observedMedia.has(media)) {
      updateMediaStatus('Media detected');
      return;
    }

    observedMedia.add(media);
    log('Attaching media diagnostics:', media);

    const refresh = event => {
      activeMedia = media;
      updateMediaStatus(event.type);
      log(`Media event: ${event.type}`, {
        paused: media.paused,
        ended: media.ended,
        currentTime: media.currentTime,
        duration: media.duration,
        readyState: media.readyState
      });
    };

    for (const type of ['loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'error']) {
      media.addEventListener(type, refresh, true);
    }

    media.addEventListener('timeupdate', () => {
      if (activeMedia === media) updateMediaStatus('timeupdate');
    }, true);

    updateMediaStatus('Media detected');
  }

  async function probePlayer(timeoutMs = 8000) {
    setMediaStatus('Looking for Google Drive HTML audio/video element…');
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const media = collectMediaElements();
      if (media.length) {
        const candidate = media.find(el => !el.paused || el.currentTime > 0) || media[0];
        attachMediaDiagnostics(candidate);
        setStatus(`Player probe succeeded: ${media.length} HTML media element(s) detected.`);
        return candidate;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    activeMedia = null;
    setMediaStatus('No HTML audio/video element detected after 8 seconds. The Drive preview can still be controlled through another DOM/UI route.');
    setStatus('Drive preview may be open, but no directly accessible HTML media element was found.');
    return null;
  }

  async function testFirstAudio() {
    if (!detectedItems.length) scanCurrentView();

    const first = detectedItems[0];
    if (!first) {
      setStatus('No visible audio file detected. Scroll the Drive folder so audio files are visible, then press Scan.');
      return;
    }

    setStatus(`Opening: ${first.name}`);
    setMediaStatus('Waiting for Drive preview…');
    log('Testing Drive open action for:', first.name, first.root);
    dispatchDoubleClick(first.root);

    await new Promise(resolve => setTimeout(resolve, 500));
    await probePlayer(8000);
  }

  function seekNearEnd() {
    if (!activeMedia || !Number.isFinite(activeMedia.duration) || activeMedia.duration <= 4) {
      setMediaStatus('Cannot seek: no media with a known duration is currently available.');
      return;
    }

    const target = Math.max(0, activeMedia.duration - 3);
    activeMedia.currentTime = target;
    activeMedia.play().catch(error => log('play() after seek was rejected:', error));
    updateMediaStatus('Seeked to final 3 seconds');
    setStatus('End-event test armed. Wait a few seconds and watch the player probe line for “ended”.');
  }

  function setStatus(text) {
    const status = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (status) status.textContent = text;
  }

  function setMediaStatus(text) {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="media-status"]`);
    if (box) box.textContent = text;
  }

  function renderResults() {
    const count = document.querySelector(`#${PANEL_ID} [data-gdfp="count"]`);
    const list = document.querySelector(`#${PANEL_ID} [data-gdfp="list"]`);
    if (!count || !list) return;

    count.textContent = `${detectedItems.length} visible audio item(s)`;
    list.replaceChildren();

    if (!detectedItems.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No audio filename detected in the currently rendered Drive items.';
      empty.style.opacity = '0.72';
      list.appendChild(empty);
      setStatus('Scan finished. No visible audio file detected.');
      return;
    }

    for (const item of detectedItems.slice(0, 12)) {
      const row = document.createElement('div');
      row.textContent = item.name;
      row.title = item.name;
      row.style.whiteSpace = 'nowrap';
      row.style.overflow = 'hidden';
      row.style.textOverflow = 'ellipsis';
      list.appendChild(row);
    }

    if (detectedItems.length > 12) {
      const more = document.createElement('div');
      more.textContent = `… +${detectedItems.length - 12} more`;
      more.style.opacity = '0.72';
      list.appendChild(more);
    }

    setStatus('Scan finished. If the filenames look correct, test opening the first audio file.');
  }

  function createButton(label, onClick, dataKey = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (dataKey) button.dataset.gdfp = dataKey;
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
      width: '340px',
      maxHeight: '62vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(32, 33, 36, .96)',
      color: '#f1f3f4',
      boxShadow: '0 8px 30px rgba(0,0,0,.32)',
      font: '13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      position: 'sticky',
      top: '-12px',
      zIndex: '2',
      margin: '-12px -12px 9px',
      padding: '12px',
      background: 'rgba(32, 33, 36, .985)',
      borderBottom: '1px solid rgba(255,255,255,.12)'
    });

    const title = document.createElement('div');
    title.textContent = `Google Drive Folder Player — Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '8px';

    const status = document.createElement('div');
    status.dataset.gdfp = 'status';
    status.textContent = 'Ready. Open a Google Drive folder containing audio files, then press Scan.';
    status.style.marginBottom = '9px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '7px',
      flexWrap: 'wrap'
    });

    const seekButton = createButton('Skip to last 3s', seekNearEnd, 'seek-end');
    seekButton.disabled = true;
    seekButton.style.opacity = '0.45';

    controls.append(
      createButton('Scan', scanCurrentView),
      createButton('Test first audio', testFirstAudio),
      createButton('Probe player', () => probePlayer(8000)),
      seekButton
    );

    header.append(title, status, controls);

    const mediaBox = document.createElement('div');
    mediaBox.dataset.gdfp = 'media-status';
    mediaBox.textContent = 'Player probe: not run yet.';
    Object.assign(mediaBox.style, {
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
    note.textContent = 'Probe only: folder scanning currently sees rendered Drive items. Version 0.0.2 also tests whether Drive exposes a controllable HTML media element and a native ended event.';
    Object.assign(note.style, {
      marginTop: '9px',
      paddingTop: '8px',
      borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.65',
      fontSize: '11px'
    });

    panel.append(header, mediaBox, count, list, note);
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
