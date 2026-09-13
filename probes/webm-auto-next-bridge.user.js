// ==UserScript==
// @name         Google Drive Folder Player - WebM Auto-Next Bridge Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.3
// @description  Integration probe: temporarily mirror Drive's live hidden WebM/video range input into a synthetic progress slider that GDFP 0.0.9 can monitor.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const PROXY_ID = 'gdfp-webm-progress-proxy';
  const PANEL_ID = 'gdfp-webm-bridge-status';
  const SAMPLE_MS = 200;
  const LIVE_GRACE_MS = 700;

  let previousValues = new WeakMap();
  let activeInput = null;
  let lastMovementAt = 0;

  function numericRange(input) {
    if (!(input instanceof HTMLInputElement) || input.type !== 'range') return null;
    const value = Number(input.value);
    const min = Number(input.min || 0);
    const max = Number(input.max);
    if (![value, min, max].every(Number.isFinite) || max <= min) return null;
    // Drive's media timeline uses a duration-sized numeric range (for example
    // 230833 ms), while volume controls use a tiny range. This stays language-independent.
    if (max - min <= 1000) return null;
    return {
      input,
      value,
      min,
      max,
      ratio: Math.max(0, Math.min(1, (value - min) / (max - min)))
    };
  }

  function candidates() {
    return [...document.querySelectorAll('input[type="range"]')]
      .filter(input => !input.closest?.(`#${PANEL_ID}`))
      .map(numericRange)
      .filter(Boolean);
  }

  function setPanel(text) {
    const node = document.querySelector(`#${PANEL_ID} [data-role="status"]`);
    if (node) node.textContent = text;
  }

  function removeProxy() {
    document.getElementById(PROXY_ID)?.remove();
  }

  function ensureProxy() {
    let proxy = document.getElementById(PROXY_ID);
    if (proxy) return proxy;

    proxy = document.createElement('div');
    proxy.id = PROXY_ID;
    proxy.setAttribute('role', 'slider');
    proxy.setAttribute('aria-valuemin', '0');
    proxy.setAttribute('aria-valuemax', '1000');
    proxy.setAttribute('aria-valuenow', '0');
    proxy.setAttribute('aria-label', 'GDFP WebM progress proxy');
    Object.assign(proxy.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '1px',
      height: '1px',
      display: 'block',
      opacity: '0',
      pointerEvents: 'none'
    });
    document.body.appendChild(proxy);
    return proxy;
  }

  function updateProxy(state) {
    const proxy = ensureProxy();
    proxy.setAttribute('aria-valuenow', String(Math.round(state.ratio * 1000)));
    proxy.dataset.sourceMax = String(state.max);
    proxy.dataset.sourceValue = String(state.value);
    setPanel(`Mirroring live hidden media progress: ${(state.ratio * 100).toFixed(1)}%  (${state.value}/${state.max})`);
  }

  function tick() {
    const list = candidates();
    let changed = null;

    for (const state of list) {
      const previous = previousValues.get(state.input);
      if (previous !== undefined && state.value !== previous) changed = state;
      previousValues.set(state.input, state.value);
    }

    if (changed) {
      activeInput = changed.input;
      lastMovementAt = Date.now();
    }

    const active = list.find(state => state.input === activeInput);
    const live = Boolean(active && active.input.isConnected && Date.now() - lastMovementAt <= LIVE_GRACE_MS);

    if (live) {
      updateProxy(active);
      return;
    }

    // Critical for compatibility with the stable 0.0.9 probe: when no real
    // moving WebM/video timeline is present, remove the synthetic slider from
    // the DOM entirely. Leaving even an inactive slider behind can be mistaken
    // for evidence that a Drive preview is still open during track transitions.
    removeProxy();

    if (!list.length) {
      activeInput = null;
      lastMovementAt = 0;
    }

    setPanel(`Waiting for a changing hidden media range… (${list.length} duration-style candidate(s) present)`);
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID) || !document.body) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: 2147483646,
      maxWidth: '420px', padding: '8px 10px', borderRadius: '9px',
      background: 'rgba(32,33,36,.92)', color: '#f1f3f4',
      boxShadow: '0 4px 18px rgba(0,0,0,.25)',
      font: '12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif'
    });
    const title = document.createElement('div');
    title.textContent = 'GDFP — WebM Auto-Next Bridge 0.0.3';
    title.style.fontWeight = '650';
    const status = document.createElement('div');
    status.dataset.role = 'status';
    status.textContent = 'Waiting for a changing hidden media range…';
    panel.append(title, status);
    document.body.appendChild(panel);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mountPanel();
    removeProxy();
    setInterval(tick, SAMPLE_MS);
  }

  init();
})();
