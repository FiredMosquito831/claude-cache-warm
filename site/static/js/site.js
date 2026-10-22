(() => {
  const head = document.querySelector('[data-head]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.getElementById('nav');

  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  if (head) {
    const onScroll = () => head.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  document.querySelectorAll('[data-copy-btn]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const host = btn.closest('[data-copy]');
      const text = btn.dataset.copyText || (host ? host.querySelector('pre')?.innerText : '') || '';
      try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = old; }, 1600);
      } catch {
        btn.textContent = 'Select + copy';
      }
    });
  });
})();
