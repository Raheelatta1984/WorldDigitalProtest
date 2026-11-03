/* global window, document */
/**
 * Shared page chrome. Header and footer are injected from one place so every
 * page carries the same navigation, the same protocol link and the same
 * "no personal data" statement.
 */
(function () {
  'use strict';

  const NAV = [
    ['index.html', 'Home'],
    ['protests.html', 'Live protests'],
    ['protocol.html', 'The protocol'],
    ['join.html', 'Join'],
    ['offline.html', 'Offline & Bluetooth'],
    ['physical.html', 'Physical presence'],
    ['create.html', 'Start a protest'],
    ['testlab.html', 'Test lab'],
  ];

  function header() {
    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.setAttribute('aria-label', 'Main');
    for (const [href, label] of NAV) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      nav.append(a);
    }

    const header = document.createElement('header');
    header.className = 'site-header';
    header.innerHTML = `
      <div class="wrap bar">
        <a class="brand" href="/" aria-label="World Digital Protest home">
          <span class="brand-mark" aria-hidden="true">WD</span>
          <span>World Digital Protest<small>One protocol · no travel required</small></span>
        </a>
      </div>`;
    header.querySelector('.bar').append(nav);
    return header;
  }

  function footer() {
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = `
      <div class="wrap cols">
        <div>
          <strong>World Digital Protest</strong>
          <p class="dim" style="margin:0">
            One worldwide protest standard. Digital presence is full participation.
            Nobody is asked to travel, and nobody is asked who they are.
          </p>
        </div>
        <div>
          <strong>Take part</strong>
          <a href="protests.html">Browse live protests</a>
          <a href="join.html">Join a protest</a>
          <a href="offline.html">Join with no internet</a>
          <a href="protocol.html">Read the protocol</a>
        </div>
        <div>
          <strong>Organise</strong>
          <a href="create.html">Start a protest</a>
          <a href="physical.html">Request physical presence</a>
          <a href="testlab.html">Test lab (inject global data)</a>
        </div>
        <div>
          <strong>Principles</strong>
          <span class="dim">No names, no emails, no addresses</span>
          <span class="dim">No physical attendance required</span>
          <span class="dim">Test data always labelled</span>
          <span class="dim">GPL-3.0 · self-hostable</span>
        </div>
      </div>`;
    return footer;
  }

  function markCurrent() {
    const page = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav a').forEach((a) => {
      if (a.getAttribute('href') === page) a.setAttribute('aria-current', 'page');
    });
  }

  function mount() {
    const headerHost = document.getElementById('site-header');
    if (headerHost) headerHost.replaceWith(header());
    const footerHost = document.getElementById('site-footer');
    if (footerHost) footerHost.replaceWith(footer());
    markCurrent();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
