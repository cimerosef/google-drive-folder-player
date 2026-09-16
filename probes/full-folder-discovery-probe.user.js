// ==UserScript==
// @name         Google Drive Folder Player - Full Folder Discovery Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Traverse Google Drive's virtualized file list, accumulating MP3/WebM file IDs beyond the currently rendered rows.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-full-folder-discovery-probe';
  const MEDIA_RE = /([^\/\n\r]{1,320}\.(?:mp3|webm))(?=\s|$)/i;
  const STEP_SETTLE_MS = 360;
  const BOTTOM_SETTLE_MS = 650;
  const MAX_STEPS = 240;

  let discovered = new Map();
  let running = false;
  let stopRequested = false;
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-120);
    const node = document.querySelector(`#${PANEL_ID} [data-ff="log"]`);
    if (node) node.textContent = logLines.join('\n');
    console.log('[GDFP Full Folder Discovery]', text);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function extensionOf(name) {
    return String(name || '').toLowerCase().endsWith('.webm') ? 'webm' : 'mp3';
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
      const match = value.trim().match(MEDIA_RE);
      if (match) return match[1].trim();
    }
    return '';
  }

  function isInsidePanel(element) {
    return Boolean(element?.closest?.(`#${PANEL_ID}`));
  }

  function isRendered(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element) || isInsidePanel(node)) break;
      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (
        node.hasAttribute('data-id') || node.hasAttribute('data-target') ||
        node.hasAttribute('data-file-id') || node.hasAttribute('data-docid') ||
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
      return fileMatch?.[1] || '';
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

  function collectRenderedMediaRows() {
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );
    const seenRoots = new Set();
    const rows = [];

    for (const element of candidates) {
      if (!(element instanceof Element) || isInsidePanel(element)) continue;
      const name = extractName(element);
      if (!name) continue;
      const root = findItemRoot(element);
      if (!root || !isRendered(root) || seenRoots.has(root)) continue;
      const id = getItemId(root);
      if (!id) continue;
      seenRoots.add(root);
      rows.push({
        name,
        id,
        type: extensionOf(name),
        root,
        top: root.getBoundingClientRect().top
      });
    }

    rows.sort((a, b) => a.top - b.top);
    return rows;
  }

  function addRenderedRows() {
    const rows = collectRenderedMediaRows();
    let added = 0;
    for (const row of rows) {
      if (discovered.has(row.id)) continue;
      discovered.set(row.id, {
        id: row.id,
        name: row.name,
        type: row.type,
        order: discovered.size
      });
      added += 1;
    }
    render();
    return { rows, added };
  }

  function looksScrollable(element) {
    if (!(element instanceof Element) || isInsidePanel(element)) return false;
    const style = getComputedStyle(element);
    const overflowY = style.overflowY;
    if (!['auto', 'scroll', 'overlay'].includes(overflowY)) return false;
    return element.scrollHeight > element.clientHeight + 80 && element.clientHeight > 180;
  }

  function scrollableAncestors(element) {
    const result = [];
    let node = element?.parentElement;
    for (let depth = 0; node && depth < 18; depth += 1, node = node.parentElement) {
      if (looksScrollable(node)) result.push(node);
    }
    return result;
  }

  function findScrollContainer() {
    const rendered = collectRenderedMediaRows();
    const row = rendered[Math.floor(rendered.length / 2)]?.root || rendered[0]?.root;
    if (row) {
      const ancestors = scrollableAncestors(row);
      if (ancestors.length) {
        ancestors.sort((a, b) => {
          const aRange = a.scrollHeight - a.clientHeight;
          const bRange = b.scrollHeight - b.clientHeight;
          return bRange - aRange;
        });
        return ancestors[0];
      }
    }

    const all = [...document.querySelectorAll('div, main, section')]
      .filter(looksScrollable)
      .map(element => ({
        element,
        range: element.scrollHeight - element.clientHeight,
        area: element.clientWidth * element.clientHeight
      }))
      .filter(item => item.area > 100000)
      .sort((a, b) => b.range - a.range || b.area - a.area);

    return all[0]?.element || null;
  }

  function describeScroller(scroller) {
    if (!scroller) return '(none)';
    const role = scroller.getAttribute('role') || '';
    const aria = scroller.getAttribute('aria-label') || '';
    return `${scroller.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${aria ? ` aria="${aria.slice(0, 60)}"` : ''} top=${Math.round(scroller.scrollTop)} client=${scroller.clientHeight} scroll=${scroller.scrollHeight}`;
  }

  function scrollToPosition(scroller, top) {
    scroller.scrollTo({ top, behavior: 'auto' });
  }

  async function discoverFullFolder() {
    if (running) return;
    running = true;
    stopRequested = false;
    discovered = new Map();
    render();

    const initial = addRenderedRows();
    const scroller = findScrollContainer();
    if (!scroller) {
      log(`Could not identify the Drive list scroll container. Initial rendered media count=${initial.rows.length}.`);
      running = false;
      render();
      return;
    }

    const originalTop = scroller.scrollTop;
    const originalLeft = scroller.scrollLeft;
    log(`Discovery started. Initial rendered=${initial.rows.length}; unique=${discovered.size}.`);
    log(`Scroller: ${describeScroller(scroller)}.`);

    scrollToPosition(scroller, 0);
    await sleep(BOTTOM_SETTLE_MS);
    let topSample = addRenderedRows();
    log(`Top pass: rendered=${topSample.rows.length}, +${topSample.added}, unique=${discovered.size}.`);

    let lastTop = scroller.scrollTop;
    let noMovementRounds = 0;
    let noNewRounds = 0;
    let steps = 0;

    while (!stopRequested && steps < MAX_STEPS) {
      steps += 1;
      const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const stepSize = Math.max(260, Math.floor(scroller.clientHeight * 0.72));
      const target = Math.min(range, scroller.scrollTop + stepSize);
      scrollToPosition(scroller, target);
      await sleep(STEP_SETTLE_MS);

      const sample = addRenderedRows();
      const currentTop = scroller.scrollTop;
      const currentRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atBottom = currentRange - currentTop <= 8;

      if (Math.abs(currentTop - lastTop) < 2) noMovementRounds += 1;
      else noMovementRounds = 0;
      if (sample.added === 0) noNewRounds += 1;
      else noNewRounds = 0;

      log(`Step ${steps}: top=${Math.round(currentTop)}/${Math.round(currentRange)}, rendered=${sample.rows.length}, +${sample.added}, unique=${discovered.size}${atBottom ? ' · bottom' : ''}.`);
      lastTop = currentTop;

      if (atBottom) {
        await sleep(BOTTOM_SETTLE_MS);
        const finalSample = addRenderedRows();
        const finalRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const stillBottom = finalRange - scroller.scrollTop <= 8;
        log(`Bottom settle: rendered=${finalSample.rows.length}, +${finalSample.added}, unique=${discovered.size}, stillBottom=${stillBottom}.`);
        if (stillBottom && finalSample.added === 0) break;
      }

      if (noMovementRounds >= 4 && noNewRounds >= 4) {
        log('Stopping because the scroll position and discovered set stayed unchanged for four rounds.');
        break;
      }
    }

    const mp3 = [...discovered.values()].filter(item => item.type === 'mp3').length;
    const webm = [...discovered.values()].filter(item => item.type === 'webm').length;
    const stoppedText = stopRequested ? 'stopped by user' : 'completed';
    log(`Discovery ${stoppedText}: ${discovered.size} unique media file(s): ${mp3} MP3, ${webm} WebM; steps=${steps}.`);

    scrollToPosition(scroller, Math.min(originalTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
    scroller.scrollLeft = originalLeft;
    await sleep(250);
    log(`Returned list near original scroll position (${Math.round(scroller.scrollTop)}).`);

    running = false;
    stopRequested = false;
    render();
  }

  function stopDiscovery() {
    if (!running) return;
    stopRequested = true;
    log('Stop requested; discovery will exit after the current scroll sample.');
  }

  function clearResults() {
    if (running) return;
    discovered = new Map();
    logLines = [];
    render();
  }

  function copyReport() {
    const items = [...discovered.values()];
    const mp3 = items.filter(item => item.type === 'mp3').length;
    const webm = items.filter(item => item.type === 'webm').length;
    const report = [
      `Full Folder Discovery Probe ${VERSION}`,
      `Discovered: ${items.length} total; ${mp3} MP3; ${webm} WebM`,
      '',
      ...items.map((item, index) => `${index + 1}. [${item.type.toUpperCase()}] ${item.name} | ${item.id}`)
    ].join('\n');
    navigator.clipboard?.writeText(report).then(
      () => log('Report copied to clipboard.'),
      () => log('Clipboard write failed; use the on-screen summary/log instead.')
    );
  }

  function render() {
    const status = document.querySelector(`#${PANEL_ID} [data-ff="status"]`);
    const list = document.querySelector(`#${PANEL_ID} [data-ff="list"]`);
    if (!status || !list) return;

    const items = [...discovered.values()];
    const mp3 = items.filter(item => item.type === 'mp3').length;
    const webm = items.filter(item => item.type === 'webm').length;
    status.textContent = `${running ? 'DISCOVERING' : 'IDLE'} | ${items.length} unique media file(s) | ${mp3} MP3 | ${webm} WebM`;

    const head = items.slice(0, 6);
    const tail = items.length > 10 ? items.slice(-4) : [];
    const lines = [];
    for (const [index, item] of head.entries()) lines.push(`${index + 1}. [${item.type.toUpperCase()}] ${item.name}`);
    if (tail.length) {
      lines.push(`… ${items.length - head.length - tail.length} omitted …`);
      for (const [offset, item] of tail.entries()) lines.push(`${items.length - tail.length + offset + 1}. [${item.type.toUpperCase()}] ${item.name}`);
    } else {
      for (const [index, item] of items.slice(head.length).entries()) lines.push(`${head.length + index + 1}. [${item.type.toUpperCase()}] ${item.name}`);
    }
    list.textContent = lines.length ? lines.join('\n') : 'No files discovered yet.';
  }

  function button(label, handler) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    Object.assign(node.style, {
      padding: '6px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)', color: 'inherit', cursor: 'pointer', font: 'inherit'
    });
    node.addEventListener('click', handler);
    return node;
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', width: '650px',
      maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', padding: '10px', borderRadius: '10px',
      background: 'rgba(25,27,30,.97)', color: '#f1f3f4', border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)', font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Full Folder Discovery Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'Diagnostic only. It scrolls the current Drive folder list from top to bottom and accumulates stable IDs from virtualized MP3/WebM rows, then returns near the original scroll position. It does not play media or modify files.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(
      button('Discover full folder', () => void discoverFullFolder()),
      button('Stop', stopDiscovery),
      button('Clear', clearResults),
      button('Copy report', copyReport)
    );

    const status = document.createElement('div');
    status.dataset.ff = 'status';
    Object.assign(status.style, {
      marginBottom: '8px', padding: '7px', borderRadius: '6px', whiteSpace: 'pre-wrap',
      background: 'rgba(129,201,149,.10)', border: '1px solid rgba(129,201,149,.20)'
    });

    const list = document.createElement('div');
    list.dataset.ff = 'list';
    Object.assign(list.style, {
      marginBottom: '8px', padding: '7px', borderRadius: '6px', whiteSpace: 'pre-wrap',
      background: 'rgba(251,188,4,.08)', border: '1px solid rgba(251,188,4,.20)', maxHeight: '180px', overflow: 'auto'
    });

    const logBox = document.createElement('div');
    logBox.dataset.ff = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '6px',
      background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '180px'
    });

    panel.append(title, note, controls, status, list, logBox);
    document.body.appendChild(panel);
    render();
    log(`Probe ${VERSION} mounted.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mount();
  }

  init();
})();
