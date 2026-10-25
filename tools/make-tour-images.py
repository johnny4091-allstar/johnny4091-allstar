#!/usr/bin/env python3
"""Draws the small images the Roku guided tour uses (the arrow in four directions and two gradient strips).

Roku's SceneGraph has no vector shapes, so the tour's arrow is a tiny bundled image, drawn here with plain
Python (no libraries) in Aurora's gradient. Run it from the repository root: python3 tools/make-tour-images.py
"""
import struct, zlib, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'roku', 'images')
STOPS = [(0.0, (0x18, 0xB6, 0xD6)), (0.55, (0x4F, 0x7B, 0xFF)), (1.0, (0x7A, 0x5C, 0xFF))]  # the aurora gradient


def grad(t):
    t = max(0.0, min(1.0, t))
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(c0[i] + (c1[i] - c0[i]) * f for i in range(3))
    return STOPS[-1][1]


def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + bytes(v for px in row for v in px) for row in rows)
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def inside(x, y, poly):
    n, hit = len(poly), False
    for i in range(n):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def arrow_up(w=56, h=104):
    """An arrow pointing up: the tip is the middle pixel of the top row, the tail fades out at the bottom."""
    cx, head, shaft = w / 2, 44, 12
    poly_head = [(cx, 0), (w, head), (0, head)]
    poly_shaft = [(cx - shaft / 2, head - 4), (cx + shaft / 2, head - 4), (cx + shaft / 2, h), (cx - shaft / 2, h)]
    S = 4
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            cov = 0
            for sy in range(S):
                for sx in range(S):
                    px, py = x + (sx + .5) / S, y + (sy + .5) / S
                    if inside(px, py, poly_head) or inside(px, py, poly_shaft):
                        cov += 1
            a = cov / (S * S)
            r, g, b = grad(1 - y / (h - 1))  # violet at the tip, cyan at the tail
            tail = 1.0 if y < h * 0.45 else 1.0 - 0.7 * (y - h * 0.45) / (h * 0.55)
            row.append((int(r), int(g), int(b), int(255 * a * tail)))
        rows.append(row)
    return w, h, rows


def rotate(w, h, rows, turns):
    for _ in range(turns):  # a quarter turn clockwise
        rows = [[rows[h - 1 - x][y] for x in range(h)] for y in range(w)]
        w, h = h, w
    return w, h, rows


def main():
    w, h, up = arrow_up()
    for name, turns in (('up', 0), ('right', 1), ('down', 2), ('left', 3)):
        write_png(os.path.join(OUT, f'tour_arrow_{name}.png'), *rotate(w, h, up, turns))
    write_png(os.path.join(OUT, 'tour_grad_h.png'), 256, 4, [[tuple(int(v) for v in grad(x / 255)) + (255,) for x in range(256)] for _ in range(4)])
    write_png(os.path.join(OUT, 'tour_grad_v.png'), 4, 256, [[tuple(int(v) for v in grad(y / 255)) + (255,)] * 4 for y in range(256)])


if __name__ == '__main__':
    main()
