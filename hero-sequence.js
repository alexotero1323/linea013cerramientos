/* Linea 013 - page-local, bounded image-sequence renderer.
   ScrollCraft still owns the act, its geometry, cues and --sc-p. This renderer
   only owns the hero canvas on touch/narrow/portrait viewports. */
(function (global) {
  'use strict';

  var clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };
  var clamp01 = function (x) { return clamp(x, 0, 1); };

  function parseSource(spec) {
    var match = String(spec || '').match(/^(.*):(\d+):(-?\d+)$/);
    if (!match || !match[1]) return { tpl: '', count: 0, start: 0 };
    return {
      tpl: match[1],
      count: Math.max(parseInt(match[2], 10) || 0, 0),
      start: parseInt(match[3], 10) || 0
    };
  }

  function frameUrl(tpl, value) {
    return tpl.replace(/\{iiii\}/g, String(value).padStart(4, '0'))
      .replace(/\{iii\}/g, String(value).padStart(3, '0'))
      .replace(/\{ii\}/g, String(value).padStart(2, '0'))
      .replace(/\{i\}/g, String(value));
  }

  // Returns the source rectangle for an object-fit:cover draw plus an optional
  // page-level push-in. The zoom is applied to source pixels, never to an
  // already-rasterised canvas, so the mobile crop remains sharp.
  function coverRect(iw, ih, dw, dh, zoom, cx, cy) {
    var destRatio = dw / Math.max(dh, 1);
    var sourceRatio = iw / Math.max(ih, 1);
    var baseW, baseH;
    if (sourceRatio > destRatio) {
      baseH = ih;
      baseW = ih * destRatio;
    } else {
      baseW = iw;
      baseH = iw / destRatio;
    }
    zoom = Math.max(zoom || 1, 1);
    var sw = Math.min(baseW / zoom, iw);
    var sh = Math.min(baseH / zoom, ih);
    var sx = clamp(iw * (cx == null ? 0.5 : cx) - sw / 2, 0, iw - sw);
    var sy = clamp(ih * (cy == null ? 0.5 : cy) - sh / 2, 0, ih - sh);
    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  function canvasSize(cssWidth, cssHeight, dpr) {
    var ratio = Math.min(Math.max(dpr || 1, 1), 2.5);
    var width = Math.max(cssWidth * ratio, 1);
    var height = Math.max(cssHeight * ratio, 1);
    var scale = Math.min(1, 1440 / width, Math.sqrt(4000000 / (width * height)));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      ratio: ratio * scale
    };
  }

  // Time-based exponential damping: independent of 60/120Hz displays. The
  // velocity cap prevents a one-event fling from skipping most of the visual
  // journey, while 5 progress units/s still catches a full-track jump quickly.
  function dampingStep(current, target, dt, tau, maxRate) {
    var delta = target - current;
    if (Math.abs(delta) < 0.00015) return target;
    var alpha = 1 - Math.exp(-Math.max(dt, 0) / Math.max(tau || 100, 1));
    var step = delta * alpha;
    var limit = Math.max(maxRate || 5, 0.1) * Math.max(dt, 1) / 1000;
    step = clamp(step, -limit, limit);
    return clamp01(current + step);
  }

  function decodedSize(image) {
    return {
      width: image.naturalWidth || image.videoWidth || image.width || 0,
      height: image.naturalHeight || image.videoHeight || image.height || 0
    };
  }

  function closeImage(image) {
    if (!image) return;
    if (typeof image.close === 'function') image.close();
    else if ('src' in image) {
      image.onload = null;
      image.onerror = null;
      try { image.src = ''; } catch (e) {}
    }
  }

  function decodeBlob(blob) {
    if (typeof global.createImageBitmap === 'function') return global.createImageBitmap(blob);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var image = new Image();
      image.decoding = 'async';
      image.onload = function () { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      image.src = url;
    });
  }

  function HeroSequence(options) {
    options = options || {};
    this.hero = options.hero;
    this.canvas = options.canvas;
    this.poster = options.poster || null;
    this.ctx = this.canvas && this.canvas.getContext
      ? this.canvas.getContext('2d', { alpha: false, desynchronized: true })
      : null;
    this.cacheLimit = clamp(options.cacheSize || 12, 10, 32);
    this.decodeLimit = clamp(options.decodeConcurrency || 2, 1, 3);
    this.blobCacheLimit = clamp(options.blobCacheSize || 121, 1, 121);
    this.blobByteLimit = Math.max(options.blobByteLimit || 64 * 1024 * 1024, 1024 * 1024);
    this.blobFetchLimit = clamp(options.blobFetchConcurrency || 2, 1, 3);
    this.tau = options.tau || 100;
    this.maxRate = options.maxRate || 5;
    this.cropCenter = options.cropCenter || [0.5, 0.46];
    this.maxCrop = options.maxCrop || 1.13;
    this.cropEnabled = !!options.crop;
    this.active = options.active !== false;
    this.visible = true;
    this.destroyed = false;
    this.renderedProgress = 0;
    this.targetProgress = 0;
    this.drawn = -1;
    this.loaded = 0;
    this.count = 0;
    this.tpl = '';
    this.start = 0;
    this.cache = new Map();
    this.blobs = new Map();
    this.blobBytes = 0;
    this.pending = new Map();
    this.decodeQueue = [];
    this.activeDecodes = new Set();
    this.blobPending = new Map();
    this.blobQueue = [];
    this.activeBlobFetches = new Set();
    this.prefetchTimer = 0;
    this.succeeded = new Set();
    this.failed = new Set();
    this.generation = 0;
    this.raf = 0;
    this.lastTick = 0;
    this.lastDrawProgress = -1;
    this.act = null;
    this._readyPromise = Promise.resolve();
    this._readyResolve = null;
    this._readySettled = true;

    this._scroll = this._onScroll.bind(this);
    this._resize = this.resize.bind(this);
    this._visibility = this._onVisibility.bind(this);

    if (global.IntersectionObserver && this.hero) {
      var self = this;
      this.observer = new IntersectionObserver(function (entries) {
        self.visible = !!(entries[0] && entries[0].isIntersecting);
        if (self.visible) { self._scheduleBlobPrefetch(); self.wake(); }
        else { self._pauseBlobPrefetch(); self._stop(); }
      }, { rootMargin: '50% 0px' });
      this.observer.observe(this.hero);
    }
    global.addEventListener('resize', this._resize, { passive: true });
    document.addEventListener('visibilitychange', this._visibility);

    this.diagnostics = this._makeDiagnostics();
    if (this.hero) this.hero.__sequence = this.diagnostics;
    this.resize();
    this.setSource(options.source || '');
    this.setActive(this.active);
  }

  HeroSequence.prototype._makeDiagnostics = function () {
    var self = this;
    var api = {};
    ['renderedProgress', 'targetProgress', 'drawn', 'loaded', 'count'].forEach(function (key) {
      Object.defineProperty(api, key, { enumerable: true, get: function () { return self[key]; } });
    });
    Object.defineProperties(api, {
      cacheSize: { enumerable: true, get: function () { return self.cache.size; } },
      blobCount: { enumerable: true, get: function () { return self.blobs.size; } },
      blobBytes: { enumerable: true, get: function () { return self.blobBytes; } },
      source: { enumerable: true, get: function () { return self.tpl; } },
      ready: { enumerable: true, get: function () { return self._readyPromise; } },
      crop: { enumerable: true, get: function () { return self._cropScale(); } },
      active: { enumerable: true, get: function () { return self.active; } }
    });
    // Public hooks intentionally live on the diagnostic object so the browser
    // harness can exercise source swaps/resizes without reaching private state.
    api.setSource = function (spec) { return self.setSource(spec); };
    api.setCrop = function (enabled) { self.setCrop(enabled); };
    api.resize = function () { self.resize(); };
    api.destroy = function () { self.destroy(); };
    return api;
  };

  HeroSequence.prototype.connect = function (act) {
    if (this.act === act) return;
    if (this.act) global.removeEventListener('scroll', this._scroll);
    this.act = act || null;
    if (this.act) {
      this.targetProgress = clamp01(this.act.p || 0);
      this.renderedProgress = this.targetProgress;
      // Installed after ScrollCraft.mount(): its scroll rAF updates act.p before
      // this renderer's rAF consumes it.
      global.addEventListener('scroll', this._scroll, { passive: true });
      this._ensureAround(this._targetIndex());
      this.wake();
    }
  };

  HeroSequence.prototype._onScroll = function () {
    if (this.act) this.targetProgress = clamp01(this.act.p || 0);
    this._ensureAround(this._targetIndex());
    this.wake();
  };

  HeroSequence.prototype._onVisibility = function () {
    if (document.hidden) { this._pauseBlobPrefetch(); this._stop(); }
    else { this.resize(); this._scheduleBlobPrefetch(); this.wake(); }
  };

  HeroSequence.prototype.setActive = function (active) {
    this.active = !!active;
    if (this.hero) this.hero.classList.toggle('is-custom-sequence', this.active);
    if (!this.active) {
      this._pauseBlobPrefetch();
      this._stop();
      if (this.hero) {
        this.hero.classList.remove('is-seq-ready');
        this.hero.classList.remove('is-media-switching');
      }
      return;
    }
    this._ensureAround(this._targetIndex());
    this._scheduleBlobPrefetch();
    this.wake();
  };

  HeroSequence.prototype.setCrop = function (enabled) {
    this.cropEnabled = !!enabled;
    this.lastDrawProgress = -1;
    this._draw();
  };

  HeroSequence.prototype.setSource = function (spec) {
    var parsed = parseSource(spec);
    if (parsed.tpl === this.tpl && parsed.count === this.count && parsed.start === this.start) return this._readyPromise;
    // A consumer may already be awaiting the previous orientation's readiness
    // (the logo intro does). Never strand that promise during a rapid rotate.
    this._settleReady();
    this.generation++;
    this._releaseRequests();
    this._releaseCache();
    this._releaseBlobCache();
    this.tpl = parsed.tpl;
    this.count = parsed.count;
    this.start = parsed.start;
    this.drawn = -1;
    this.loaded = 0;
    this.lastDrawProgress = -1;
    this.succeeded.clear();
    this.failed.clear();
    this._readySettled = false;
    var self = this;
    this._readyPromise = new Promise(function (resolve) { self._readyResolve = resolve; });
    if (this.hero && this.active) {
      this.hero.classList.remove('is-seq-ready');
      this.hero.classList.add('is-media-switching');
    }
    if (!this.tpl || !this.count) {
      this._settleReady();
      return this._readyPromise;
    }

    // Intro readiness is intentionally bounded: first frame plus two nearby
    // frames, not 121 decoded bitmaps. Failed neighbors still settle the gate;
    // the poster remains the visual fallback until a real frame paints.
    var initial = [0];
    if (this.count > 1) initial.push(1);
    if (this.count > 2) initial.push(2);
    var readyGeneration = this.generation;
    Promise.all(initial.map(function (i) { return self._request(i, 100 - i); })).then(function () {
      if (readyGeneration !== self.generation) return;
      self._draw();
      self._settleReady();
      self._scheduleBlobPrefetch();
    });
    this._ensureAround(this._targetIndex());
    return this._readyPromise;
  };

  HeroSequence.prototype._settleReady = function () {
    if (this._readySettled) return;
    this._readySettled = true;
    if (this._readyResolve) this._readyResolve(this.diagnostics);
    this._readyResolve = null;
  };

  HeroSequence.prototype._targetIndex = function () {
    return this.count ? clamp(Math.round(this.targetProgress * (this.count - 1)), 0, this.count - 1) : 0;
  };

  HeroSequence.prototype._ensureAround = function (center) {
    if (!this.active || !this.tpl || !this.count || this.destroyed) return;
    center = clamp(center, 0, this.count - 1);
    // Stale queued work is the main source of lag after a fast reverse.
    var kept = [];
    for (var q = 0; q < this.decodeQueue.length; q++) {
      var item = this.decodeQueue[q];
      if (Math.abs(item.index - center) <= 12 || item.index === this.drawn) kept.push(item);
      else { this.pending.delete(item.index); item.resolve(null); }
    }
    this.decodeQueue = kept;

    var direction = this.targetProgress >= this.renderedProgress ? 1 : -1;
    // Mira 10 fotogramas hacia donde va el scroll y 3 hacia atrás.
    var order = [center];
    for (var k = 1; k <= 10; k++) {
      order.push(center + k * direction);
      if (k <= 3) order.push(center - k * direction);
    }
    for (var i = 0; i < order.length; i++) {
      var index = order[i];
      if (index >= 0 && index < this.count) this._request(index, 50 - i);
    }
  };

  HeroSequence.prototype._request = function (index, priority) {
    if (this.cache.has(index)) return Promise.resolve(this.cache.get(index).image);
    if (this.failed.has(index)) return Promise.resolve(null);
    if (this.pending.has(index)) return this.pending.get(index);
    var self = this;
    var promise = new Promise(function (resolve) {
      self.decodeQueue.push({ index: index, priority: priority || 0, generation: self.generation, resolve: resolve });
      self.decodeQueue.sort(function (a, b) { return b.priority - a.priority; });
      self._pumpDecode();
    });
    this.pending.set(index, promise);
    return promise;
  };

  HeroSequence.prototype._pumpDecode = function () {
    var self = this;
    while (this.activeDecodes.size < this.decodeLimit && this.decodeQueue.length) {
      (function (item) {
        if (item.generation !== self.generation) {
          self.pending.delete(item.index);
          item.resolve(null);
          return;
        }
        // A decode token survives source changes until the underlying bitmap
        // promise settles. This keeps real decode concurrency bounded even when
        // the reader rotates while two old frames are still decoding.
        var token = {};
        self.activeDecodes.add(token);
        self._requestBlob(item.index, item.priority, false)
          .then(function (blob) {
            if (!blob || item.generation !== self.generation || self.destroyed) return null;
            return decodeBlob(blob);
          })
          .then(function (image) {
            if (!image) {
              if (item.generation === self.generation) self.failed.add(item.index);
              return null;
            }
            if (item.generation !== self.generation || self.destroyed) { closeImage(image); return null; }
            self.cache.set(item.index, { image: image, used: performance.now() });
            if (!self.succeeded.has(item.index)) {
              self.succeeded.add(item.index);
              self.loaded = self.succeeded.size;
            }
            self._evict();
            self._draw();
            self.wake();
            return image;
          })
          .catch(function (error) {
            if (item.generation === self.generation && (!error || error.name !== 'AbortError')) self.failed.add(item.index);
            return null;
          })
          .then(function (image) { item.resolve(image); })
          .finally(function () {
            self.activeDecodes.delete(token);
            if (item.generation === self.generation) {
              self.pending.delete(item.index);
            }
            self._pumpDecode();
          });
      })(this.decodeQueue.shift());
    }
  };

  HeroSequence.prototype._requestBlob = function (index, priority, background) {
    var cached = this.blobs.get(index);
    if (cached) {
      cached.used = performance.now();
      return Promise.resolve(cached.blob);
    }
    if (this.blobPending.has(index)) {
      // A foreground request promotes a queued speculative fetch immediately.
      if (!background) {
        this.activeBlobFetches.forEach(function (record) {
          if (record.index === index && record.generation === this.generation) record.background = false;
        }, this);
        for (var q = 0; q < this.blobQueue.length; q++) {
          if (this.blobQueue[q].index === index) {
            this.blobQueue[q].background = false;
            this.blobQueue[q].priority = Math.max(this.blobQueue[q].priority, priority || 0);
            this.blobQueue.sort(function (a, b) { return b.priority - a.priority; });
            break;
          }
        }
        this._pumpBlob();
      }
      return this.blobPending.get(index);
    }
    var self = this;
    var item = {
      index: index,
      priority: priority || 0,
      background: !!background,
      generation: this.generation,
      resolve: null,
      promise: null
    };
    var promise = new Promise(function (resolve) {
      item.resolve = resolve;
      self.blobQueue.push(item);
      self.blobQueue.sort(function (a, b) { return b.priority - a.priority; });
      self._pumpBlob();
    });
    item.promise = promise;
    this.blobPending.set(index, promise);
    return promise;
  };

  HeroSequence.prototype._pumpBlob = function () {
    var self = this;
    while (this.activeBlobFetches.size < this.blobFetchLimit && this.blobQueue.length) {
      var foregroundAt = -1;
      for (var f = 0; f < this.blobQueue.length; f++) {
        if (!this.blobQueue[f].background) { foregroundAt = f; break; }
      }
      var itemAt = foregroundAt;
      if (itemAt < 0) {
        var activeBackground = 0;
        this.activeBlobFetches.forEach(function (record) { if (record.background) activeBackground++; });
        if (activeBackground >= 1) break;
        itemAt = 0;
      }
      (function (item) {
        if (item.generation !== self.generation) {
          self.blobPending.delete(item.index);
          item.resolve(null);
          return;
        }
        var controller = new AbortController();
        var active = { index: item.index, controller: controller, background: item.background, generation: item.generation };
        self.activeBlobFetches.add(active);
        var url = frameUrl(self.tpl, self.start + item.index);
        fetch(url, { signal: controller.signal, credentials: 'same-origin' })
          .then(function (response) {
            if (!response.ok) throw new Error('frame ' + item.index + ': HTTP ' + response.status);
            return response.blob();
          })
          .then(function (blob) {
            if (item.generation !== self.generation || self.destroyed) return null;
            self._storeBlob(item.index, blob);
            return blob;
          })
          .catch(function () { return null; })
          .then(function (blob) { item.resolve(blob); })
          .finally(function () {
            // Keep the physical fetch limit honest across source changes: old
            // aborted tokens stay counted until their promises really settle.
            self.activeBlobFetches.delete(active);
            if (item.generation === self.generation) {
              if (self.blobPending.get(item.index) === item.promise) self.blobPending.delete(item.index);
            }
            self._pumpBlob();
          });
      })(this.blobQueue.splice(itemAt, 1)[0]);
    }
  };

  HeroSequence.prototype._storeBlob = function (index, blob) {
    var previous = this.blobs.get(index);
    if (previous) this.blobBytes -= previous.size;
    var size = Math.max(Number(blob && blob.size) || 0, 0);
    this.blobs.set(index, { blob: blob, size: size, used: performance.now() });
    this.blobBytes += size;
    // A later speculative fetch may recover from a transient foreground HTTP
    // failure; allow that newly cached payload to be decoded on the next visit.
    if (this.failed) this.failed.delete(index);
    var countLimit = Math.min(this.blobCacheLimit, Math.max(this.count, 1));
    while (this.blobs.size > countLimit || this.blobBytes > this.blobByteLimit) {
      var candidate = null;
      this.blobs.forEach(function (record, key) {
        if (key === this.drawn || key === this._targetIndex()) return;
        if (!candidate || record.used < candidate.record.used) candidate = { index: key, record: record };
      }, this);
      if (!candidate) break;
      this.blobs.delete(candidate.index);
      this.blobBytes -= candidate.record.size;
    }
  };

  HeroSequence.prototype._scheduleBlobPrefetch = function () {
    if (!this.active || !this.visible || this.destroyed || document.hidden || !this.tpl || !this.count || !this._readySettled) return;
    if (this.prefetchTimer) return;
    var self = this;
    var generation = this.generation;
    var schedule = global.requestIdleCallback || function (fn) { return setTimeout(fn, 40); };
    this.prefetchTimer = schedule(function () {
      self.prefetchTimer = 0;
      if (generation !== self.generation || !self.active || !self.visible || document.hidden) return;
      // Background fetches never decode and only one may be active. Foreground
      // requests are promoted ahead of this queue and can use the second slot.
      for (var i = 0; i < self.count; i++) self._requestBlob(i, -100, true);
    });
  };

  HeroSequence.prototype._pauseBlobPrefetch = function () {
    if (this.prefetchTimer) {
      if (global.cancelIdleCallback) global.cancelIdleCallback(this.prefetchTimer);
      else clearTimeout(this.prefetchTimer);
      this.prefetchTimer = 0;
    }
    var kept = [];
    for (var i = 0; i < this.blobQueue.length; i++) {
      var item = this.blobQueue[i];
      if (!item.background) kept.push(item);
      else { this.blobPending.delete(item.index); item.resolve(null); }
    }
    this.blobQueue = kept;
    this.activeBlobFetches.forEach(function (record) {
      if (record.background) {
        record.controller.abort();
        // Allow a later foreground request/reactivation to queue a replacement;
        // the aborted token itself remains counted until its finally handler.
        if (record.generation === this.generation) this.blobPending.delete(record.index);
      }
    }, this);
  };

  HeroSequence.prototype._evict = function () {
    while (this.cache.size > this.cacheLimit) {
      var candidate = null;
      this.cache.forEach(function (record, index) {
        if (index === this.drawn || index === this._targetIndex()) return;
        if (!candidate || record.used < candidate.record.used) candidate = { index: index, record: record };
      }, this);
      if (!candidate) break;
      this.cache.delete(candidate.index);
      closeImage(candidate.record.image);
    }
  };

  HeroSequence.prototype._nearestCached = function (wanted) {
    var best = null;
    this.cache.forEach(function (record, index) {
      var distance = Math.abs(index - wanted);
      if (!best || distance < best.distance) best = { index: index, record: record, distance: distance };
    });
    return best;
  };

  HeroSequence.prototype._cropScale = function () {
    return this.cropEnabled ? 1 + (this.maxCrop - 1) * this.renderedProgress : 1;
  };

  HeroSequence.prototype._draw = function () {
    if (!this.active || !this.ctx || !this.canvas || !this.count) return false;
    var wanted = clamp(Math.floor(this.renderedProgress * (this.count - 1) + (Math.abs(this.targetProgress - this.renderedProgress) > 0.00015 ? 0 : 0.5)), 0, this.count - 1);
    var found = this.cache.has(wanted)
      ? { index: wanted, record: this.cache.get(wanted), distance: 0 }
      : this._nearestCached(wanted);
    if (!found) return false;
    // On a restored/deep scroll position, do not replace the accurate poster
    // with frame zero merely because it was part of the intro warm-up.
    if (this.drawn < 0 && found.distance > 3) return false;
    var image = found.record.image;
    var size = decodedSize(image);
    if (!size.width || !size.height || !this.canvas.width || !this.canvas.height) return false;
    var crop = this._cropScale();
    var rect = coverRect(size.width, size.height, this.canvas.width, this.canvas.height,
      crop, this.cropCenter[0], this.cropCenter[1]);
    try {
      this.ctx.globalAlpha = 1;
      this.ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh,
        0, 0, this.canvas.width, this.canvas.height);
      // Fundido con el fotograma siguiente: con 121 fotogramas el salto entre
      // uno y otro se nota en el móvil; mezclarlos da un movimiento continuo.
      var exact = this.renderedProgress * (this.count - 1);
      var base = Math.floor(exact), mix = exact - base;
      var next = found.index === base ? this.cache.get(base + 1) : null;
      if (next && mix > 0.02 && Math.abs(this.targetProgress - this.renderedProgress) > 0.00015) {
        var ns = decodedSize(next.image);
        var nr = coverRect(ns.width, ns.height, this.canvas.width, this.canvas.height,
          crop, this.cropCenter[0], this.cropCenter[1]);
        this.ctx.globalAlpha = mix;
        this.ctx.drawImage(next.image, nr.sx, nr.sy, nr.sw, nr.sh, 0, 0, this.canvas.width, this.canvas.height);
        this.ctx.globalAlpha = 1;
        next.used = performance.now();
      }
    } catch (e) { this.ctx.globalAlpha = 1; return false; }
    found.record.used = performance.now();
    this.drawn = found.index;
    this.lastDrawProgress = this.renderedProgress;
    if (this.hero) {
      this.hero.classList.add('is-seq-ready');
      this.hero.classList.remove('is-media-switching');
    }
    this.canvas.setAttribute('data-sc-verify-state',
      'frame=' + (found.index + 1) + '/' + this.count +
      ';progress=' + this.renderedProgress.toFixed(4) +
      ';crop=' + crop.toFixed(4) + '@50%,46%');
    return true;
  };

  HeroSequence.prototype.resize = function () {
    if (!this.canvas || this.destroyed) return;
    var box = this.canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var next = canvasSize(box.width, box.height, global.devicePixelRatio || 1);
    if (this.canvas.width !== next.width || this.canvas.height !== next.height) {
      this.canvas.width = next.width;
      this.canvas.height = next.height;
      this.lastDrawProgress = -1;
      this._draw();
    }
    this.wake();
  };

  HeroSequence.prototype.wake = function () {
    if (!this.active || !this.visible || this.destroyed || document.hidden || this.raf) return;
    var self = this;
    this.raf = requestAnimationFrame(function (now) { self._tick(now); });
  };

  HeroSequence.prototype._tick = function (now) {
    this.raf = 0;
    if (!this.active || !this.visible || this.destroyed || document.hidden) return;
    if (this.act) this.targetProgress = clamp01(this.act.p || 0);
    var dt = this.lastTick ? Math.min(now - this.lastTick, 64) : 16.67;
    this.lastTick = now;
    var before = this.renderedProgress;
    this.renderedProgress = dampingStep(before, this.targetProgress, dt, this.tau, this.maxRate);
    this._ensureAround(clamp(Math.round(this.renderedProgress * Math.max(this.count - 1, 0)), 0, Math.max(this.count - 1, 0)));
    var needsCropRedraw = Math.abs(this.renderedProgress - this.lastDrawProgress) > 0.0001;
    var wanted = this._targetIndex();
    var renderedIndex = this.count ? Math.round(this.renderedProgress * (this.count - 1)) : -1;
    if (needsCropRedraw || renderedIndex !== this.drawn || this.drawn < 0) this._draw();
    if (Math.abs(this.targetProgress - this.renderedProgress) > 0.00015) this.wake();
    else {
      this.renderedProgress = this.targetProgress;
      this._draw(); // settle on the exact source frame/crop, never a blended edge
      this._request(wanted, 100).then(this._draw.bind(this));
      this.lastTick = 0;
    }
  };

  HeroSequence.prototype._stop = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTick = 0;
  };

  HeroSequence.prototype._releaseRequests = function () {
    this._pauseBlobPrefetch();
    this.activeBlobFetches.forEach(function (record) { record.controller.abort(); });
    for (var i = 0; i < this.decodeQueue.length; i++) this.decodeQueue[i].resolve(null);
    for (var b = 0; b < this.blobQueue.length; b++) this.blobQueue[b].resolve(null);
    this.decodeQueue.length = 0;
    this.blobQueue.length = 0;
    this.pending.clear();
    this.blobPending.clear();
  };

  HeroSequence.prototype._releaseCache = function () {
    this.cache.forEach(function (record) { closeImage(record.image); });
    this.cache.clear();
  };

  HeroSequence.prototype._releaseBlobCache = function () {
    this.blobs.clear();
    this.blobBytes = 0;
  };

  HeroSequence.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stop();
    this._releaseRequests();
    this._releaseCache();
    this._releaseBlobCache();
    global.removeEventListener('scroll', this._scroll);
    global.removeEventListener('resize', this._resize);
    document.removeEventListener('visibilitychange', this._visibility);
    if (this.observer) this.observer.disconnect();
    if (this.hero) {
      this.hero.classList.remove('is-custom-sequence', 'is-seq-ready', 'is-media-switching');
      if (this.hero.__sequence === this.diagnostics) this.hero.__sequence = null;
    }
    this._settleReady();
  };

  // Small pure API for the local unit test and browser verification harness.
  HeroSequence.parseSource = parseSource;
  HeroSequence.frameUrl = frameUrl;
  HeroSequence.coverRect = coverRect;
  HeroSequence.canvasSize = canvasSize;
  HeroSequence.dampingStep = dampingStep;
  global.HeroSequence = HeroSequence;
  if (typeof module !== 'undefined' && module.exports) module.exports = HeroSequence;
})(typeof window !== 'undefined' ? window : globalThis);
