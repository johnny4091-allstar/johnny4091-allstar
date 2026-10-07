# Regenerates aurora/sounds/aurora-intro.mp3: python3 tools/make-intro-sound.py intro.wav, then
# ffmpeg -i intro.wav -c:a libmp3lame -b:a 128k aurora/sounds/aurora-intro.mp3
# Aurora intro sound: an original synthesized sting timed to the splash animation.
import math, random, struct, wave, sys
SR = 44100
DUR = 2.9
N = int(SR * DUR)
L = [0.0] * N; R = [0.0] * N
random.seed(7)
def hz(note):  # MIDI note -> Hz
    return 440.0 * 2 ** ((note - 69) / 12)
def add(t0, dur, fn, pan=0.0, gain=1.0):
    s0 = int(t0 * SR); n = min(int(dur * SR), N - s0)
    gl = gain * math.cos((pan + 1) * math.pi / 4); gr = gain * math.sin((pan + 1) * math.pi / 4)
    for i in range(n):
        v = fn(i / SR)
        L[s0 + i] += v * gl; R[s0 + i] += v * gr

# 1) Pad swell under everything (D + A, slightly detuned), slow attack.
def pad(f):
    def fn(t):
        env = min(1, t / 0.7) * (1 if t < 1.3 else math.exp(-(t - 1.3) * 1.6))
        v = sum(math.sin(2 * math.pi * f * d * t + ph) for d, ph in ((1, 0), (1.004, 1.3), (0.996, 2.1)))
        v += 0.25 * math.sin(2 * math.pi * f * 2 * t)
        return env * v / 3.25
    return fn
add(0.0, 2.9, pad(hz(50)), -0.2, 0.16)   # D3
add(0.0, 2.9, pad(hz(57)), 0.2, 0.12)    # A3

# 2) Shimmer: rising bell arpeggio sweeping left to right with the streak.
def bell(f, decay=2.2):
    def fn(t):
        env = (1 - math.exp(-t * 400)) * math.exp(-t * decay)
        return env * (math.sin(2 * math.pi * f * t) + 0.35 * math.sin(2 * math.pi * f * 2.0 * t) * math.exp(-t * 4)
                      + 0.12 * math.sin(2 * math.pi * f * 3.01 * t) * math.exp(-t * 7))
    return fn
arp = [74, 78, 81, 85, 88, 90]  # D5 F#5 A5 C#6 E6 F#6 (D major 9 colour)
for k, note in enumerate(arp):
    t0 = 0.15 + k * 0.13
    add(t0, 2.0, bell(hz(note)), -0.7 + 1.4 * k / (len(arp) - 1), 0.17 - k * 0.012)

# 3) The landing as the wordmark rises: warm chord + soft low thump.
def warm(f):
    def fn(t):
        env = (1 - math.exp(-t * 60)) * math.exp(-t * 1.5)
        return env * (math.sin(2 * math.pi * f * t) + 0.3 * math.sin(2 * math.pi * f * 2 * t) * math.exp(-t * 3))
    return fn
for note, pan, g in ((38, 0, .17), (45, -.3, .12), (50, .3, .14), (54, -.15, .10), (57, .15, .08), (62, 0, .06)):
    add(0.9, 2.0, warm(hz(note)), pan, g)
def thump(t):
    f = 70 * math.exp(-t * 6) + 38
    return math.sin(2 * math.pi * f * t) * math.exp(-t * 7) * (1 - math.exp(-t * 300))
add(0.9, 1.0, thump, 0, 0.28)

# 4) A breath of airy noise rising into the landing.
def air(t):
    env = (t / 0.75) ** 2 * (1 if t < 0.75 else 0)
    return env * (random.random() * 2 - 1)
lp = [0.0, 0.0]
def airfilt(t, st={'a': 0.0}):
    st['a'] += 0.08 * (air(t) - st['a'])
    return st['a']
add(0.15, 0.75, airfilt, 0, 0.05)

# Simple Schroeder reverb for space.
def reverb(x, combs, aps, mix=0.28):
    out = [0.0] * len(x)
    for d, g in combs:
        buf = [0.0] * d; idx = 0
        for i in range(len(x)):
            y = buf[idx]; buf[idx] = x[i] + y * g; idx = (idx + 1) % d
            out[i] += y / len(combs)
    for d, g in aps:
        buf = [0.0] * d; idx = 0
        for i in range(len(out)):
            b = buf[idx]; y = -out[i] * g + b
            buf[idx] = out[i] + b * g; idx = (idx + 1) % d
            out[i] = y
    return [a * (1 - mix) + b * mix * 2.2 for a, b in zip(x, out)]
L = reverb(L, [(1557, .84), (1617, .84), (1491, .84), (1422, .84)], [(225, .5), (556, .5)])
R = reverb(R, [(1580, .84), (1640, .84), (1514, .84), (1445, .84)], [(248, .5), (579, .5)])

# Fade the tail and normalise to a gentle level (peak -4 dBFS).
fade = int(0.5 * SR)
for i in range(fade):
    g = (1 - i / fade) ** 2; L[N - fade + i] *= g; R[N - fade + i] *= g
peak = max(max(abs(v) for v in L), max(abs(v) for v in R))
k = 10 ** (-5 / 20) / peak
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<hh', int(l * k * 32767), int(r * k * 32767)) for l, r in zip(L, R)))
print('ok', DUR, 's')
