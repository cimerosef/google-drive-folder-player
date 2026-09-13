// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.3
// @description  Probe Google Drive audio folders and inspect Drive's native preview controls without privileged APIs.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.3';
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

    // Google occasionally renders preview controls without role="dialog".
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
          ? `Scan found ${results.length} folder item(s) while Drive preview is open. You can close the preview or test again.`
          : 'Scan finished. If the filenames look correct, test opening the first audio file.'
      );
      return results;
    }

    renderResults();
    if (previewIsOpen()) {
      setStatus('Drive preview is open and no folder rows were found. Close the preview with Esc, then press Scan. The previous scan is kept.');
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
    const options = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', options));
    target.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  async function closePreviewIfNeeded() {
    if (!previewIsOpen()) return true;

    setStatus('A Drive preview is already open. Trying to close it before the test…');
    dispatchEscape();

    for (let i = 0; i < 8; i += 1) {
      await sleep(150);
      if (!previewIsOpen()) return true;
    }

    setStatus('Drive preview is still open. Close it manually with Esc or the × button, then press Scan and test again.');
    return false;
  }

  function findCurrentItemByName(name) {
    const lower = name.toLowerCase();
    if (detectedItems.length) {
      const live = detectedItems.find(item => item.name.toLowerCase() === lower && item.root?.isConnected && isVisible(item.root));
      if (live) return live;
    }

    scanCurrentView();
    return detectedItems.find(item => item.name.toLowerCase() === lower && item.root?.isConnected) || null;
  }

  async function testFirstAudio() {
    if (!detectedItems.length) scanCurrentView();

    const original = detectedItems[0];
    if (!original) {
      setStatus('No folder audio item is available. Close any preview, then press Scan first.');
      return;
    }

    if (!(await closePreviewIfNeeded())) return;

    const first = findCurrentItemByName(original.name) || detectedItems[0];
    if (!first?.root?.isConnected) {
      setStatus('The first scanned row is no longer available. Press Scan again, then retry.');
      return;
    }

    setStatus(`Opening with Drive preview: ${first.name}`);
    setUiStatus('Waiting for Drive preview controls…');
    log('Testing Drive open action for:', first.name, first.root);
    dispatchDoubleClick(first.root);

    await sleep(1200);
    if (previewIsOpen()) {
      setStatus('Drive preview opened. Now probe its native UI controls.');
      probePreviewUi();
    } else {
      setStatus('The double-click was sent, but a Drive preview was not detected. Try the test once more after a fresh Scan.');
      setUiStatus('Preview not detected yet.');
    }
  }

  function compactText(value, max = 72) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
    const valueText = compactText(element.getAttribute('aria-valuetext'));

    const parts = [`<${tag}>`];
    if (role) parts.push(`role=${role}`);
    if (label) parts.push(`label="${label}"`);
    else if (title) parts.push(`title="${title}"`);
    else if (text) parts.push(`text="${text}"`);
    if (valueNow !== null) parts.push(`value=${valueNow}${valueMin !== null && valueMax !== null ? ` [${valueMin}..${valueMax}]` : ''}`);
    if (valueText) parts.push(`valueText="${valueText}"`);
    return parts.join(' | ');
  }

  function probePreviewUi() {
    const roots = getPreviewRoots();
    const root = roots[0];

    if (!root) {
      setUiStatus('No Drive preview root detected. Open an audio preview first, then press “Probe preview UI”.');
      setStatus('Preview UI probe could not find an open Drive preview.');
      return [];
    }

    const selectors = [
      'button', '[role="button"]', '[role="slider"]', '[role="progressbar"]',
      'input[type="range"]', '[aria-valuenow]'
    ].join(', ');

    const controls = [...root.querySelectorAll(selectors)]
      .filter(element => isVisible(element) && !isInsideOurPanel(element));

    const descriptions = [...new Set(controls.map(describeControl))].slice(0, 18);

    // Also capture visible time-like labels (e.g. 0:00 / 3:42), which may be plain spans.
    const timeTexts = [...root.querySelectorAll('span, div')]
      .filter(element => isVisible(element) && !element.children.length)
      .map(element => compactText(element.textContent, 30))
      .filter(text => /^(?:\d{1,2}:)?\d{1,2}:\d{2}$|^\d{1,2}:\d{2}$/.test(text))
      .slice(0, 6);

    renderUiResults(descriptions, timeTexts);
    setStatus(`Preview UI probe found ${controls.length} visible control candidate(s).`);
    log('Preview UI controls:', controls, descriptions, 'time labels:', timeTexts);
    return controls;
  }

  function setStatus(text) {
    const status = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (status) status.textContent = text;
  }

  function setUiStatus(text) {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="ui-status"]`);
    if (box) box.textContent = text;
  }

  function renderUiResults(descriptions = [], timeTexts = []) {
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

    if (timeTexts.length) {
      const line = document.createElement('div');
      line.textContent = `Time text: ${[...new Set(timeTexts)].join(' · ')}`;
      line.style.marginTop = '5px';
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
      width: '370px',
      maxHeight: '72vh',
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
    status.textContent = 'Ready. Close any Drive preview, open a music folder, then press Scan.';
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
      createButton('Test first audio', testFirstAudio),
      createButton('Probe preview UI', probePreviewUi)
    );

    const uiBox = document.createElement('div');
    uiBox.dataset.gdfp = 'ui-status';
    uiBox.textContent = 'Preview UI probe: not run yet.';
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
    note.textContent = 'Probe 0.0.3 separates folder rows from the open preview and inspects Drive’s own visible controls. It still uses @grant none and no Google API.';
    Object.assign(note.style, {
      marginTop: '9px',
      paddingTop: '8px',
      borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.65',
      fontSize: '11px'
    });

    panel.append(title, status, controls, uiBox, count, list, note);
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
