# Builds the Aurora intro sound (aurora/sounds/aurora-intro.mp3) from scratch: original synthesis, no samples.
#   python3 tools/make-intro-sound.py <work-dir>     (needs ffmpeg with libmp3lame)
# A soft, warm swell: a mellow pad rises with the streak, and a gentle electric-piano chord settles in
# as the wordmark lands at 0.9 s. Kept deliberately quiet and smooth.
import math, os, random, struct, subprocess, sys, wave

SR = 48000
DUR = 3.2
N = int(SR * DUR)
HIT = 0.9
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
random.seed(11)
TAU = 2 * math.pi

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def write_wav(path, L, R, gain=1.0):
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        clip = lambda v: max(-32767, min(32767, int(v * gain * 32767)))
        w.writeframes(b''.join(struct.pack('<hh', clip(l), clip(r)) for l, r in zip(L, R)))

def pan_gains(p):
    a = (p + 1) * math.pi / 4
    return math.cos(a), math.sin(a)

def smooth_end(i, n, secs):
    return min(1.0, (n - i) / (secs * SR))

L = [0.0] * N; R = [0.0] * N

# 1. Warm pad: soft sine voices, slightly detuned left/right for width, swelling in over ~0.9 s.
pad = [(50, 0.0, 0.20), (57, -0.25, 0.14), (62, 0.25, 0.10), (66, 0.0, 0.07)]   # D3 A3 D4 F#4
for midi, p, amp in pad:
    f = hz(midi); gl, gr = pan_gains(p)
    for i in range(N):
        t = i / SR
        swell = 0.5 - 0.5 * math.cos(math.pi * min(t / 1.0, 1))           # smooth S-curve in
        env = swell * (1 if t < 1.3 else math.exp(-(t - 1.3) * 1.3)) * smooth_end(i, N, 0.4)
        l = math.sin(TAU * f * 0.998 * t) + 0.18 * math.sin(TAU * f * 2 * t)
        r = math.sin(TAU * f * 1.002 * t + 0.7) + 0.18 * math.sin(TAU * f * 2 * t + 0.3)
        L[i] += l * env * amp * gl; R[i] += r * env * amp * gr

# 2. Soft electric-piano chord on the landing (gentle FM, rounded attack), plus a quiet low D.
def epiano(midi, amp, pan, delay):
    f = hz(midi); gl, gr = pan_gains(pan)
    s0 = int((HIT + delay) * SR); n = N - s0
    for i in range(n):
        t = i / SR
        idx = 0.9 * math.exp(-t * 3)                                       # a little tone, mellowing fast
        env = (1 - math.exp(-t * 120)) * math.exp(-t * 1.25) * smooth_end(i, n, 0.4)
        v = math.sin(TAU * f * t + idx * math.sin(TAU * f * t))
        L[s0 + i] += v * env * amp * gl; R[s0 + i] += v * env * amp * gr
for midi, amp, pan, d in ((38, 0.20, 0.0, 0.0), (62, 0.13, -0.2, 0.0), (66, 0.10, 0.1, 0.02), (69, 0.09, 0.25, 0.04), (76, 0.05, 0.0, 0.06)):
    epiano(midi, amp, pan, d)   # D2, D4 F#4 A4 E5 (a softly rolled Dadd9)

# Soft fade at the very end.
fade = int(0.5 * SR)
for i in range(N - fade, N):
    g = math.cos((i - (N - fade)) / fade * math.pi / 2) ** 2
    L[i] *= g; R[i] *= g

# Small, dark room reverb impulse (~1.4 s).
def make_ir(path):
    n = int(1.6 * SR); pre = int(0.012 * SR); chans = []
    for ch in range(2):
        out = [0.0] * n; lp = 0.0; hpi = hpo = 0.0; a = 1 / (1 + TAU * 150 / SR)
        for i in range(pre, n):
            t = (i - pre) / SR
            lp += 0.25 * ((random.random() * 2 - 1) - lp)                  # dark
            hp = a * (hpo + lp - hpi); hpi, hpo = lp, hp
            out[i] = hp * math.exp(-t * 6.9 / 1.4) * (1 - math.exp(-t * 200))
        chans.append(out)
    peak = max(max(abs(v) for v in c) for c in chans)
    write_wav(path, chans[0], chans[1], 0.9 / peak)

dry, ir, master = (os.path.join(OUT, x) for x in ('dry.wav', 'ir.wav', 'master.wav'))
peak = max(max(abs(v) for v in L), max(abs(v) for v in R))
write_wav(dry, L, R, 0.6 / peak)
make_ir(ir)

# Light reverb, roll off anything harsh, keep it quiet (-23 LUFS, peaks well below full scale).
chain = ("[0:a]asplit=2[d][s];[s][1:a]afir=dry=1:wet=1[w];[d][w]amix=inputs=2:weights='1 0.3':normalize=0,"
         "highpass=f=40,lowpass=f=7000,equalizer=f=250:t=q:w=1:g=-2,"
         "loudnorm=I=-23:TP=-4:LRA=11,atrim=end=3.2,afade=t=out:st=2.8:d=0.4")
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', dry, '-i', ir, '-filter_complex', chain, '-ar', '48000', master], check=True)
mp3 = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'aurora', 'sounds', 'aurora-intro.mp3')
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-c:a', 'libmp3lame', '-b:a', '192k', mp3], check=True)
print('wrote', os.path.normpath(mp3))
