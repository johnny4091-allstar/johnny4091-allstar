// Aurora's opening screen: a jump through space, a flash and shockwave, then the logo settles in with the line
// "Where streaming is possible". Drawn on a canvas, with a synthesised sound (no audio file).
// app.js keeps the screen up long enough (SPLASH_MIN) and fades it out; this file only draws and plays.
// window.AuroraSplash.sound() starts the sound (app.js calls it unless "Sound when Aurora opens" is Off).
(function () {
  'use strict';
  var el = document.getElementById('splash');
  var cv = document.getElementById('splash-cv');
  var born = performance.now();
  var tv = false;
  try { tv = !!(window.EmbyFlixAndroid && window.EmbyFlixAndroid.isTv && window.EmbyFlixAndroid.isTv()); } catch (e) { /* not the Android app */ }
  var still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- the picture ----------
  var MARK = ['M29,40 C40,25 63,22 81,33', 'M38,79 L54,47 L70,79'];
  var WORD = 'M7.0 100 L51.0 15.4 L95.0 100 M155.0 0 V57.0 A36 36 0 0 0 227.0 57.0 V0 M287.0 100 V7.0 H317.0 A24.5 24.5 0 0 1 317.0 56.0 H287.0 M319.0 56.0 L351.0 100 M411.0 50 A43.0 43.0 0 1 0 497.0 50 A43.0 43.0 0 1 0 411.0 50 Z M557.0 100 V7.0 H587.0 A24.5 24.5 0 0 1 587.0 56.0 H557.0 M589.0 56.0 L621.0 100 M681.0 100 L725.0 15.4 L769.0 100';
  var TAG = 'WHERE STREAMING IS POSSIBLE';

  function draw() {
    if (!el || !cv || !cv.getContext || typeof Path2D === 'undefined') return;
    var ctx = cv.getContext('2d');
    var DPR = tv ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0, R = 0, L = null, stars = [];
    var pMark = MARK.map(function (d) { return new Path2D(d); }), pWord = new Path2D(WORD);
    var ease = function (x) { return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3); };
    var clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };
    var rnd = function (a, b) { return a + Math.random() * (b - a); };

    function fit() {
      W = cv.width = Math.max(2, Math.round(el.clientWidth * DPR));
      H = cv.height = Math.max(2, Math.round(el.clientHeight * DPR));
      R = Math.hypot(W, H) / 2;
      var wide = W > H, ww = wide ? W * 0.40 : W * 0.70, sw = ww / 776, mw = ww * 0.30, sm = mw / 62;
      var markH = 64 * sm, wordH = 112 * sw, gap1 = ww * 0.07, gap2 = ww * 0.10, tagH = ww * 0.05;
      var y0 = H * 0.47 - (markH + gap1 + wordH + gap2 + tagH) / 2;
      L = { sw: sw, sm: sm, ww: ww, markY: y0, wordY: y0 + markH + gap1, tagY: y0 + markH + gap1 + wordH + gap2, tagSize: ww * 0.043, cx: W / 2 };
    }
    fit();
    window.addEventListener('resize', fit);
    var N = tv ? 230 : 480;
    for (var i = 0; i < N; i++) stars.push({ a: Math.random() * 6.283, r: Math.random(), v: rnd(0.5, 1.4), h: Math.random() < 0.35 ? 255 : Math.random() < 0.5 ? 185 : 0, l: rnd(0.5, 1) });

    function logo(alpha) {
      ctx.save(); ctx.globalAlpha *= alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
      ctx.save(); ctx.setTransform(L.sm, 0, 0, L.sm, L.cx - 55 * L.sm, L.markY - 20 * L.sm);
      var g = ctx.createLinearGradient(29, 40, 81, 33); g.addColorStop(0, '#2AD4D0'); g.addColorStop(0.55, '#4F7BFF'); g.addColorStop(1, '#7A5CFF');
      ctx.strokeStyle = g; ctx.lineWidth = 3.5; ctx.stroke(pMark[0]);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.stroke(pMark[1]);
      ctx.restore();
      ctx.save(); ctx.setTransform(L.sw, 0, 0, L.sw, L.cx - 388 * L.sw, L.wordY + 6 * L.sw);
      ctx.lineCap = 'butt'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 14; ctx.stroke(pWord);
      ctx.restore(); ctx.restore();
    }
    function tag(t, t0) {
      var size = L.tagSize; ctx.save(); ctx.font = '500 ' + size + 'px Inter, system-ui, sans-serif'; ctx.textBaseline = 'top';
      var sp = size * 0.36, ws = [], tot = 0, k;
      for (k = 0; k < TAG.length; k++) { ws.push(ctx.measureText(TAG[k]).width); tot += ws[k]; }
      tot += sp * (TAG.length - 1);
      var x = L.cx - tot / 2;
      for (k = 0; k < TAG.length; k++) {
        var a = ease((t - t0 - k * 0.045) / 0.6);
        if (a > 0) { ctx.fillStyle = 'rgba(174,185,230,' + a + ')'; ctx.fillText(TAG[k], x, L.tagY + (1 - a) * size * 0.8); }
        x += ws[k] + sp;
      }
      ctx.restore();
    }
    function bar(t) {
      var w = W * (W > H ? 0.30 : 0.46), h = Math.max(2, W * 0.004), x = L.cx - w / 2, y = H * 0.92, p = ease(t / 3.6);
      ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(x, y, w, h);
      var g = ctx.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, '#2ad4d0'); g.addColorStop(0.5, '#4f7bff'); g.addColorStop(1, '#9a6bff');
      ctx.fillStyle = g; if (!tv) { ctx.shadowColor = '#4f7bff'; ctx.shadowBlur = 10 * DPR; }
      ctx.fillRect(x, y, w * p, h); ctx.restore();
    }

    var last = 0;
    function frame(t) {
      var dt = clamp(t - last, 0, 0.05); last = t;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#02030a'; ctx.fillRect(0, 0, W, H);
      var cy = H * 0.47;
      var speed = t < 2 ? 0.15 + 7 * Math.pow(t / 2, 2.4) : 0.35 + Math.max(0, 1.2 - (t - 2) * 1.1);
      ctx.save(); ctx.translate(W / 2, cy); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        s.r += speed * dt * s.v * 0.9 * (0.4 + s.r);
        if (s.r > 1.05) { s.r = Math.random() * 0.08; s.a = Math.random() * 6.283; }
        var len = Math.min(s.r, 0.012 + speed * 0.085 * s.v * (0.3 + s.r));
        var ca = Math.cos(s.a), sa = Math.sin(s.a);
        var al = Math.min(1, clamp(s.r * 2.4, 0, 1) * s.l * 1.25) * (t < 2 ? 1 : 0.7);
        ctx.strokeStyle = s.h ? 'hsla(' + s.h + ',90%,72%,' + al + ')' : 'rgba(255,255,255,' + al + ')';
        ctx.lineWidth = (0.8 + s.r * 2.4) * DPR;
        ctx.beginPath(); ctx.moveTo(ca * (s.r - len) * R, sa * (s.r - len) * R); ctx.lineTo(ca * s.r * R, sa * s.r * R); ctx.stroke();
      }
      ctx.restore();
      var gl = ease(t / 1.9) * (t < 2 ? 1 : Math.max(0, 1 - (t - 2) * 1.4));
      if (gl > 0) {
        var rg = ctx.createRadialGradient(W / 2, cy, 0, W / 2, cy, R * 0.55); rg.addColorStop(0, 'rgba(160,190,255,' + 0.55 * gl + ')'); rg.addColorStop(1, 'rgba(80,120,255,0)');
        ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
      }
      if (t > 1.95) {
        var k = t - 1.95, f = Math.max(0, 1 - k * 3.6);
        if (f > 0) { ctx.fillStyle = 'rgba(255,255,255,' + f * 0.9 + ')'; ctx.fillRect(0, 0, W, H); }
        var rr = ease(k / 1.3) * R * 1.1, ra = Math.max(0, 1 - k / 1.3);
        if (ra > 0) {
          ctx.save(); ctx.lineWidth = Math.max(1, 6 - 4 * k) * DPR; ctx.strokeStyle = 'rgba(140,180,255,' + ra * 0.85 + ')'; ctx.beginPath(); ctx.arc(W / 2, cy, rr, 0, 7); ctx.stroke();
          ctx.lineWidth = 2 * DPR; ctx.strokeStyle = 'rgba(42,212,208,' + ra * 0.6 + ')'; ctx.beginPath(); ctx.arc(W / 2, cy, rr * 0.82, 0, 7); ctx.stroke(); ctx.restore();
        }
      }
      var lg = ease((t - 2.0) / 0.9);
      if (lg > 0) {
        ctx.save(); var sc = 1.16 - 0.16 * lg; ctx.translate(W / 2, cy); ctx.scale(sc, sc); ctx.translate(-W / 2, -cy);
        if (!tv) { ctx.shadowColor = 'rgba(110,150,255,.9)'; ctx.shadowBlur = 24 * DPR * lg; }
        logo(lg); ctx.restore();
      }
      tag(t, 2.8); bar(t);
    }

    if (still) { // reduced motion: just the finished screen
      frame(0.05); frame(6); // reduced motion: draw the finished screen once, no movement
      return;
    }
    function loop(now) {
      if (!el.isConnected) { window.removeEventListener('resize', fit); return; }
      if (!document.hidden) frame(Math.max(0, (now - born) / 1000));
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }
  try { draw(); } catch (e) { /* the screen stays plain dark; the app still starts */ }

  // ---------- the sound: a quickening heartbeat, chord stabs, a rising whoosh, a soft impact, then a wide chord bloom ----------
  var ac = null, master = null, verb = null, dly = null;
  var mhz = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
  function build() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ac = new AC(); master = ac.createGain(); master.gain.value = 0.8; master.connect(ac.destination);
    var n = Math.floor(ac.sampleRate * 2.6), buf = ac.createBuffer(2, n, ac.sampleRate), c, i;
    for (c = 0; c < 2; c++) { var d = buf.getChannelData(c); for (i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.4); }
    verb = ac.createConvolver(); verb.buffer = buf; var vo = ac.createGain(); vo.gain.value = 0.55; verb.connect(vo); vo.connect(master);
    dly = ac.createGain(); var dl = ac.createDelay(1), dr = ac.createDelay(1), fb = ac.createGain(), mg = ac.createChannelMerger(2), lp = ac.createBiquadFilter();
    dl.delayTime.value = 0.27; dr.delayTime.value = 0.405; fb.gain.value = 0.36; lp.type = 'lowpass'; lp.frequency.value = 4600;
    dly.connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl); dl.connect(mg, 0, 0); dr.connect(mg, 0, 1); mg.connect(lp); lp.connect(master);
    return true;
  }
  function voice(t, freq, dur, o) {
    o = o || {};
    var type = o.type || 'sine', gain = o.gain == null ? 0.15 : o.gain, attack = o.attack == null ? 0.01 : o.attack, rel = o.rel == null ? 0.8 : o.rel;
    var osc = ac.createOscillator(), g = ac.createGain(), pn = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t); if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur); osc.detune.value = o.detune || 0;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.setValueAtTime(gain, t + Math.max(attack, dur)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + rel);
    var node = osc;
    if (o.cut) { var f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(o.cut, t); if (o.cut2) f.frequency.exponentialRampToValueAtTime(o.cut2, t + (o.cutT || 1)); f.Q.value = 0.8; osc.connect(f); node = f; }
    node.connect(g); g.connect(pn); if (pn.pan) pn.pan.value = o.pan || 0; pn.connect(master);
    if (o.wet == null ? true : o.wet) { var w = ac.createGain(); w.gain.value = o.wet == null ? 0.5 : o.wet; pn.connect(w); w.connect(verb); }
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
      voice(t + start + i * gap, mhz(m), 0.04, { type: 'triangle', gain: 0.1, attack: 0.003, rel: 0.55, pan: pan, wet: 0.45, dl: 0.5, cut: 5200, cut2: 1200, cutT: 0.4 });
      voice(t + start + i * gap, mhz(m + 12), 0.03, { type: 'sine', gain: 0.045, attack: 0.002, rel: 0.4, pan: -pan, wet: 0.6, dl: 0.4 });
    });
  }
  function play(t) {
    [0.15, 0.62, 1.02, 1.36, 1.64, 1.86].forEach(function (s, i) { voice(t + s, 52, 0.12, { gain: 0.12 + i * 0.03, to: 38, attack: 0.004, rel: 0.35, wet: 0.1 }); });
    [0.4, 0.8, 1.2, 1.6].forEach(function (s, i) { wide(t + s, [52, 59, 63, 66, 71], 0.14, { gain: 0.04 + i * 0.008, cut: 900 + i * 500, cut2: 700 + i * 400, cutT: 0.2, attack: 0.01, rel: 0.5, wet: 0.45, dl: 0.25 }); });
    noise(t + 0.2, 1.8, { type: 'bandpass', f0: 300, f1: 7000, gain: 0.1, attack: 1.75, rel: 0.05, wet: 0.3, q: 1.3 });
    voice(t, mhz(47), 1.9, { gain: 0.1, attack: 1.8, rel: 0.2, wet: 0.2, to: mhz(59) });
    arp(t, [78, 83, 87, 90, 95], 1.3, 0.14);
    voice(t + 2.0, 48, 0.4, { gain: 0.36, to: 34, attack: 0.004, rel: 1, wet: 0.15 });
    noise(t + 2.0, 0.1, { type: 'lowpass', f0: 3000, f1: 300, gain: 0.22, attack: 0.004, rel: 0.7, wet: 0.4, q: 0.6 });
    wide(t + 2.0, [40, 52, 59, 63, 66, 71, 76], 1.6, { gain: 0.05, cut: 2600, cut2: 6500, cutT: 0.4, attack: 0.1, rel: 2.5, wet: 0.6, dl: 0.12 });
    arp(t, [83, 87, 90, 95, 99, 102], 2.3, 0.18);
  }
  var played = false;
  window.AuroraSplash = {
    // Plays the opening sound, lined up with the picture (the picture started a moment ago).
    sound: function () {
      if (played) return; played = true;
      try {
        if (!ac && !build()) return;
        if (ac.state === 'suspended') ac.resume();
        // Not allowed to start yet (a browser before the first tap): stay quiet rather than play late.
        if (ac.state !== 'running') { var w = ac; setTimeout(function () { if (w.state !== 'running') try { w.close(); } catch (e) { /* ignore */ } }, 600); }
        var lag = Math.min((performance.now() - born) / 1000, 0.6);
        play(ac.currentTime + 0.05 - lag);
        document.addEventListener('visibilitychange', function () { if (document.hidden && ac) try { ac.close(); } catch (e) { /* ignore */ } }, { once: true });
      } catch (e) { /* no audio support */ }
    },
  };
})();
