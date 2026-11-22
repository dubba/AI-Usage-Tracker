(() => {
  try {
    if (window.top !== window.self) return;
    const root = document.documentElement;
    if (!root) return;
    const offset = 'calc(max(env(safe-area-inset-top, 0px), 28px) + 44px)';
    const headerId = '__ai_tracker_header';
    const buttonId = '__ai_tracker_back';
    const getBg = () => {
      try {
        const parse = (c) => (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') ? c : null;
        const bodyBg = document.body && parse(window.getComputedStyle(document.body).backgroundColor);
        if (bodyBg) return bodyBg;
        const rootBg = parse(window.getComputedStyle(root).backgroundColor);
        if (rootBg) return rootBg;
      } catch (e) {}
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#131314' : '#ffffff';
    };
    const install = () => {
      const docEl = document.documentElement;
      if (!docEl) return;
      if (docEl.style.getPropertyValue('padding-top') !== offset) {
        docEl.style.setProperty('box-sizing', 'border-box', 'important');
        docEl.style.setProperty('padding-top', offset, 'important');
      }
      if (document.body && document.body.style.boxSizing !== 'border-box') {
        document.body.style.setProperty('box-sizing', 'border-box', 'important');
      }
      let header = document.getElementById(headerId);
      if (!header) {
        header = document.createElement('div');
        header.id = headerId;
        header.setAttribute('aria-hidden', 'true');
        docEl.appendChild(header);
      }
      header.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'width:100%',
        'height:' + offset, 'z-index:2147483646', 'background:' + getBg(),
        'pointer-events:none',
      ].join(';');

      if (document.getElementById(buttonId)) return;
      const button = document.createElement('button');
      button.id = buttonId;
      button.type = 'button';
      button.setAttribute('aria-label', 'Back to AI Usage Tracker');
      button.style.cssText = [
        'position:fixed', 'top:max(env(safe-area-inset-top, 0px), 28px)', 'left:8px', 'z-index:2147483647',
        'display:inline-flex', 'align-items:center', 'gap:7px',
        'padding:8px 16px 8px 11px', 'border:0', 'border-radius:999px', 'background:#6d3bd7', 'color:#fff',
        'font:700 15px -apple-system,system-ui,sans-serif', 'line-height:1', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
      ].join(';');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '10');
      svg.setAttribute('height', '16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2.6');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.display = 'block';
      svg.style.flex = 'none';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm15 18-6-6 6-6');
      svg.appendChild(path);
      const label = document.createElement('span');
      label.textContent = 'Back to AI Usage Tracker';
      button.appendChild(svg);
      button.appendChild(label);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        location.hash = 'ai-usage-tracker-back';
      }, true);
      docEl.appendChild(button);
    };
    install();
    if (window.__aiTrackerBackRoot !== root) {
      window.__aiTrackerBackRoot = root;
      new MutationObserver(install).observe(root, { childList: true });
    }
  } catch (e) {}
})();
