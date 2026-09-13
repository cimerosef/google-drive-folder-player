// ==UserScript==
// @name         GDFP — Full Folder Discovery Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Traverses Google Drive's virtualized folder list to estimate and verify complete media discovery without using the Drive API.
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
  const MEDIA_EXTENSIONS = [
    'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma',
    'webm', 'aiff', 'aif', 'm4b', 'mp4'
  ];
  const MEDIA_RE = new RegExp(
    `([^\\/\\n\\r]{1,320}\\.(?:${MEDIA_EXTENSIONS.join('|')}))(?=\\s|$)`,
    'i'
  );

  const MAX_PASSES = 500;
  const BOTTOM_STABLE_PASSES_REQUIRED = 5;
  const PASS_DELAY_MS = 260;
  const BOTTOM_DELAY_MS = 520;

  let running = false;
  let stopRequested = false;
  let firstSnapshot = null;
  let latestSnapshot = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log('[GDFP Full Folder Probe]', ...args);

  function isInsidePanel(element) {
    return Boolean(element?.closest?.(`#${PANEL_ID}`));
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0;
  }

  function normalizeName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

  function findItemRoot(element) {
    let node = element;
    let fallback = element;

    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element) || isInsidePanel(node)) break;
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
    return child?.getAttribute('data-id') ||
      child?.getAttribute('data-target') ||
      '';
  }

  function collectCurrentMediaRows() {
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );

    const seenRoots = new Set();
    const rows = [];

    for (const element of candidates) {
      if (isInsidePanel(element)) continue;
      const name = extractMediaName(element);
      if (!name) continue;

      const root = findItemRoot(element);
      if (!root || !isVisible(root) || seenRoots.has(root)) continue;

      seenRoots.add(root);
      const id = getItemId(root);
      rows.push({
        name,
        id,
        root,
        key: id ? `id:${id}` : `name:${normalizeName(name)}`
      });
    }

    return rows;
  }

  function nearestVerticalScroller(element) {
    let node = element?.parentElement;

    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const overflowY = style.overflowY || '';
      const hasRange = node.scrollHeight > node.clientHeight + 40;
      const canScroll = /(auto|scroll|overlay)/i.test(overflowY);

      if (hasRange && canScroll && node.clientHeight >= 140) return node;
      node = node.parentElement;
    }

    const fallback = document.scrollingElement;
    return fallback instanceof Element ? fallback : null;
  }

  function findFolderScroller(rows) {
    const votes = new Map();

    for (const row of rows) {
      const scroller = nearestVerticalScroller(row.root);
      if (!scroller) continue;
      votes.set(scroller, (votes.get(scroller) || 0) + 1);
    }

    if (!votes.size) return null;

    return [...votes.entries()]
      .sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        const ar = a[0].getBoundingClientRect();
        const br = b[0].getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0][0];
  }

  function mergeRows(store, rows) {
    let added = 0;

    for (const row of rows) {
      if (!store.has(row.key)) {
        added += 1;
        store.set(row.key, {
          key: row.key,
          id: row.id,
          name: row.name
        });
      }
    }

    return added;
  }

  function setStatus(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (node) node.textContent = text;
  }

  function setProgress(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="progress"]`);
    if (node) node.textContent = text;
  }

  function setResult(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="result"]`);
    if (node) node.textContent = text;
  }

  function updateButtons() {
    const scan = document.querySelector(`#${PANEL_ID} [data-gdfp="scan"]`);
    const verify = document.querySelector(`#${PANEL_ID} [data-gdfp="verify"]`);
    const stop = document.querySelector(`#${PANEL_ID} [data-gdfp="stop"]`);

    if (scan) scan.disabled = running;
    if (verify) verify.disabled = running || !firstSnapshot;
    if (stop) stop.disabled = !running;
  }

  function describeScroller(scroller) {
    if (!scroller) return '(none)';
    if (scroller === document.scrollingElement) return 'document.scrollingElement';

    const role = scroller.getAttribute('role');
    const cls = String(scroller.className || '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join('.');

    return `${scroller.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${cls ? `.${cls}` : ''}`;
  }

  function makeSnapshot(store, meta) {
    const keys = [...store.keys()].sort();
    const stableIdCount = [...store.values()].filter(item => item.id).length;

    return {
      keys,
      keySet: new Set(keys),
      items: [...store.values()].sort((a, b) => a.name.localeCompare(b.name)),
      count: store.size,
      stableIdCount,
      fallbackCount: store.size - stableIdCount,
      ...meta
    };
  }

  function compareSnapshots(a, b) {
    const onlyA = a.keys.filter(key => !b.keySet.has(key));
    const onlyB = b.keys.filter(key => !a.keySet.has(key));

    return {
      exact: onlyA.length === 0 && onlyB.length === 0,
      onlyA,
      onlyB
    };
  }

  function renderSnapshot(snapshot, label, comparison = null) {
    const lines = [
      `${label}`,
      `Unique media discovered: ${snapshot.count}`,
      `Stable Drive IDs: ${snapshot.stableIdCount}`,
      `Fallback-name keys: ${snapshot.fallbackCount}`,
      `Scroll passes: ${snapshot.passes}`,
      `Bottom reached: ${snapshot.bottomReached ? 'YES' : 'NO'}`,
      `Stable bottom passes: ${snapshot.bottomStablePasses}/${BOTTOM_STABLE_PASSES_REQUIRED}`,
      `Final scrollHeight: ${Math.round(snapshot.finalScrollHeight)} px`,
      `Scroller: ${snapshot.scrollerDescription}`,
      `Result: ${snapshot.converged ? 'DISCOVERY CONVERGED' : snapshot.stopped ? 'STOPPED' : 'NOT CONVERGED'}`
    ];

    if (comparison) {
      lines.push('');
      lines.push(`Verification vs first scan: ${comparison.exact ? 'EXACT MATCH' : 'DIFFERENT'}`);
      lines.push(`Missing from verification: ${comparison.onlyA.length}`);
      lines.push(`New only in verification: ${comparison.onlyB.length}`);
      if (comparison.onlyA.length) lines.push(`Example missing key: ${comparison.onlyA[0]}`);
      if (comparison.onlyB.length) lines.push(`Example new key: ${comparison.onlyB[0]}`);
    }

    setResult(lines.join('\n'));
  }

  async function runDiscovery(kind) {
    if (running) return;

    running = true;
    stopRequested = false;
    updateButtons();
    setResult('');
    setStatus(kind === 'verify' ? 'Starting verification scan…' : 'Starting full-folder scan…');

    const initialRows = collectCurrentMediaRows();
    if (!initialRows.length) {
      setStatus('No visible media rows found. Open the folder in list view and close any file preview, then retry.');
      running = false;
      updateButtons();
      return;
    }

    const scroller = findFolderScroller(initialRows);
    if (!scroller) {
      setStatus('Could not identify the Drive folder scroll container.');
      running = false;
      updateButtons();
      return;
    }

    const originalScrollTop = scroller.scrollTop;
    const originalScrollBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = 'auto';

    const discovered = new Map();
    let passes = 0;
    let bottomStablePasses = 0;
    let lastScrollHeight = -1;
    let bottomReached = false;
    let converged = false;

    try {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(450);

      for (passes = 1; passes <= MAX_PASSES; passes += 1) {
        if (stopRequested) break;

        const rows = collectCurrentMediaRows();
        const added = mergeRows(discovered, rows);

        const top = scroller.scrollTop;
        const client = scroller.clientHeight;
        const height = scroller.scrollHeight;
        const atBottom = top + client >= height - 6;
        bottomReached = bottomReached || atBottom;

        const heightStable = lastScrollHeight >= 0 && Math.abs(height - lastScrollHeight) <= 2;
        if (atBottom && added === 0 && heightStable) {
          bottomStablePasses += 1;
        } else {
          bottomStablePasses = 0;
        }

        const idCount = [...discovered.values()].filter(item => item.id).length;
        setProgress(
          `Pass ${passes} · unique ${discovered.size} · +${added}\n` +
          `IDs ${idCount}/${discovered.size} · scroll ${Math.round(top)}/${Math.max(0, Math.round(height - client))}\n` +
          `bottom=${atBottom ? 'yes' : 'no'} · stable=${bottomStablePasses}/${BOTTOM_STABLE_PASSES_REQUIRED}`
        );

        if (atBottom && bottomStablePasses >= BOTTOM_STABLE_PASSES_REQUIRED) {
          converged = true;
          break;
        }

        lastScrollHeight = height;

        if (atBottom) {
          scroller.scrollTop = scroller.scrollHeight;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await sleep(BOTTOM_DELAY_MS);
        } else {
          const step = Math.max(320, Math.floor(client * 0.62));
          const nextTop = Math.min(height - client, top + step);
          scroller.scrollTop = nextTop;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await sleep(PASS_DELAY_MS);
        }
      }
    } finally {
      scroller.scrollTop = originalScrollTop;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      scroller.style.scrollBehavior = originalScrollBehavior;
      await sleep(120);
    }

    const snapshot = makeSnapshot(discovered, {
      passes: Math.min(passes, MAX_PASSES),
      bottomReached,
      bottomStablePasses,
      finalScrollHeight: scroller.scrollHeight,
      scrollerDescription: describeScroller(scroller),
      converged,
      stopped: stopRequested
    });

    latestSnapshot = snapshot;

    if (kind === 'first') {
      firstSnapshot = snapshot;
      renderSnapshot(snapshot, 'FIRST SCAN');
      setStatus(
        converged
          ? 'First scan converged. Run “Verify scan again” for an independent second pass.'
          : stopRequested
            ? 'First scan stopped before convergence.'
            : 'First scan ended without convergence. Do not trust the count yet.'
      );
    } else {
      const comparison = compareSnapshots(firstSnapshot, snapshot);
      renderSnapshot(snapshot, 'VERIFICATION SCAN', comparison);
      setStatus(
        converged && comparison.exact
          ? 'Verification succeeded: second scan converged and the discovered key set exactly matches the first scan.'
          : 'Verification did not fully match. Keep this probe experimental and share the result.'
      );
    }

    log(kind, snapshot);
    running = false;
    stopRequested = false;
    updateButtons();
  }

  function makeButton(label, dataRole, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.gdfp = dataRole;
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
      position: 'fixed',
      left: '18px',
      bottom: '18px',
      zIndex: '2147483647',
      width: '390px',
      maxHeight: '78vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(32,33,36,.97)',
      color: '#f1f3f4',
      boxShadow: '0 8px 30px rgba(0,0,0,.32)',
      font: '13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `GDFP — Full Folder Discovery Probe ${VERSION}`;
    Object.assign(title.style, { fontWeight: '650', marginBottom: '7px' });

    const status = document.createElement('div');
    status.dataset.gdfp = 'status';
    status.textContent = 'Close any Drive preview, stay in the music folder, then run the first scan.';
    status.style.marginBottom = '8px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '7px',
      flexWrap: 'wrap',
      marginBottom: '8px'
    });

    controls.append(
      makeButton('Run full scan', 'scan', () => void runDiscovery('first')),
      makeButton('Verify scan again', 'verify', () => void runDiscovery('verify')),
      makeButton('Stop', 'stop', () => {
        stopRequested = true;
        setStatus('Stop requested; finishing the current pass…');
      })
    );

    const progress = document.createElement('div');
    progress.dataset.gdfp = 'progress';
    progress.textContent = 'No scan running.';
    Object.assign(progress.style, {
      padding: '8px',
      marginBottom: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(138,180,248,.12)',
      border: '1px solid rgba(138,180,248,.28)'
    });

    const result = document.createElement('div');
    result.dataset.gdfp = 'result';
    result.textContent = 'No result yet.';
    Object.assign(result.style, {
      padding: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      background: 'rgba(129,201,149,.12)',
      border: '1px solid rgba(129,201,149,.28)',
      fontSize: '11px'
    });

    const note = document.createElement('div');
    note.textContent =
      'Probe only: it scrolls the current Drive folder, accumulates unique media keys, requires five stable zero-growth passes at the bottom, then can repeat the entire scan and compare both key sets. It does not modify files and uses no Google API.';
    Object.assign(note.style, {
      marginTop: '8px',
      paddingTop: '8px',
      borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.68',
      fontSize: '11px'
    });

    panel.append(title, status, controls, progress, result, note);
    document.body.appendChild(panel);
    updateButtons();
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mountPanel();
  }

  init();
})();
