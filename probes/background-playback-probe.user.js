// ==UserScript==
// @name         Google Drive Folder Player - Background Playback Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Passive diagnostics for background-tab playback stalls. Does not control Google Drive playback.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-background-probe';
  const STORAGE_KEY = 'gdfp-background-probe-log-v1';
  const MAX_LOG_LINES = 120;
  const TICK_MS = 250;

  let lines = loadLines();
  let lastTickAt = performance.now();
  let lastMainPlaybackText = '';
  let lastMainStatusText = '';
  let lastProgress = null;
  let lastProgressSeenAt = 0;
  let lastMilestone = -1;
  let missingNearEndLogged = false;

  function nowStamp() {
    const d = new Date();
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function loadLines() {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value.slice(-MAX_LOG_LINES) : [];
    } catch {
      return [];
    }
  }

  function saveLines() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(lines.slice(-MAX_LOG_LINES)));
    } catch {
      // Diagnostics must never interfere with Drive.
    }
  }

  function log(message) {
    const line = `${nowStamp()}  ${message}`;
    lines.push(line);
    lines = lines.slice(-MAX_LOG_LINES);
    saveLines();
    renderLog();
    console.log('[GDFP Background Probe]', message);
  }

  function clearLog() {
    lines = [];
    saveLines();
    lastMilestone = -1;
    missingNearEndLogged = false;
    log(`Log cleared. Probe ${VERSION} active; visibility=${document.visibilityState}.`);
  }

  function isRendered(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return getComputedStyle(element).display !== 'none';
  }

  function sampleVisibleProgress() {
    const states = [...document.querySelectorAll(
      '[role="slider"][aria-valuenow][aria-valuemin][aria-valuemax], [aria-valuenow][aria-valuemin][aria-valuemax]'
    )]
      .filter(element => !element.closest(`#${PANEL_ID}`) && isRendered(element))
      .map(element => {
        const now = Number(element.getAttribute('aria-valuenow'));
        const min = Number(element.getAttribute('aria-valuemin'));
        const max = Number(element.getAttribute('aria-valuemax'));
        const span = max - min;
        if (![now, min, max].every(Number.isFinite) || span <= 100) return null;
        return {
          ratio: Math.max(0, Math.min(1, (now - min) / span)),
          source: 'visible slider'
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.ratio - a.ratio);

    return states[0] || null;
  }

  function sampleHiddenProgress() {
    const states = [...document.querySelectorAll('input[type="range"]')]
      .filter(input => !input.closest(`#${PANEL_ID}`))
      .map(input => {
        const value = Number(input.value);
        const min = Number(input.min || 0);
        const max = Number(input.max);
        const span = max - min;
        if (![value, min, max].every(Number.isFinite) || span <= 1000) return null;
        return {
          ratio: Math.max(0, Math.min(1, (value - min) / span)),
          source: 'hidden native range'
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.ratio - a.ratio);

    return states[0] || null;
  }

  function sampleProgress() {
    return sampleVisibleProgress() || sampleHiddenProgress();
  }

  function readMainPanel() {
    const main = document.getElementById('gdfp-probe-panel');
    if (!main) return { playback: '', status: '' };
    return {
      playback: main.querySelector('[data-gdfp="playback-status"]')?.textContent?.trim() || '',
      status: main.querySelector('[data-gdfp="status"]')?.textContent?.trim() || ''
    };
  }

  function compact(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function tick() {
    const now = performance.now();
    const gap = now - lastTickAt;
    lastTickAt = now;

    if (gap > 1200) {
      log(`TIMER GAP ${Math.round(gap)} ms while visibility=${document.visibilityState}.`);
    }

    const main = readMainPanel();
    const playback = compact(main.playback);
    const status = compact(main.status);

    if (playback && playback !== lastMainPlaybackText) {
      const meaningful = /Track:|Playlist finished|Stopped|Transition failed|Repeat|Ready|%/.test(playback);
      if (meaningful) log(`MAIN playback: ${playback}`);
      lastMainPlaybackText = playback;
    }

    if (status && status !== lastMainStatusText) {
      const meaningful = /Playing|End detected|Opening|finished|failed|blocked|Reached the end|Repeat/.test(status);
      if (meaningful) log(`MAIN status: ${status}`);
      lastMainStatusText = status;
    }

    const progress = sampleProgress();
    if (progress) {
      lastProgress = progress;
      lastProgressSeenAt = Date.now();
      missingNearEndLogged = false;

      const milestone = Math.floor(progress.ratio * 10);
      if (milestone !== lastMilestone && (milestone >= 8 || milestone === 0)) {
        lastMilestone = milestone;
        log(`Progress ${Math.round(progress.ratio * 1000) / 10}% via ${progress.source}; visibility=${document.visibilityState}.`);
      }

      if (progress.ratio >= 0.99 && lastProgress?.ratio < 0.99) {
        log(`Progress crossed 99% via ${progress.source}.`);
      }
    } else if (
      lastProgress &&
      lastProgress.ratio >= 0.90 &&
      Date.now() - lastProgressSeenAt > 1500 &&
      !missingNearEndLogged
    ) {
      missingNearEndLogged = true;
      log(`PROGRESS DISAPPEARED after ${Math.round(lastProgress.ratio * 1000) / 10}% near end; visibility=${document.visibilityState}.`);
    }
  }

  function renderLog() {
    const node = document.querySelector(`#${PANEL_ID} [data-gdfp-bg="log"]`);
    if (node) node.textContent = lines.slice(-28).join('\n');
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '2147483646',
      width: '420px',
      maxHeight: '48vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '10px',
      borderRadius: '10px',
      background: 'rgba(25,27,30,.95)',
      color: '#f1f3f4',
      border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)',
      font: '11px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `Background Playback Probe ${VERSION} — passive`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '7px';

    const note = document.createElement('div');
    note.textContent = 'Leave the main 0.0.13 player running. Put this Drive tab in the background until playback stalls, then return and screenshot this log.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '7px';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Clear log';
    Object.assign(button.style, {
      marginBottom: '7px',
      padding: '5px 8px',
      borderRadius: '6px',
      border: '1px solid rgba(255,255,255,.25)',
      background: 'rgba(255,255,255,.1)',
      color: 'inherit',
      cursor: 'pointer'
    });
    button.addEventListener('click', clearLog);

    const logBox = document.createElement('div');
    logBox.dataset.gdfpBg = 'log';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere'
    });

    panel.append(title, note, button, logBox);
    document.body.appendChild(panel);
    renderLog();
  }

  document.addEventListener('visibilitychange', () => {
    log(`VISIBILITY -> ${document.visibilityState}.`);
  });
  window.addEventListener('pagehide', () => log('PAGEHIDE fired.'));
  window.addEventListener('pageshow', event => log(`PAGESHOW fired; persisted=${event.persisted}.`));
  document.addEventListener('freeze', () => log('FREEZE lifecycle event fired.'));
  document.addEventListener('resume', () => log('RESUME lifecycle event fired.'));

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mountPanel();
    log(`Probe ${VERSION} started; visibility=${document.visibilityState}.`);
    setInterval(tick, TICK_MS);
  }

  init();
})();
