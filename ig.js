/* Carrusel de Instagram: desplazamiento nativo; los botones avanzan una pantalla.
   Los Reels se reproducen en silencio solo mientras están a la vista. */
(function () {
  var track = document.getElementById('ig-track');
  if (!track) return;
  document.querySelectorAll('[data-ig]').forEach(function (b) {
    b.addEventListener('click', function () {
      track.scrollBy({ left: Number(b.getAttribute('data-ig')) * track.clientWidth * 0.85, behavior: 'smooth' });
    });
  });
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting) { v.play().then(function () { v.classList.add('is-playing'); }).catch(function () {}); }
      else v.pause();
    });
  }, { threshold: 0.5 });
  track.querySelectorAll('.ig__video').forEach(function (v) { io.observe(v); });
})();
