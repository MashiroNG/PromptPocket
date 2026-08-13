(() => {
  const theme = new URLSearchParams(location.search).get('theme');
  document.documentElement.classList.toggle('theme-light', theme === 'light');
})();
