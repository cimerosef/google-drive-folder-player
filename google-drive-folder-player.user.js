// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Probe Google Drive's current folder for audio files and test opening one with Drive's own preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
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
    if (depth >= 1) return media;

    for (const frame of doc.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) {
          media.push(...collectMediaElements(frame.contentDocument, depth + 1));
        }
      } catch {
        // Cross-origin frame; ignore it in the probe.
      }
    }

    return media;
  }

  async function testFirstAudio() {
    if (!detectedItems.length) scanCurrentView();

    const first = detectedItems[0];
    if (!first) {
      setStatus('No visible audio file detected. Scroll the Drive folder so audio files are visible, then press Scan.');
      return;
    }

    setStatus(`Opening: ${first.name}`);
    log('Testing Drive open action for:', first.name, first.root);
    dispatchDoubleClick(first.root);

    await new Promise(resolve => setTimeout(resolve, 1800));
    const media = collectMediaElements();

    if (media.length) {
      const summary = media.map(el => ({
        tag: el.tagName,
        paused: el.paused,
        ended: el.ended,
        duration: Number.isFinite(el.duration) ? el.duration : null,
        currentTime: el.currentTime
      }));
      log('Media element(s) detected after open:', summary);
      setStatus(`Drive preview opened; ${media.length} HTML media element(s) detected. This is a strong positive result.`);
    } else {
      setStatus('Open action sent. Check whether Drive preview opened. No top-level HTML audio/video element was detected yet.');
    }
  }

  function setStatus(text) {
    const status = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (status) status.textContent = text;
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
      width: '320px',
      maxHeight: '55vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(32, 33, 36, .96)',
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
    status.textContent = 'Ready. Open a Google Drive folder containing audio files, then press Scan.';
    status.style.marginBottom = '9px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '7px',
      flexWrap: 'wrap',
      marginBottom: '9px'
    });
    controls.append(
      createButton('Scan', scanCurrentView),
      createButton('Test first audio', testFirstAudio)
    );

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
    note.textContent = 'Probe only: it currently sees items rendered in the Drive page, not the entire virtualized folder.';
    Object.assign(note.style, {
      marginTop: '9px',
      paddingTop: '8px',
      borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.65',
      fontSize: '11px'
    });

    panel.append(title, status, controls, count, list, note);
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
