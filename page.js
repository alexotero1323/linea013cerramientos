/* Línea 013 · intro negra, migración del logo a la cabecera y estado de la barra.
   Todo lo que hace el scroll lo lleva el motor; esto es solo la entrada y el menú. */
(function () {
  'use strict';

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var intro = document.getElementById('intro');
  var introLogo = document.getElementById('intro-logo');
  var bar = document.getElementById('cabecera');
  var brand = document.getElementById('brand');
  var hero = document.getElementById('escena');
  var poster = document.getElementById('hero-poster');
  var toggle = document.getElementById('menu-toggle');
  var menu = document.getElementById('menu');

  // Con movimiento reducido la escena es una imagen fija: sin clip y sin recorrido largo.
  if (reduce) hero.setAttribute('data-sc-span', '1');
  // En escritorio apaisado se conserva el vídeo. Touch, una ventana estrecha o
  // un viewport vertical usan el canvas local: no depende del seek inverso de
  // iOS y solo mantiene 12 fotogramas decodificados.
  var coarse = matchMedia('(hover: none) and (pointer: coarse)').matches;
  var portraitQuery = matchMedia('(max-aspect-ratio: 1 / 1)');
  var narrowQuery = matchMedia('(max-width: 860px)');
  var portrait = portraitQuery.matches;
  var clip = hero.querySelector('video[data-sc-scrub]');
  var seq = hero.querySelector('canvas[data-sc-sequence]');
  var sequence = null;
  var sequenceMode = false;

  function videoSource(usePortrait) {
    if (usePortrait) return hero.getAttribute('data-hero-video-portrait');
    var physicalWidth = innerWidth * (devicePixelRatio || 1);
    return physicalWidth >= 2200
      ? hero.getAttribute('data-hero-video-wide-1440')
      : hero.getAttribute('data-hero-video-wide');
  }
  function sequenceSource(usePortrait) {
    return hero.getAttribute(usePortrait ? 'data-hero-sequence-portrait' : 'data-hero-sequence-wide');
  }
  function setOrientationClass(usePortrait) {
    hero.classList.toggle('is-portrait', usePortrait);
  }
  function wantsSequence() {
    return !reduce && (coarse || portraitQuery.matches || narrowQuery.matches);
  }
  function portraitCrop() {
    // Sin zoom progresivo en móvil: se ve el cerramiento completo al abrirse.
    return false;
  }

  // ScrollCraft must never see this canvas. Its built-in sequence eagerly
  // decodes every source frame; HeroSequence owns the canvas instead.
  if (seq) seq.removeAttribute('data-sc-sequence');

  setOrientationClass(portrait);
  sequenceMode = wantsSequence();
  if (reduce) {
    // El póster cuenta toda la escena con movimiento reducido: no se permite ni
    // siquiera que el motor descubra una URL de vídeo/secuencia.
    if (clip) { clip.remove(); clip = null; }
    if (seq) { seq.remove(); seq = null; }
  } else if (sequenceMode) {
    clip.removeAttribute('data-sc-src');
    sequence = new HeroSequence({
      hero: hero,
      canvas: seq,
      poster: poster,
      source: sequenceSource(portrait),
      crop: portraitCrop(),
      cacheSize: 24,
      decodeConcurrency: 3,
      tau: 45,
      maxRate: 10
    });
  } else {
    clip.setAttribute('data-sc-src', videoSource(portrait));
  }
  var sc = ScrollCraft.mount(document.body);
  var act = sc.acts.filter(function (a) { return a.el === hero; })[0];
  if (sequence) sequence.connect(act);

  var videoGeneration = 0;
  var activeVideoUrl = null;

  function switchVideo(src) {
    if (reduce || !act || !act.video || clip.getAttribute('data-sc-src') === src) return;
    var generation = ++videoGeneration;
    var V = act.video;
    var previousUrl = activeVideoUrl || (clip.src.indexOf('blob:') === 0 ? clip.src : null);

    hero.classList.add('is-media-switching');
    clip.setAttribute('data-sc-src', src);
    V.ready = false;
    V.loading = true; // impide que el loader del motor duplique esta petición

    fetch(src).then(function (response) {
      if (!response.ok) throw new Error(response.status);
      return response.blob();
    }).then(function (blob) {
      if (generation !== videoGeneration) return;
      var nextUrl = URL.createObjectURL(blob);
      activeVideoUrl = nextUrl;
      clip.addEventListener('loadedmetadata', function () {
        if (generation !== videoGeneration) return;
        V.ready = true;
        try { clip.currentTime = Math.max((act.p || 0) * (clip.duration || 1), 0.001); } catch (e) {}
      }, { once: true });
      clip.addEventListener('seeked', function () {
        if (generation !== videoGeneration) return;
        hero.classList.add('sc-has-clip');
        clip.classList.add('sc-has-clip');
        hero.classList.remove('is-media-switching');
        if (previousUrl && previousUrl !== nextUrl) URL.revokeObjectURL(previousUrl);
      }, { once: true });
      clip.src = nextUrl;
      clip.load();
      setTimeout(function () {
        if (generation === videoGeneration) hero.classList.remove('is-media-switching');
      }, 2500);
    }).catch(function () {
      if (generation !== videoGeneration) return;
      V.loading = false;
      hero.classList.remove('is-media-switching');
    });
  }

  function ensureSequence() {
    if (!sequence) {
      sequence = new HeroSequence({
        hero: hero,
        canvas: seq,
        poster: poster,
        source: sequenceSource(portrait),
        crop: portraitCrop(),
        cacheSize: 24,
        decodeConcurrency: 3,
        tau: 45,
        maxRate: 10
      });
      sequence.connect(act);
    }
    return sequence;
  }

  function syncMediaMode() {
    if (reduce) return;
    portrait = portraitQuery.matches;
    setOrientationClass(portrait);
    var nextSequenceMode = wantsSequence();
    if (nextSequenceMode) {
      // Invalidate an in-flight orientation video fetch. The engine-owned video
      // can remain decoded but is never visible beneath the active canvas.
      if (!sequenceMode) videoGeneration++;
      sequenceMode = true;
      clip.removeAttribute('data-sc-src');
      var renderer = ensureSequence();
      renderer.setActive(true);
      renderer.setCrop(portraitCrop());
      renderer.setSource(sequenceSource(portrait));
      renderer.resize();
    } else {
      sequenceMode = false;
      if (sequence) sequence.setActive(false);
      switchVideo(videoSource(portrait));
    }
    requestAnimationFrame(sc.layout);
  }
  if (portraitQuery.addEventListener) portraitQuery.addEventListener('change', syncMediaMode);
  else portraitQuery.addListener(syncMediaMode);
  if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', syncMediaMode);
  else narrowQuery.addListener(syncMediaMode);
  var mediaResizeTimer = 0;
  addEventListener('resize', function () {
    clearTimeout(mediaResizeTimer);
    mediaResizeTimer = setTimeout(function () {
      syncMediaMode();
      if (sequenceMode && sequence) sequence.resize();
    }, 180);
  }, { passive: true });

  /* ---- barra: transparente sobre la escena, sólida sobre el beige ---- */
  function updateBar() {
    var solid = hero.getBoundingClientRect().bottom <= bar.offsetHeight + 8;
    bar.classList.toggle('is-solid', solid);
  }
  addEventListener('scroll', updateBar, { passive: true });
  addEventListener('resize', updateBar);

  /* ---- menú móvil ---- */
  toggle.addEventListener('click', function () {
    var open = !bar.classList.contains('is-open');
    bar.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') { bar.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); }
  });

  /* ---- salida del negro ---- */
  var revealed = false;
  function reveal(instant) {
    if (revealed) return;
    revealed = true;
    if (instant || reduce) {
      intro.classList.add('is-gone');
      bar.classList.add('is-visible');
      updateBar();
      return;
    }
    // El logo central viaja hasta su sitio en la cabecera mientras el negro se retira.
    var from = introLogo.getBoundingClientRect();
    var to = brand.getBoundingClientRect();
    var scale = to.width / from.width;
    var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    var dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    introLogo.animate(
      [{ transform: 'translate(0,0) scale(1)' }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')' }],
      { duration: 1100, easing: 'cubic-bezier(0.77, 0, 0.175, 1)', fill: 'forwards' }
    );
    intro.classList.add('is-leaving');
    setTimeout(function () { bar.classList.add('is-visible'); updateBar(); }, 850);
    setTimeout(function () { intro.classList.add('is-gone'); }, 1250);
  }

  // Saltar la introducción: fuera el negro y al contenido.
  var skip = document.querySelector('.hero__skip');
  skip.addEventListener('click', function () { reveal(true); });

  // El negro dura lo que tarda la escena en estar lista, con un mínimo para que
  // se lea el logo y un máximo para que nunca sea una espera.
  var t0 = performance.now();
  var MIN = 1100, MAX = 3200;
  function whenReady() {
    var wait = Math.max(0, MIN - (performance.now() - t0));
    setTimeout(function () { reveal(false); }, wait);
  }
  var ready = poster.complete && poster.naturalWidth > 0
    ? Promise.resolve()
    : new Promise(function (res) { poster.addEventListener('load', res, { once: true }); poster.addEventListener('error', res, { once: true }); });
  var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  // Espera el primer pequeño vecindario (no las 121 imágenes) para que el
  // primer gesto tenga continuidad sin inflar la memoria durante la intro.
  var frames = !reduce && sequence ? sequence.diagnostics.ready : Promise.resolve();
  if (sequence) MAX = 5000;
  Promise.all([ready, fonts, frames]).then(whenReady);
  setTimeout(function () { reveal(false); }, MAX);
})();
