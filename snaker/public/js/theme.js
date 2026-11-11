(function () {
  var root = document.documentElement;
  root.setAttribute('data-theme', 'dark');
  try {
    var t = localStorage.getItem('snaker-theme');
    if (t === 'dark' || t === 'light') root.setAttribute('data-theme', t);
  } catch (e) {}
})();
