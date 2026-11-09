// Aurora's opening screen: a jump through space, a flash and shockwave, then the logo settles in with the line
// "Where streaming is possible". Drawn on a canvas, with a synthesised sound (no audio file).
// app.js keeps the screen up long enough (SPLASH_MIN) and fades it out; this file only draws and plays.
// window.AuroraSplash.sound() starts the sound (app.js calls it unless "Sound when Aurora opens" is Off).
//
// Smoothness: the picture is drawn in a Web Worker on an OffscreenCanvas, so the app starting up behind it (which keeps the
// main thread busy for a few seconds on a TV box) can't make it stutter. Where that isn't available it is drawn on the page
// instead, at a lower resolution and 30 frames a second on a TV.
(function () {
  'use strict';
  var el = document.getElementById('splash');
  var cv = document.getElementById('splash-cv');
  var born = performance.now();
  var tv = false;
  try { tv = !!(window.EmbyFlixAndroid && window.EmbyFlixAndroid.isTv && window.EmbyFlixAndroid.isTv()); } catch (e) { /* not the Android app */ }
  var still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- the picture: one self-contained function, so it can run in a worker or on the page ----------
  function createRenderer() {
    var MARK = ['M29,40 C40,25 63,22 81,33', 'M38,79 L54,47 L70,79'];
    var WORD = 'M7.0 100 L51.0 15.4 L95.0 100 M155.0 0 V57.0 A36 36 0 0 0 227.0 57.0 V0 M287.0 100 V7.0 H317.0 A24.5 24.5 0 0 1 317.0 56.0 H287.0 M319.0 56.0 L351.0 100 M411.0 50 A43.0 43.0 0 1 0 497.0 50 A43.0 43.0 0 1 0 411.0 50 Z M557.0 100 V7.0 H587.0 A24.5 24.5 0 0 1 587.0 56.0 H557.0 M589.0 56.0 L621.0 100 M681.0 100 L725.0 15.4 L769.0 100';
    var TAG = 'WHERE STREAMING IS POSSIBLE';
    var canvas, ctx, W = 0, H = 0, R = 0, L = null, stars = [], glow = null, logo = null, tvMode = false, last = 0, base = 1;
    var ease = function (x) { return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3); };
    var clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };
    var rnd = function (a, b) { return a + Math.random() * (b - a); };
    function mk(w, h) {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
    }
    // The logo, drawn once into its own layer (the glow around it is expensive, so it is not redone every frame).
    function drawLogoLayer() {
      logo = mk(W, H); var c = logo.getContext('2d');
      var pMark = MARK.map(function (d) { return new Path2D(d); }), pWord = new Path2D(WORD);
      c.lineCap = 'round'; c.lineJoin = 'miter'; c.miterLimit = 10;
      if (!tvMode) { c.shadowColor = 'rgba(110,150,255,.9)'; c.shadowBlur = Math.max(8, W * 0.03); }
      c.save(); c.setTransform(L.sm, 0, 0, L.sm, L.cx - 55 * L.sm, L.markY - 20 * L.sm);
      var g = c.createLinearGradient(29, 40, 81, 33); g.addColorStop(0, '#2AD4D0'); g.addColorStop(0.55, '#4F7BFF'); g.addColorStop(1, '#7A5CFF');
      c.strokeStyle = g; c.lineWidth = 3.5; c.stroke(pMark[0]);
      c.strokeStyle = '#fff'; c.lineWidth = 6; c.stroke(pMark[1]);
      c.restore();
      c.save(); c.setTransform(L.sw, 0, 0, L.sw, L.cx - 388 * L.sw, L.wordY + 6 * L.sw);
      c.lineCap = 'butt'; c.strokeStyle = '#fff'; c.lineWidth = 14; c.stroke(pWord);
      c.restore();
    }
    function drawGlowSprite() {
      glow = mk(256, 256); var c = glow.getContext('2d');
      var g = c.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, 'rgba(160,190,255,1)'); g.addColorStop(1, 'rgba(80,120,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 256, 256);
    }
    function layout() {
      R = Math.hypot(W, H) / 2;
      var wide = W > H, ww = wide ? W * 0.40 : W * 0.70, sw = ww / 776, mw = ww * 0.30, sm = mw / 62;
      var markH = 64 * sm, wordH = 112 * sw, gap1 = ww * 0.07, gap2 = ww * 0.10, tagH = ww * 0.05;
      var y0 = H * 0.47 - (markH + gap1 + wordH + gap2 + tagH) / 2;
      L = { sw: sw, sm: sm, ww: ww, markY: y0, wordY: y0 + markH + gap1, tagY: y0 + markH + gap1 + wordH + gap2, tagSize: ww * 0.043, cx: W / 2 };
    }
    function size(w, h) {
      W = canvas.width = Math.max(2, w); H = canvas.height = Math.max(2, h);
      base = Math.max(1, W / 390 * 0.5);
      layout(); drawLogoLayer();
    }
    function tag(t, t0) {
      var s = L.tagSize; ctx.save(); ctx.font = '500 ' + s + 'px Inter, system-ui, sans-serif'; ctx.textBaseline = 'top';
      var sp = s * 0.36, ws = [], tot = 0, k;
      for (k = 0; k < TAG.length; k++) { ws.push(ctx.measureText(TAG[k]).width); tot += ws[k]; }
      tot += sp * (TAG.length - 1);
      var x = L.cx - tot / 2;
      ctx.fillStyle = 'rgb(174,185,230)';
      for (k = 0; k < TAG.length; k++) {
        var a = ease((t - t0 - k * 0.045) / 0.6);
        if (a > 0) { ctx.globalAlpha = a; ctx.fillText(TAG[k], x, L.tagY + (1 - a) * s * 0.8); }
        x += ws[k] + sp;
      }
      ctx.restore();
    }
    function bar(t) {
      var w = W * (W > H ? 0.30 : 0.46), h = Math.max(2, W * 0.004), x = L.cx - w / 2, y = H * 0.92, p = Math.min(1, t / 12);
      ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(x, y, w, h);
      var g = ctx.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, '#2ad4d0'); g.addColorStop(0.5, '#4f7bff'); g.addColorStop(1, '#9a6bff');
      ctx.fillStyle = g; ctx.fillRect(x, y, w * p, h); ctx.restore();
    }
    return {
      init: function (c, o) {
        canvas = c; tvMode = !!o.tv; ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        drawGlowSprite();
        var n = tvMode ? 150 : 300;
        for (var i = 0; i < n; i++) {
          var h = Math.random() < 0.35 ? 255 : Math.random() < 0.5 ? 185 : 0;
          stars.push({ a: Math.random() * 6.283, r: Math.random(), v: rnd(0.5, 1.4), l: rnd(0.5, 1), style: h ? 'hsl(' + h + ',90%,72%)' : '#fff' });
        }
        size(o.W, o.H);
      },
      resize: function (w, h) { size(w, h); },
      frame: function (t) {
        var dt = clamp(t - last, 0, 0.05); last = t;
        var cy = H * 0.47;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = '#02030a'; ctx.fillRect(0, 0, W, H);
        var speed = t < 2 ? 0.15 + 7 * Math.pow(t / 2, 2.4) : 0.35 + Math.max(0, 1.2 - (t - 2) * 1.1);
        ctx.save(); ctx.translate(W / 2, cy); ctx.lineCap = 'butt';
        var fade = t < 2 ? 1 : 0.7;
        for (var i = 0; i < stars.length; i++) {
          var s = stars[i];
          s.r += speed * dt * s.v * 0.9 * (0.4 + s.r);
          if (s.r > 1.05) { s.r = Math.random() * 0.08; s.a = Math.random() * 6.283; }
          var len = Math.min(s.r, 0.012 + speed * 0.085 * s.v * (0.3 + s.r)), ca = Math.cos(s.a), sa = Math.sin(s.a);
          ctx.globalAlpha = Math.min(1, clamp(s.r * 2.4, 0, 1) * s.l * 1.25) * fade;
          ctx.strokeStyle = s.style; ctx.lineWidth = (0.8 + s.r * 2.4) * base;
          ctx.beginPath(); ctx.moveTo(ca * (s.r - len) * R, sa * (s.r - len) * R); ctx.lineTo(ca * s.r * R, sa * s.r * R); ctx.stroke();
        }
        ctx.restore(); ctx.globalAlpha = 1;
        var gl = ease(t / 1.9) * (t < 2 ? 1 : Math.max(0, 1 - (t - 2) * 1.4));
        if (gl > 0.01) { var gr = R * 0.55; ctx.globalAlpha = 0.55 * gl; ctx.drawImage(glow, W / 2 - gr, cy - gr, gr * 2, gr * 2); ctx.globalAlpha = 1; }
        if (t > 1.95) {
          var k = t - 1.95, f = Math.max(0, 1 - k * 3.6);
          if (f > 0) { ctx.globalAlpha = f * 0.9; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
          var rr = ease(k / 1.3) * R * 1.1, ra = Math.max(0, 1 - k / 1.3);
          if (ra > 0) {
            ctx.lineWidth = Math.max(1, 6 - 4 * k) * base; ctx.strokeStyle = 'rgba(140,180,255,' + ra * 0.85 + ')'; ctx.beginPath(); ctx.arc(W / 2, cy, rr, 0, 7); ctx.stroke();
            ctx.lineWidth = 2 * base; ctx.strokeStyle = 'rgba(42,212,208,' + ra * 0.6 + ')'; ctx.beginPath(); ctx.arc(W / 2, cy, rr * 0.82, 0, 7); ctx.stroke();
          }
        }
        var lg = ease((t - 2.0) / 0.9);
        if (lg > 0) {
          var sc = 1.16 - 0.16 * lg;
          ctx.save(); ctx.globalAlpha = lg; ctx.translate(W / 2, cy); ctx.scale(sc, sc); ctx.translate(-W / 2, -cy); ctx.drawImage(logo, 0, 0); ctx.restore();
        }
        tag(t, 2.8); bar(t);
      },
    };
  }

  // ---------- running it: worker first, the page as the fallback ----------
  function startOnPage(canvasEl, o) {
    var r = createRenderer(); r.init(canvasEl, o);
    if (still) { r.frame(0.05); r.frame(6); return; } // reduced motion: the finished screen, once, no movement
    var lastDraw = 0;
    function loop(now) {
      if (!el.isConnected) return;
      if (!document.hidden && (!o.tv || now - lastDraw > 30)) { lastDraw = now; r.frame(Math.max(0, (now - born) / 1000)); }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    window.addEventListener('resize', function () { if (el.isConnected) { var d = dims(); r.resize(d.W, d.H); } });
  }
  // Resolution: the picture is stretched to the screen, so a TV box draws fewer pixels than it shows.
  function dims() {
    var dpr = tv ? 1 : Math.min(window.devicePixelRatio || 1, 2), w = el.clientWidth * dpr, h = el.clientHeight * dpr;
    var budget = tv ? 0.95e6 : 2.2e6, k = Math.min(1, Math.sqrt(budget / (w * h)));
    return { W: Math.round(w * k), H: Math.round(h * k) };
  }
  function start() {
    if (!el || !cv || !cv.getContext || typeof Path2D === 'undefined') return;
    var d = dims(), o = { W: d.W, H: d.H, tv: tv };
    var canUseWorker = !still && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && cv.transferControlToOffscreen;
    if (canUseWorker) {
      try {
        var src = 'var make=' + createRenderer.toString() + ';var r=make(),t0=0,lastDraw=0,tvm=false;' +
          'function loop(){var now=performance.now();if(!tvm||now-lastDraw>30){lastDraw=now;r.frame(Math.max(0,(now-t0)/1000));}(self.requestAnimationFrame||function(f){return setTimeout(f,16)})(loop);}' +
          'onmessage=function(e){var m=e.data;if(m.canvas){try{r.init(m.canvas,m.o);}catch(x){postMessage({fail:String(x)});return;}tvm=m.o.tv;t0=performance.now()-m.elapsed*1000;postMessage({ok:1});loop();}' +
          'else if(m.resize){r.resize(m.resize.W,m.resize.H);}else if(m.stop){close();}};';
        var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        var w = new Worker(url), off = cv.transferControlToOffscreen(), done = false;
        var fallback = function () {
          if (done) return; done = true; try { w.terminate(); } catch (e) { /* ignore */ }
          var fresh = document.createElement('canvas'); fresh.id = 'splash-cv'; cv.replaceWith(fresh); cv = fresh; startOnPage(fresh, o);
        };
        w.onerror = fallback;
        w.onmessage = function (e) { if (e.data && e.data.fail) fallback(); };
        w.postMessage({ canvas: off, o: o, elapsed: (performance.now() - born) / 1000 }, [off]);
        window.addEventListener('resize', function () { if (!done && el.isConnected) { var n = dims(); w.postMessage({ resize: n }); } });
        var iv = setInterval(function () { if (!el.isConnected) { clearInterval(iv); try { w.postMessage({ stop: 1 }); w.terminate(); } catch (e) { /* ignore */ } URL.revokeObjectURL(url); } }, 400);
        return;
      } catch (e) { /* fall through to the page */ }
    }
    startOnPage(cv, o);
  }
  try { start(); } catch (e) { /* the screen stays plain dark; the app still starts */ }

  // ---------- the sound ----------
  // A quickening heartbeat, chord stabs, a rising whoosh, a hit and a wide chord bloom. Built for small TV speakers too: the
  // heartbeat and the hit have mid-range parts (not just deep bass), and everything is lifted and kept in check by a compressor.
  var ac = null, master = null, verb = null, dly = null;
  var mhz = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
  function setup() {
    var n = Math.floor(ac.sampleRate * 2.6), buf = ac.createBuffer(2, n, ac.sampleRate), c, i;
    for (c = 0; c < 2; c++) { var d = buf.getChannelData(c); for (i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.4); }
    var comp = ac.createDynamicsCompressor(); comp.threshold.value = -22; comp.knee.value = 16; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.25;
    master = ac.createGain(); master.gain.value = 1.9; master.connect(comp); comp.connect(ac.destination);
    verb = ac.createConvolver(); verb.buffer = buf; var vo = ac.createGain(); vo.gain.value = 0.5; verb.connect(vo); vo.connect(master);
    dly = ac.createGain(); var dl = ac.createDelay(1), dr = ac.createDelay(1), fb = ac.createGain(), mg = ac.createChannelMerger(2), lp = ac.createBiquadFilter();
    dl.delayTime.value = 0.27; dr.delayTime.value = 0.405; fb.gain.value = 0.36; lp.type = 'lowpass'; lp.frequency.value = 4600;
    dly.connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl); dl.connect(mg, 0, 0); dr.connect(mg, 0, 1); mg.connect(lp); lp.connect(master);
  }
  function build() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ac = new AC(); setup(); return true;
  }
  function voice(t, freq, dur, o) {
    o = o || {};
    var gain = o.gain == null ? 0.15 : o.gain, attack = o.attack == null ? 0.01 : o.attack, rel = o.rel == null ? 0.8 : o.rel;
    var osc = ac.createOscillator(), g = ac.createGain(), pn = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain();
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(freq, t); if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur); osc.detune.value = o.detune || 0;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.setValueAtTime(gain, t + Math.max(attack, dur)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + rel);
    var node = osc;
    if (o.cut) { var f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(o.cut, t); if (o.cut2) f.frequency.exponentialRampToValueAtTime(o.cut2, t + (o.cutT || 1)); f.Q.value = 0.8; osc.connect(f); node = f; }
    node.connect(g); g.connect(pn); if (pn.pan) pn.pan.value = o.pan || 0; pn.connect(master);
    var wet = o.wet == null ? 0.5 : o.wet;
    if (wet) { var w = ac.createGain(); w.gain.value = wet; pn.connect(w); w.connect(verb); }
    if (o.dl) { var dd = ac.createGain(); dd.gain.value = o.dl; pn.connect(dd); dd.connect(dly); }
    osc.start(t); osc.stop(t + dur + rel + 0.1);
  }
  function noise(t, dur, o) {
    var n = Math.floor(ac.sampleRate * (dur + o.rel + 0.1)), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0), i;
    for (i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    var src = ac.createBufferSource(); src.buffer = buf;
    var f = ac.createBiquadFilter(); f.type = o.type; f.Q.value = o.q || 1; f.frequency.setValueAtTime(o.f0, t); f.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    var g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(o.gain, t + o.attack); g.gain.setValueAtTime(o.gain, t + dur); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + o.rel);
    src.connect(f); f.connect(g); g.connect(master);
    if (o.wet) { var w = ac.createGain(); w.gain.value = o.wet; g.connect(w); w.connect(verb); }
    src.start(t); src.stop(t + dur + o.rel + 0.1);
  }
  // a thump you can hear on a small speaker: a falling tone, its octave, and a short click
  function thump(t, gain, low) {
    voice(t, low * 2.4, 0.14, { gain: gain, to: low, attack: 0.003, rel: 0.4, wet: 0.1 });
    voice(t, low * 4.8, 0.09, { type: 'triangle', gain: gain * 0.5, to: low * 2, attack: 0.002, rel: 0.25, wet: 0.1 });
    noise(t, 0.03, { type: 'bandpass', f0: 1800, f1: 900, gain: gain * 0.5, attack: 0.002, rel: 0.12, wet: 0.05, q: 1.2 });
  }
  function wide(t, notes, dur, o) {
    notes.forEach(function (m, i) {
      var pan = (i / (notes.length - 1) * 2 - 1) * 0.8;
      [-13, 0, 13].forEach(function (det) {
        voice(t, mhz(m), dur, { type: 'sawtooth', gain: o.gain / 1.4, attack: o.attack, rel: o.rel, detune: det, pan: pan * (det ? (det > 0 ? 1 : 0.6) : 0.8), wet: o.wet, dl: o.dl, cut: o.cut, cut2: o.cut2, cutT: o.cutT });
      });
    });
  }
  function arp(t, notes, start, gap) {
    notes.forEach(function (m, i) {
      var pan = i % 2 ? 0.55 : -0.55;
      voice(t + start + i * gap, mhz(m), 0.04, { type: 'triangle', gain: 0.16, attack: 0.003, rel: 0.55, pan: pan, wet: 0.45, dl: 0.5, cut: 5200, cut2: 1200, cutT: 0.4 });
      voice(t + start + i * gap, mhz(m + 12), 0.03, { gain: 0.07, attack: 0.002, rel: 0.4, pan: -pan, wet: 0.6, dl: 0.4 });
    });
  }
  function play(t) {
    [0.15, 0.62, 1.02, 1.36, 1.64, 1.86].forEach(function (s, i) { thump(t + s, 0.2 + i * 0.04, 62); });
    [0.4, 0.8, 1.2, 1.6].forEach(function (s, i) { wide(t + s, [64, 71, 75, 78, 83], 0.14, { gain: 0.06 + i * 0.012, cut: 1200 + i * 600, cut2: 900 + i * 500, cutT: 0.2, attack: 0.01, rel: 0.5, wet: 0.45, dl: 0.25 }); });
    noise(t + 0.2, 1.8, { type: 'bandpass', f0: 400, f1: 8000, gain: 0.2, attack: 1.75, rel: 0.05, wet: 0.3, q: 1.3 });
    voice(t, mhz(59), 1.9, { gain: 0.1, attack: 1.8, rel: 0.2, wet: 0.2, to: mhz(71) });
    voice(t, mhz(71), 1.9, { type: 'triangle', gain: 0.07, attack: 1.8, rel: 0.2, wet: 0.3, to: mhz(95) });
    arp(t, [78, 83, 87, 90, 95], 1.3, 0.14);
    thump(t + 2.0, 0.6, 50);
    noise(t + 2.0, 0.1, { type: 'lowpass', f0: 3500, f1: 400, gain: 0.35, attack: 0.004, rel: 0.7, wet: 0.4, q: 0.6 });
    noise(t + 2.0, 0.5, { type: 'bandpass', f0: 5000, f1: 600, gain: 0.22, attack: 0.01, rel: 1.0, wet: 0.5, q: 0.8 });
    wide(t + 2.0, [52, 59, 64, 66, 71, 76], 1.6, { gain: 0.07, cut: 2600, cut2: 6500, cutT: 0.4, attack: 0.1, rel: 2.5, wet: 0.6, dl: 0.12 });
    wide(t + 2.0, [64, 71, 75, 78, 83, 88], 1.5, { gain: 0.06, cut: 3200, cut2: 7000, cutT: 0.4, attack: 0.1, rel: 2.4, wet: 0.6, dl: 0.12 });
    arp(t, [83, 87, 90, 95, 99, 102], 2.3, 0.18);
  }
  var played = false;
  window.AuroraSplash = {
    // Plays the opening sound, lined up with the picture (the picture started a moment ago).
    sound: function () {
      if (played) return; played = true;
      try {
        if (!ac && !build()) return;
        var ctx = ac;
        if (ctx.state === 'suspended') ctx.resume();
        var lag = Math.min((performance.now() - born) / 1000, 0.6);
        play(ctx.currentTime + 0.05 - lag);
        // A browser that won't start it before the first tap: give up quietly rather than play it late.
        setTimeout(function () { if (ctx.state === 'suspended') { try { ctx.close(); } catch (e) { /* ignore */ } } }, 1500);
        document.addEventListener('visibilitychange', function () { if (document.hidden) { try { ctx.close(); } catch (e) { /* ignore */ } } }, { once: true });
      } catch (e) { /* no audio support */ }
    },
    // For tests: the sound rendered offline.
    render: function () {
      ac = new OfflineAudioContext(2, 44100 * 7, 44100); setup(); play(0.05);
      return ac.startRendering().then(function (b) { ac = null; return b; });
    },
  };
})();
