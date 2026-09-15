// ==UserScript==
// @name         Google Drive Folder Player - Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.14
// @description  Continuous Google Drive media playback with guarded background-tab transitions.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.14';
  const PANEL_ID = 'gdfp-probe-panel';
  const REPEAT_MODES = ['off', 'all', 'one'];
  const MEDIA_EXTENSIONS = [
    'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma',
    'webm', 'aiff', 'aif', 'm4b', 'mp4'
  ];
  const MEDIA_RE = new RegExp(
    `([^\\/\\n\\r]{1,320}\\.(?:${MEDIA_EXTENSIONS.join('|')}))(?=\\s|$)`,
    'i'
  );

  let detectedItems = [];
  let playlist = [];
  let currentIndex = -1;
  let shuffleMode = false;
  let playlistShuffled = false;
  let repeatMode = 'off';
  let autoMode = false;
  let advancing = false;
  let endArmed = false;
  let monitorTimer = null;
  let lastRatio = null;
  let diagnosticHistory = [];
  let backgroundCloseUnconfirmed = false;

  let hiddenRangePrevious = new WeakMap();
  let hiddenRangeActive = null;
  let hiddenRangeLastMovementAt = 0;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = (...args) => console.log('[GDFP Probe]', ...args);

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0;
  }

  function isRendered(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return getComputedStyle(element).display !== 'none';
  }

  function isInsidePanel(element) {
    return Boolean(element?.closest?.(`#${PANEL_ID}`));
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

  function normalizeName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

  function findVisibleProgressSlider() {
    const sliders = [...document.querySelectorAll(
      '[role="slider"][aria-valuenow], input[type="range"][aria-valuenow], [aria-valuenow][aria-valuemin][aria-valuemax]'
    )]
      .filter(element => !isInsidePanel(element) && isRendered(element))
      .map(element => {
        const now = Number(element.getAttribute('aria-valuenow'));
        const min = Number(element.getAttribute('aria-valuemin'));
        const max = Number(element.getAttribute('aria-valuemax'));
        const span = max - min;
        const rect = element.getBoundingClientRect();
        return { element, now, min, max, span, width: rect.width };
      })
      .filter(item =>
        [item.now, item.min, item.max].every(Number.isFinite) &&
        item.max > item.min
      );

    if (!sliders.length) return null;
    sliders.sort((a, b) => {
      const ap = a.span > 100 ? 1 : 0;
      const bp = b.span > 100 ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.span !== b.span) return b.span - a.span;
      return b.width - a.width;
    });
    return sliders[0].element;
  }

  function getVisibleProgressState() {
    const slider = findVisibleProgressSlider();
    if (!slider) return null;
    const now = Number(slider.getAttribute('aria-valuenow'));
    const min = Number(slider.getAttribute('aria-valuemin'));
    const max = Number(slider.getAttribute('aria-valuemax'));
    if (![now, min, max].every(Number.isFinite) || max <= min) return null;
    return {
      element: slider,
      now,
      min,
      max,
      ratio: Math.max(0, Math.min(1, (now - min) / (max - min))),
      source: 'visible slider'
    };
  }

  function hiddenRangeCandidates() {
    return [...document.querySelectorAll('input[type="range"]')]
      .filter(input => !isInsidePanel(input))
      .map(input => {
        const value = Number(input.value);
        const min = Number(input.min || 0);
        const max = Number(input.max);
        if (![value, min, max].every(Number.isFinite) || max <= min) return null;
        const span = max - min;
        if (span <= 1000) return null;
        return {
          input,
          now: value,
          min,
          max,
          ratio: Math.max(0, Math.min(1, (value - min) / span)),
          source: 'hidden native range'
        };
      })
      .filter(Boolean);
  }

  function sampleHiddenProgressState() {
    const candidates = hiddenRangeCandidates();
    let changed = null;

    for (const state of candidates) {
      const previous = hiddenRangePrevious.get(state.input);
      if (previous !== undefined && state.now !== previous) changed = state;
      hiddenRangePrevious.set(state.input, state.now);
    }

    if (changed) {
      hiddenRangeActive = changed.input;
      hiddenRangeLastMovementAt = Date.now();
    }

    const active = candidates.find(state => state.input === hiddenRangeActive);
    if (!active) return null;
    if (Date.now() - hiddenRangeLastMovementAt > 1400) return null;
    return active;
  }

  function getProgressState() {
    return getVisibleProgressState() || sampleHiddenProgressState();
  }

  function findTopLeftCloseControl() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(element => isVisible(element) && !isInsidePanel(element));

    const textMatch = /close|fermer|schlie|cerrar|chiudi|fechar|sluiten|关闭|關閉|閉じ|닫기/i;
    const labelled = buttons.find(element => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 110 || rect.left < 0 || rect.left > 130) return false;
      const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
      return textMatch.test(label);
    });
    if (labelled) return labelled;

    return buttons
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) =>
        rect.top >= 0 &&
        rect.top < 105 &&
        rect.left >= 0 &&
        rect.left < 105 &&
        rect.width <= 90 &&
        rect.height <= 90
      )
      .sort((a, b) =>
        (a.rect.top + a.rect.left) - (b.rect.top + b.rect.left)
      )[0]?.element || null;
  }

  function findPreviewTitle() {
    const candidates = [...document.querySelectorAll('[aria-label], [title], span, div')];
    let best = null;
    const maxLeft = Math.min(window.innerWidth * 0.68, 980);

    for (const element of candidates) {
      if (isInsidePanel(element) || !isVisible(element)) continue;
      if (element.closest('[role="row"], [role="listitem"], [role="gridcell"]')) continue;

      const rect = element.getBoundingClientRect();
      if (
        rect.top < 0 ||
        rect.top > 115 ||
        rect.left < 25 ||
        rect.left > maxLeft
      ) continue;

      const name = extractMediaName(element);
      if (!name) continue;

      const score =
        (element.children.length === 0 ? 20 : 0) +
        Math.max(0, 500 - rect.left) / 100;

      if (!best || score > best.score) {
        best = { element, name, score };
      }
    }
    return best;
  }

  function getPreviewEvidenceFast() {
    const progress = getProgressState();
    const title = findPreviewTitle();
    const close = findTopLeftCloseControl();

    return {
      open: Boolean(progress || (title && close)),
      titleName: title?.name || '',
      titleElement: title?.element || null,
      progress,
      close
    };
  }

  function getPreviewEvidence() {
    return getPreviewEvidenceFast();
  }

  function collectFolderRows() {
    const previewOpen = getPreviewEvidenceFast().open;
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );

    const seenRoots = new Set();
    const seenKeys = new Set();
    const results = [];

    for (const element of candidates) {
      if (isInsidePanel(element)) continue;
      const name = extractMediaName(element);
      if (!name) continue;

      const rect = element.getBoundingClientRect();
      if (
        previewOpen &&
        rect.top >= 0 &&
        rect.top < 130 &&
        !element.closest('[role="row"], [role="listitem"]')
      ) continue;

      const root = findItemRoot(element);
      if (!root || !isVisible(root) || isInsidePanel(root)) continue;

      const rootRect = root.getBoundingClientRect();
      const id = getItemId(root);
      const key =
        `${id || normalizeName(name)}::${Math.round(rootRect.top)}::${Math.round(rootRect.left)}`;

      if (seenRoots.has(root) || seenKeys.has(key)) continue;

      seenRoots.add(root);
      seenKeys.add(key);
      results.push({ name, id, root });
    }

    return results;
  }

  function scanCurrentView() {
    const started = performance.now();
    const results = collectFolderRows();

    if (results.length) detectedItems = results;
    renderResults();

    setStatus(
      results.length
        ? `Scan finished: ${results.length} visible media row(s) cached.`
        : 'No new media rows found. The previous successful scan, if any, is kept.'
    );

    addDiagnostic(
      `Scan: ${results.length} live row(s); cache ${detectedItems.length}; ${Math.round(performance.now() - started)} ms.`
    );
    return results;
  }

  function findPreviewCloseButton() {
    return findTopLeftCloseControl();
  }

  function clickElement(element) {
    if (!element) return;
    try {
      element.click();
    } catch {
      element.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      }));
    }
  }

  function dispatchDoubleClick(element) {
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

  async function closePreview(allowHiddenFallback = false) {
    const before = getPreviewEvidence();
    if (!before.open) return true;

    const close = before.close || findPreviewCloseButton();
    if (!close) {
      setStatus('Transition blocked: preview is open but its close control was not found.');
      addDiagnostic(
        `Close failed: no close control. Preview title: ${before.titleName || '(none)'}.`
      );
      return false;
    }

    const started = performance.now();
    addDiagnostic(`Closing preview: ${before.titleName || '(title not detected)'}.`);
    clickElement(close);

    for (let i = 0; i < 40; i += 1) {
      await sleep(50);
      if (!getPreviewEvidence().open) {
        await sleep(50);
        addDiagnostic(
          `Preview closed in ${Math.round(performance.now() - started)} ms.`
        );
        return true;
      }
    }

    if (allowHiddenFallback && document.hidden) {
      backgroundCloseUnconfirmed = true;
      setStatus('Background transition: preview close not yet confirmed; continuing with guarded next-track check.');
      addDiagnostic(
        'Close confirmation timed out while hidden; continuing only with positive target-title confirmation.'
      );
      return true;
    }

    setStatus('Transition blocked: preview close was not confirmed within the retry window.');
    addDiagnostic('Close confirmation timed out.');
    return false;
  }

  function matchesTarget(item, target) {
    if (!item || !target) return false;
    if (target.id && item.id) return item.id === target.id;
    return normalizeName(item.name) === normalizeName(target.name);
  }

  function rowNeedsScroll(root) {
    const rect = root.getBoundingClientRect();
    return rect.top < 120 || rect.bottom > window.innerHeight - 24;
  }

  async function resolveFreshItem(target, patient = false) {
    const maxAttempts = patient ? 18 : 8;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const rows = collectFolderRows();
      let item = rows.find(row => matchesTarget(row, target));

      if (item?.root?.isConnected && isVisible(item.root)) {
        if (!rowNeedsScroll(item.root)) {
          addDiagnostic(
            `Resolved row immediately on attempt ${attempt}; stable id: ${target.id ? 'yes' : 'no'}.`
          );
          return item;
        }

        item.root.scrollIntoView({ block: 'center', inline: 'nearest' });
        await sleep(patient ? 300 : 90);

        item = collectFolderRows().find(row => matchesTarget(row, target));
        if (item?.root?.isConnected && isVisible(item.root)) {
          addDiagnostic(
            `Resolved row after scroll on attempt ${attempt}; stable id: ${target.id ? 'yes' : 'no'}.`
          );
          return item;
        }
      }

      if (patient) {
        await sleep(attempt < 6 ? 180 : 350);
      } else {
        await sleep(attempt < 4 ? 60 : 120);
      }
    }

    addDiagnostic(`Row resolution failed: ${target.name}`);
    return null;
  }

  async function waitForPreview(target, timeoutMs = 5200, requireTargetTitle = false) {
    const started = Date.now();
    let lastTitle = '';

    while (Date.now() - started < timeoutMs) {
      const evidence = getPreviewEvidence();
      if (evidence.titleName) lastTitle = evidence.titleName;

      const titleMatches = Boolean(evidence.titleName) &&
        normalizeName(evidence.titleName) === normalizeName(target.name);

      if (
        evidence.open &&
        (requireTargetTitle
          ? titleMatches
          : (!evidence.titleName || titleMatches))
      ) {
        return { ok: true, evidence };
      }

      await sleep(requireTargetTitle ? 180 : 60);
    }

    return { ok: false, lastTitle };
  }

  async function tryOpenTarget(target, index, reason, attempt, requireTargetTitle = false) {
    const live = await resolveFreshItem(target, requireTargetTitle);

    if (!live?.root?.isConnected) {
      setStatus(`Transition failed: no fresh Drive row for ${target.name}`);
      return false;
    }

    setStatus(
      `Opening ${index + 1}/${playlist.length} (${reason}, attempt ${attempt}${
        requireTargetTitle ? ', guarded background' : ''
      }): ${target.name}`
    );
    addDiagnostic(
      `Open attempt ${attempt}${requireTargetTitle ? ' [guarded background]' : ''}: ${target.name}`
    );
    dispatchDoubleClick(live.root);

    const result = await waitForPreview(
      target,
      requireTargetTitle ? 15000 : 5200,
      requireTargetTitle
    );

    if (result.ok) {
      addDiagnostic(
        `Preview confirmed: ${
          result.evidence.titleName ||
          `(progress detected via ${result.evidence.progress?.source || 'unknown'})`
        }.`
      );
      return true;
    }

    addDiagnostic(
      `Open attempt ${attempt} timed out. Last preview title: ${result.lastTitle || '(none)'}.`
    );
    return false;
  }

  function resetProgressTracking() {
    endArmed = false;
    lastRatio = null;
    hiddenRangePrevious = new WeakMap();
    hiddenRangeActive = null;
    hiddenRangeLastMovementAt = 0;
  }

  function cloneDetectedPlaylist() {
    return detectedItems.map(item => ({
      name: item.name,
      id: item.id || ''
    }));
  }

  function shuffleInPlace(items) {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  function buildPlaylist() {
    const built = cloneDetectedPlaylist();
    if (shuffleMode) shuffleInPlace(built);
    return built;
  }

  function toggleShuffle() {
    shuffleMode = !shuffleMode;
    updateShuffleButton();

    renderPlaybackState(
      autoMode
        ? 'Shuffle setting changed; applies on next Start'
        : 'Ready'
    );

    addDiagnostic(
      `Shuffle mode ${shuffleMode ? 'ON' : 'OFF'}${
        autoMode ? '; current queue kept until next Start.' : '.'
      }`
    );

    if (!autoMode) {
      const previewQueue = buildPlaylist();
      renderQueuePreview(previewQueue, -1);
      setStatus(
        shuffleMode
          ? 'Shuffle is ON. Start playback to use a newly shuffled queue.'
          : 'Shuffle is OFF. Start playback to use folder order.'
      );
    } else {
      setStatus(
        `Shuffle is now ${shuffleMode ? 'ON' : 'OFF'}; current queue is unchanged. Restart playback to rebuild it.`
      );
    }
  }

  function toggleRepeat() {
    const index = REPEAT_MODES.indexOf(repeatMode);
    repeatMode = REPEAT_MODES[(index + 1) % REPEAT_MODES.length];
    updateRepeatButton();
    renderPlaybackState('Repeat setting changed');
    renderQueuePreview(playlist, currentIndex);

    const label = repeatMode.toUpperCase();
    addDiagnostic(`Repeat mode ${label}.`);

    if (repeatMode === 'off') {
      setStatus('Repeat is OFF. Playback stops at the end of the current queue.');
    } else if (repeatMode === 'all') {
      setStatus('Repeat ALL is ON. The current queue restarts from track 1 when it ends.');
    } else {
      setStatus('Repeat ONE is ON. A naturally finished track restarts itself.');
    }
  }

  async function openPlaylistIndex(index, reason = 'manual') {
    if (!playlist.length || advancing || index < 0 || index >= playlist.length) {
      return false;
    }

    advancing = true;
    resetProgressTracking();
    backgroundCloseUnconfirmed = false;
    const transitionStarted = performance.now();

    try {
      const target = playlist[index];
      const previousIndex = currentIndex;
      const hiddenTransition = document.hidden;

      if (
        getPreviewEvidence().open &&
        !(await closePreview(hiddenTransition))
      ) return false;

      let requireTargetTitle = backgroundCloseUnconfirmed;
      let opened = await tryOpenTarget(
        target,
        index,
        reason,
        1,
        requireTargetTitle
      );

      if (!opened) {
        const evidence = getPreviewEvidence();
        const titleMatches = Boolean(evidence.titleName) &&
          normalizeName(evidence.titleName) === normalizeName(target.name);

        if (
          evidence.open &&
          (requireTargetTitle
            ? titleMatches
            : (!evidence.titleName || titleMatches))
        ) {
          opened = true;
          addDiagnostic(
            requireTargetTitle
              ? 'Late target-title confirmation detected; accepting guarded background transition.'
              : 'Late preview detected after timeout; accepting transition.'
          );
        }
      }

      if (!opened) {
        if (getPreviewEvidence().open) {
          await closePreview(document.hidden || requireTargetTitle);
          requireTargetTitle = requireTargetTitle || backgroundCloseUnconfirmed;
        }
        await sleep(requireTargetTitle ? 500 : 120);
        opened = await tryOpenTarget(
          target,
          index,
          reason,
          2,
          requireTargetTitle
        );
      }

      if (!opened) {
        setStatus(`Transition failed: Drive preview did not open for ${target.name}`);
        currentIndex = previousIndex;
        renderPlaybackState('Transition failed; current index preserved');
        renderQueuePreview(playlist, currentIndex);
        addDiagnostic(
          `Transition failed; index remains ${previousIndex + 1}/${playlist.length}.`
        );
        return false;
      }

      currentIndex = index;
      const elapsed = Math.round(performance.now() - transitionStarted);
      setStatus(`Playing ${index + 1}/${playlist.length}: ${target.name}`);
      renderPlaybackState(`Ready · transition ${elapsed} ms`);
      renderQueuePreview(playlist, currentIndex);
      addDiagnostic(
        `Transition accepted -> track ${index + 1}/${playlist.length} in ${elapsed} ms.${
          requireTargetTitle ? ' Guarded background path confirmed by target title.' : ''
        }`
      );
      startMonitor();
      return true;
    } finally {
      advancing = false;
    }
  }

  async function startContinuousTest() {
    if (!detectedItems.length) scanCurrentView();

    if (!detectedItems.length) {
      setStatus('No media rows cached. Close preview, scan the folder, then retry.');
      return;
    }

    autoMode = true;
    playlistShuffled = shuffleMode;
    playlist = buildPlaylist();
    currentIndex = -1;
    diagnosticHistory = [];
    renderQueuePreview(playlist, currentIndex);

    addDiagnostic(
      `Playlist captured: ${playlist.length}; ${
        playlist.filter(item => item.id).length
      } with stable Drive ids; mode=${playlistShuffled ? 'shuffle' : 'ordered'}; repeat=${repeatMode}.`
    );

    if (playlistShuffled) {
      addDiagnostic(
        `Shuffle queue head: ${playlist.slice(0, 5).map(item => item.name).join(' | ')}`
      );
    }

    await openPlaylistIndex(0, playlistShuffled ? 'shuffle start' : 'start');
  }

  function stopContinuousTest() {
    autoMode = false;
    resetProgressTracking();

    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }

    setStatus('Continuous test stopped. Drive playback itself was left untouched.');
    renderPlaybackState('Stopped');
    renderQueuePreview(playlist, currentIndex);
    addDiagnostic('Continuous test stopped.');
  }

  async function nextNow() {
    if (!playlist.length) {
      playlistShuffled = shuffleMode;
      playlist = buildPlaylist();
      renderQueuePreview(playlist, -1);
    }

    if (!playlist.length) {
      setStatus('No cached media items. Scan the folder first.');
      return;
    }

    autoMode = true;
    let nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

    if (nextIndex >= playlist.length) {
      if (repeatMode === 'all') {
        nextIndex = 0;
        addDiagnostic('Manual Next wrapped to track 1 because Repeat ALL is active.');
      } else {
        stopContinuousTest();
        setStatus('Reached the end of the cached test playlist.');
        return;
      }
    }

    await openPlaylistIndex(nextIndex, 'Next now');
  }

  async function handleTrackEnd() {
    if (!autoMode || advancing || currentIndex < 0) return;

    endArmed = false;

    if (repeatMode === 'one') {
      setStatus(`End detected. Repeating track ${currentIndex + 1}/${playlist.length}…`);
      addDiagnostic(
        `End inferred for track ${currentIndex + 1}; Repeat ONE reopening same track.`
      );
      await openPlaylistIndex(currentIndex, 'repeat one');
      return;
    }

    let nextIndex = currentIndex + 1;

    if (nextIndex >= playlist.length) {
      if (repeatMode === 'all') {
        nextIndex = 0;
        setStatus(`End detected. Repeat ALL restarting the ${playlistShuffled ? 'shuffled' : 'ordered'} queue…`);
        addDiagnostic(
          `Queue end reached; Repeat ALL wrapping to track 1 without rebuilding the ${playlistShuffled ? 'shuffled' : 'ordered'} queue.`
        );
        await openPlaylistIndex(nextIndex, 'repeat all');
        return;
      }

      autoMode = false;
      setStatus(
        `${playlistShuffled ? 'Shuffled' : 'Cached'} playlist finished (${playlist.length} track(s)).`
      );
      renderPlaybackState('Playlist finished');
      renderQueuePreview(playlist, currentIndex);
      addDiagnostic('Playlist finished; Repeat OFF.');
      return;
    }

    setStatus(`End detected. Advancing to ${nextIndex + 1}/${playlist.length}…`);
    addDiagnostic(
      `End inferred for track ${currentIndex + 1}; advancing within ${
        playlistShuffled ? 'shuffle' : 'ordered'
      } queue.`
    );
    await openPlaylistIndex(nextIndex, 'automatic next');
  }

  function monitorTick() {
    if (!autoMode || advancing || currentIndex < 0) return;

    const progress = getProgressState();
    if (!progress) {
      renderPlaybackState('Preview open; progress signal unavailable/hidden');
      return;
    }

    const ratio = progress.ratio;
    if (!endArmed && ratio < 0.95) endArmed = true;

    const percent = Math.round(ratio * 1000) / 10;
    renderPlaybackState(
      `${percent}% · ${progress.source}${
        endArmed ? ' · armed' : ' · waiting reset'
      }`
    );

    if (
      endArmed &&
      ratio >= 0.995 &&
      (lastRatio === null || lastRatio < 0.995)
    ) {
      log(`Track end inferred from ${progress.source}.`, progress);
      void handleTrackEnd();
    }

    lastRatio = ratio;
  }

  function startMonitor() {
    if (monitorTimer) return;
    monitorTimer = setInterval(monitorTick, 250);
  }

  function probeTransition() {
    const evidence = getPreviewEvidence();
    const close = evidence.close || findPreviewCloseButton();
    const title = evidence.titleName || '(none)';
    const progress = evidence.progress
      ? `${Math.round(evidence.progress.ratio * 1000) / 10}% [${evidence.progress.min}..${evidence.progress.max}] via ${evidence.progress.source}`
      : '(none)';
    const closeDesc = close
      ? `${close.tagName.toLowerCase()} label="${close.getAttribute('aria-label') || close.getAttribute('title') || '(none)'}"`
      : '(none)';

    addDiagnostic(
      `Probe -> open=${evidence.open}; title=${title}; progress=${progress}; close=${closeDesc}`
    );
  }

  function setStatus(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="status"]`);
    if (node) node.textContent = text;
  }

  function addDiagnostic(text) {
    const stamp = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    diagnosticHistory.push(`${stamp}  ${text}`);
    diagnosticHistory = diagnosticHistory.slice(-8);

    const node = document.querySelector(`#${PANEL_ID} [data-gdfp="diagnostic"]`);
    if (node) node.textContent = diagnosticHistory.join('\n');

    log(text);
  }

  function updateShuffleButton() {
    const button = document.querySelector(`#${PANEL_ID} [data-gdfp="shuffle-toggle"]`);
    if (!button) return;

    button.textContent = `Shuffle: ${shuffleMode ? 'ON' : 'OFF'}`;
    button.setAttribute('aria-pressed', String(shuffleMode));
    button.style.background = shuffleMode
      ? 'rgba(129,201,149,.22)'
      : 'rgba(255,255,255,.11)';
  }

  function updateRepeatButton() {
    const button = document.querySelector(`#${PANEL_ID} [data-gdfp="repeat-toggle"]`);
    if (!button) return;

    const label = repeatMode.toUpperCase();
    button.textContent = `Repeat: ${label}`;
    button.setAttribute('aria-label', `Repeat mode ${label}. Click to cycle Off, All, One.`);
    button.setAttribute('aria-pressed', String(repeatMode !== 'off'));
    button.style.background =
      repeatMode === 'off'
        ? 'rgba(255,255,255,.11)'
        : repeatMode === 'all'
          ? 'rgba(138,180,248,.22)'
          : 'rgba(196,181,253,.22)';
  }

  function renderPlaybackState(detail = '') {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="playback-status"]`);
    if (!box) return;

    const name =
      currentIndex >= 0 && playlist[currentIndex]
        ? playlist[currentIndex].name
        : '—';

    const position =
      currentIndex >= 0 && playlist.length
        ? `${currentIndex + 1}/${playlist.length}`
        : '—';

    box.textContent =
      `Continuous: ${autoMode ? 'ON' : 'OFF'} | Mode: ${
        (playlist.length ? playlistShuffled : shuffleMode) ? 'SHUFFLE' : 'ORDERED'
      } | Repeat: ${repeatMode.toUpperCase()} | Track: ${position} | ${detail}\n${name}`;
  }

  function renderQueuePreview(queue = playlist, activeIndex = currentIndex) {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp="queue"]`);
    if (!box) return;

    if (!queue.length) {
      box.textContent = `Queue: not built yet. Repeat ${repeatMode.toUpperCase()}.`;
      return;
    }

    const mode =
      (queue === playlist && playlist.length ? playlistShuffled : shuffleMode)
        ? 'SHUFFLE'
        : 'ORDERED';

    let start = activeIndex >= 0 ? activeIndex : 0;
    if (start >= queue.length) start = Math.max(0, queue.length - 1);

    const lines = [
      `Queue ${mode}: ${queue.length} track(s) · Repeat ${repeatMode.toUpperCase()}`
    ];
    const end = Math.min(queue.length, start + 7);

    for (let i = start; i < end; i += 1) {
      lines.push(`${i === activeIndex ? '▶' : ' '} ${i + 1}. ${queue[i].name}`);
    }

    if (end < queue.length) {
      lines.push(`… +${queue.length - end} later`);
    }

    box.textContent = lines.join('\n');
  }

  function renderResults() {
    const count = document.querySelector(`#${PANEL_ID} [data-gdfp="count"]`);
    const list = document.querySelector(`#${PANEL_ID} [data-gdfp="list"]`);
    if (!count || !list) return;

    count.textContent = `${detectedItems.length} cached visible media item(s)`;
    list.replaceChildren();

    for (const item of detectedItems.slice(0, 8)) {
      const row = document.createElement('div');
      row.textContent = item.name;
      row.title = item.name;
      row.style.whiteSpace = 'nowrap';
      row.style.overflow = 'hidden';
      row.style.textOverflow = 'ellipsis';
      list.appendChild(row);
    }

    if (detectedItems.length > 8) {
      const more = document.createElement('div');
      more.textContent = `… +${detectedItems.length - 8} more`;
      more.style.opacity = '0.7';
      list.appendChild(more);
    }
  }

  function makeButton(label, handler, dataRole = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;

    if (dataRole) button.dataset.gdfp = dataRole;

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

  function clampPanelPosition(panel, left, top) {
    const margin = 4;
    const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, left)),
      top: Math.min(maxTop, Math.max(margin, top))
    };
  }

  function enablePanelDragging(panel, handle) {
    let dragging = false;
    let pointerId = null;
    let offsetX = 0;
    let offsetY = 0;
    let previousBodyUserSelect = '';

    const finishDrag = event => {
      if (!dragging || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
      dragging = false;
      handle.style.cursor = 'grab';
      if (document.body) document.body.style.userSelect = previousBodyUserSelect;
      try {
        if (pointerId !== null && handle.hasPointerCapture?.(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore capture-release races.
      }
      pointerId = null;
    };

    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.dataset.gdfpDragged = 'true';
      dragging = true;
      pointerId = event.pointerId;
      handle.style.cursor = 'grabbing';
      previousBodyUserSelect = document.body?.style.userSelect || '';
      if (document.body) document.body.style.userSelect = 'none';
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture is an optimization; dragging still works without it.
      }
      event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== pointerId) return;
      const position = clampPanelPosition(
        panel,
        event.clientX - offsetX,
        event.clientY - offsetY
      );
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      event.preventDefault();
    });

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);

    window.addEventListener('resize', () => {
      if (panel.dataset.gdfpDragged !== 'true') return;
      const rect = panel.getBoundingClientRect();
      const position = clampPanelPosition(panel, rect.left, rect.top);
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
    });
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
      width: '450px',
      maxHeight: '84vh',
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
    title.textContent = `Google Drive Folder Player — Probe ${VERSION}`;
    title.title = 'Drag this title bar to move the panel';
    Object.assign(title.style, {
      fontWeight: '650',
      marginBottom: '8px',
      cursor: 'grab',
      userSelect: 'none',
      touchAction: 'none'
    });

    const status = document.createElement('div');
    status.dataset.gdfp = 'status';
    status.textContent =
      'Ready. Scan the music folder, choose Shuffle/Repeat if wanted, then start playback.';
    status.style.marginBottom = '9px';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '7px',
      flexWrap: 'wrap',
      marginBottom: '9px'
    });

    controls.append(
      makeButton('Scan folder view', scanCurrentView),
      makeButton('Shuffle: OFF', toggleShuffle, 'shuffle-toggle'),
      makeButton('Repeat: OFF', toggleRepeat, 'repeat-toggle'),
      makeButton('Start continuous test', startContinuousTest),
      makeButton('Next now', nextNow),
      makeButton('Stop', stopContinuousTest),
      makeButton('Probe transition', probeTransition)
    );

    const playback = document.createElement('div');
    playback.dataset.gdfp = 'playback-status';
    playback.textContent =
      'Continuous: OFF | Mode: ORDERED | Repeat: OFF | Track: —';

    Object.assign(playback.style, {
      marginBottom: '9px',
      padding: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(129,201,149,.12)',
      border: '1px solid rgba(129,201,149,.28)',
      overflowWrap: 'anywhere'
    });

    const queue = document.createElement('div');
    queue.dataset.gdfp = 'queue';
    queue.textContent = 'Queue: not built yet. Repeat OFF.';
    Object.assign(queue.style, {
      marginBottom: '9px',
      padding: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(251,188,4,.09)',
      border: '1px solid rgba(251,188,4,.24)',
      overflowWrap: 'anywhere',
      fontSize: '11px'
    });

    const diagnostic = document.createElement('div');
    diagnostic.dataset.gdfp = 'diagnostic';
    diagnostic.textContent = 'Transition history will appear here.';
    Object.assign(diagnostic.style, {
      marginBottom: '9px',
      padding: '8px',
      borderRadius: '7px',
      whiteSpace: 'pre-wrap',
      background: 'rgba(138,180,248,.12)',
      border: '1px solid rgba(138,180,248,.28)',
      overflowWrap: 'anywhere',
      fontSize: '11px'
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
      gap: '2px'
    });

    const note = document.createElement('div');
    note.textContent =
      'Probe 0.0.14 keeps the validated 0.0.13 Shuffle + Repeat + draggable-panel + MP3/WebM core. Foreground transitions remain unchanged. When a hidden tab cannot confirm Drive preview closure in time, the script continues through a guarded background path and accepts the next track only after its exact preview title is confirmed. Still @grant none; no Google API.';
    Object.assign(note.style, {
      marginTop: '9px',
      paddingTop: '8px',
      borderTop: '1px solid rgba(255,255,255,.16)',
      opacity: '0.65',
      fontSize: '11px'
    });

    panel.append(
      title,
      status,
      controls,
      playback,
      queue,
      diagnostic,
      count,
      list,
      note
    );

    document.body.appendChild(panel);
    enablePanelDragging(panel, title);
    updateShuffleButton();
    updateRepeatButton();
    log(`Probe ${VERSION} mounted.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mountPanel();
  }

  init();
})();