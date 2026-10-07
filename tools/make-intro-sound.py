# Builds the Aurora intro sound (aurora/sounds/aurora-intro.mp3) from scratch: original synthesis, no samples.
#   python3 tools/make-intro-sound.py <work-dir>     (needs ffmpeg with libmp3lame)
# Timed to the splash animation: streak sweep 0.15-0.9s, wordmark lands at 0.9s.
import math, os, random, struct, subprocess, sys, wave

SR = 48000
DUR = 3.6
N = int(SR * DUR)
HIT = 0.9           # when the wordmark lands
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
random.seed(2024)
TAU = 2 * math.pi

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def zeros(): return [0.0] * N

def write_wav(path, L, R, gain=1.0):
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        clip = lambda v: max(-32767, min(32767, int(v * gain * 32767)))
        w.writeframes(b''.join(struct.pack('<hh', clip(l), clip(r)) for l, r in zip(L, R)))

def pan_gains(p):  # equal-power, p in -1..1
    a = (p + 1) * math.pi / 4
    return math.cos(a), math.sin(a)

class SVF:  # TPT state-variable filter (Zavalishin); modulatable cutoff
    def __init__(self, q=0.7): self.ic1 = self.ic2 = 0.0; self.k = 1 / q
    def process(self, x, fc):
        g = math.tan(math.pi * min(fc, SR * 0.45) / SR)
        a1 = 1 / (1 + g * (g + self.k)); a2 = g * a1; a3 = g * a2
        v3 = x - self.ic2; v1 = a1 * self.ic1 + a2 * v3; v2 = self.ic2 + a2 * self.ic1 + a3 * v3
        self.ic1 = 2 * v1 - self.ic1; self.ic2 = 2 * v2 - self.ic2
        return v2, v1  # low, band

def polyblep(t, dt):
    if t < dt: t /= dt; return t + t - t * t - 1
    if t > 1 - dt: t = (t - 1) / dt; return t * t + t + t + 1
    return 0.0

# ---------- 1. Riser: resonant filtered-noise whoosh sweeping up and left->right into the hit ----------
def riser(L, R):
    f = SVF(q=2.2)
    start, end = int(0.05 * SR), int(HIT * SR)
    for i in range(start, end + int(0.12 * SR)):
        t = (i - start) / (end - start)
        x = random.random() * 2 - 1
        if i < end:
            env = t ** 2.2
            fc = 300 * (9000 / 300) ** (t ** 1.5)
        else:  # quick choke after the hit
            env = math.exp(-(i - end) / SR * 40); fc = 9000
        _, bp = f.process(x, fc)
        gl, gr = pan_gains(-0.6 + 1.2 * min(t, 1))
        v = bp * env * 0.22
        L[i] += v * gl; R[i] += v * gr

# ---------- 2. Shimmer: FM bells (DX-style) rising with the streak ----------
def fm_bell(L, R, t0, midi, pan, amp):
    fc = hz(midi); s0 = int(t0 * SR); n = min(int(2.6 * SR), N - s0)
    gl, gr = pan_gains(pan)
    detune = 1.0015
    for i in range(n):
        t = i / SR
        idx = 3.2 * math.exp(-t * 5)
        env = (1 - math.exp(-t * 900)) * (math.exp(-t * 2.0) * 0.85 + math.exp(-t * 9) * 0.15) * min(1.0, (n - i) / (0.3 * SR))
        a = math.sin(TAU * fc * t + idx * math.sin(TAU * fc * 3.5 * t))
        b = math.sin(TAU * fc * detune * t + idx * math.sin(TAU * fc * detune * 3.5 * t) + 1.1)
        L[s0 + i] += a * env * amp * gl
        R[s0 + i] += b * env * amp * gr

# ---------- 3. Impact chord: filtered supersaw stack (Dadd9) opening on the hit ----------
def supersaw_note(L, R, midi, amp, spread, cutoff_peak):
    voices = [(-0.11, -1), (-0.06, -0.6), (-0.02, -0.25), (0, 0), (0.02, 0.25), (0.06, 0.6), (0.11, 1)]
    s0 = int((HIT - 0.01) * SR); n = N - s0
    phases = [random.random() for _ in voices]
    incs = [hz(midi + c * spread) / SR for c, _ in voices]
    pans = [pan_gains(p * 0.9) for _, p in voices]
    fl, fr = SVF(q=0.9), SVF(q=0.9)
    for i in range(n):
        t = i / SR
        env = (1 - math.exp(-t * 180)) * math.exp(-t * 0.95)
        fc = 180 + cutoff_peak * math.exp(-t * 2.4) * (1 - math.exp(-t * 60))
        sl = sr = 0.0
        for k in range(7):
            ph = phases[k]; dt = incs[k]
            v = 2 * ph - 1 - polyblep(ph, dt)
            ph += dt
            if ph >= 1: ph -= 1
            phases[k] = ph
            sl += v * pans[k][0]; sr += v * pans[k][1]
        lo_l, _ = fl.process(sl / 4, fc); lo_r, _ = fr.process(sr / 4, fc)
        L[s0 + i] += lo_l * env * amp; R[s0 + i] += lo_r * env * amp

# ---------- 4. Sub drop and transient ----------
def sub_and_click(L, R):
    s0 = int(HIT * SR); ph = 0.0
    n = int(1.8 * SR)
    for i in range(n):
        t = i / SR
        f = 38 + 62 * math.exp(-t * 9)
        ph += f / SR
        env = (1 - math.exp(-t * 400)) * math.exp(-t * 2.3) * min(1.0, (n - i) / (0.4 * SR))
        v = math.tanh(1.6 * math.sin(TAU * ph)) * env * 0.55
        L[s0 + i] += v; R[s0 + i] += v
    f = SVF(q=0.8)
    for i in range(int(0.06 * SR)):  # short bright transient
        t = i / SR
        lo, bp = f.process(random.random() * 2 - 1, 3500)
        v = bp * math.exp(-t * 90) * 0.35
        L[s0 + i] += v; R[s0 + i] += v

# ---------- 5. Air pad: soft high chord that blooms after the hit ----------
def air_pad(L, R):
    s0 = int((HIT + 0.05) * SR)
    notes = [(81, -0.5), (85, 0.5), (88, -0.2), (90, 0.25)]  # A5 C#6 E6 F#6
    for midi, p in notes:
        gl, gr = pan_gains(p); f = hz(midi)
        for i in range(N - s0):
            t = i / SR
            env = (1 - math.exp(-t * 3.5)) * math.exp(-t * 1.1) * 0.045
            trem = 1 + 0.12 * math.sin(TAU * 5.2 * t + midi)
            v = (math.sin(TAU * f * t) + 0.2 * math.sin(TAU * f * 2.001 * t)) * env * trem
            L[s0 + i] += v * gl; R[s0 + i] += v * gr

# ---------- Reverb impulse: decorrelated stereo noise, ~2.4 s, darkening as it decays ----------
def make_ir(path):
    n = int(2.6 * SR); pre = int(0.018 * SR)
    chans = []
    for ch in range(2):
        out = [0.0] * n; lp = 0.0; hp_prev_in = hp_prev_out = 0.0
        hp_a = 1 / (1 + TAU * 120 / SR)                    # ~120 Hz high-pass keeps the tail clean
        for i in range(pre, n):
            t = (i - pre) / SR
            coef = 0.9 * math.exp(-t * 1.4) + 0.06          # brighter early, darker late
            lp += coef * ((random.random() * 2 - 1) - lp)
            hp = hp_a * (hp_prev_out + lp - hp_prev_in); hp_prev_in, hp_prev_out = lp, hp
            out[i] = hp * math.exp(-t * 6.9 / 2.4) * (1 - math.exp(-t * 300))
        chans.append(out)
    peak = max(max(abs(v) for v in c) for c in chans)
    write_wav(path, chans[0], chans[1], 0.9 / peak)

L, R = zeros(), zeros()
riser(L, R)
arp = [(74, -0.35), (78, -0.21), (81, -0.07), (85, 0.07), (86, 0.21), (90, 0.35)]  # D5 F#5 A5 C#6 D6 F#6
for k, (m, p) in enumerate(arp):
    fm_bell(L, R, 0.15 + k * 0.12, m, p, 0.10 - k * 0.006)
chord = [(38, 0.30, 0.10, 2200), (45, 0.20, 0.12, 2600), (50, 0.17, 0.14, 3200), (54, 0.12, 0.15, 3800), (57, 0.10, 0.16, 4200), (64, 0.07, 0.18, 5200)]
for m, a, sp, cp in chord:
    supersaw_note(L, R, m, a, sp, cp)
sub_and_click(L, R)
air_pad(L, R)

# Gentle bus saturation and a smooth fade at the end.
fade = int(0.6 * SR)
for i in range(N):
    g = 1.0 if i < N - fade else math.cos((i - (N - fade)) / fade * math.pi / 2) ** 2
    L[i] = math.tanh(L[i] * 0.9) * g; R[i] = math.tanh(R[i] * 0.9) * g

dry, ir = os.path.join(OUT, 'dry.wav'), os.path.join(OUT, 'ir.wav')
peak = max(max(abs(v) for v in L), max(abs(v) for v in R))
write_wav(dry, L, R, 0.7 / peak)
make_ir(ir)

# Mix in the convolution reverb, then master: clean lows, tame mud, add air, glue, limit, set loudness.
master = os.path.join(OUT, 'master.wav')
chain = ("[0:a]asplit=2[d][s];[s][1:a]afir=dry=1:wet=1[w];"
         "[d][w]amix=inputs=2:weights='1 0.55':normalize=0,"
         "highpass=f=28,equalizer=f=320:t=q:w=1.1:g=-2.5,equalizer=f=3200:t=q:w=1.5:g=1,"
         "treble=g=2.5:f=9000,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180:makeup=2,"
         "alimiter=limit=0.8:attack=2:release=60,loudnorm=I=-18:TP=-1.5:LRA=11,atrim=end=3.6,afade=t=out:st=3.15:d=0.45")
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', dry, '-i', ir, '-filter_complex', chain,
                '-ar', '48000', master], check=True)
mp3 = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'aurora', 'sounds', 'aurora-intro.mp3')
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-c:a', 'libmp3lame', '-b:a', '192k', mp3], check=True)
print('wrote', os.path.normpath(mp3))
