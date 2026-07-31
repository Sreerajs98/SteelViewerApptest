/* theme-boot.js — apply saved theme before paint */
  // Apply saved theme before paint (avoid dark flash when light is preferred)
  (function () {
    try {
      var t = localStorage.getItem('steelViewerTheme');
      if (t !== 'light' && t !== 'dark') {
        t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
          ? 'light' : 'dark';
      }
      document.documentElement.setAttribute('data-theme', t);
    } catch (e) {}
  })();
