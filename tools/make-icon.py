#!/usr/bin/env python3
"""Erzeugt icon-180.png fuer apple-touch-icon.

iOS akzeptiert fuer den Home-Screen kein SVG, und in dieser Umgebung gibt es
weder PIL noch einen SVG-Konverter. Ein PNG von Hand zu schreiben ist mit zlib
aber ueberschaubar, also passiert das hier: dunkles abgerundetes Quadrat mit
einem blauen Aufwaertspfeil.

Aufruf:  python3 tools/make-icon.py
"""

import struct
import zlib

SIZE = 180
RADIUS = 40
BG = (28, 31, 37)        # --panel
FG = (77, 163, 255)      # --accent
LINE_WIDTH = 13.0

# Polylinie des Pfeils in Bildkoordinaten (y waechst nach unten).
PATH = [(38, 126), (74, 90), (100, 116), (142, 62)]
HEAD = [(142, 62), (142, 96)], [(142, 62), (110, 62)]


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    seg_len_sq = vx * vx + vy * vy
    t = 0.0 if seg_len_sq == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / seg_len_sq))
    dx, dy = wx - t * vx, wy - t * vy
    return (dx * dx + dy * dy) ** 0.5


def inside_rounded_square(x, y):
    for cx, cy in ((RADIUS, RADIUS), (SIZE - RADIUS, RADIUS),
                   (RADIUS, SIZE - RADIUS), (SIZE - RADIUS, SIZE - RADIUS)):
        in_x = (x < RADIUS) if cx == RADIUS else (x > SIZE - RADIUS)
        in_y = (y < RADIUS) if cy == RADIUS else (y > SIZE - RADIUS)
        if in_x and in_y:
            return ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 <= RADIUS
    return True


def coverage(x, y):
    """Anteil des Pfeils an diesem Pixel, grob antialiast ueber die Distanz."""
    segments = list(zip(PATH, PATH[1:])) + [tuple(h) for h in HEAD]
    best = min(dist_to_segment(x, y, a[0], a[1], b[0], b[1]) for a, b in segments)
    edge = LINE_WIDTH / 2
    if best <= edge - 0.5:
        return 1.0
    if best >= edge + 0.5:
        return 0.0
    return edge + 0.5 - best


def build_rows():
    rows = []
    for py in range(SIZE):
        row = bytearray([0])  # Filter 0 (None) pro Zeile
        for px in range(SIZE):
            x, y = px + 0.5, py + 0.5
            if not inside_rounded_square(x, y):
                row += bytes((0, 0, 0, 0))
                continue
            a = coverage(x, y)
            r = round(BG[0] + (FG[0] - BG[0]) * a)
            g = round(BG[1] + (FG[1] - BG[1]) * a)
            b = round(BG[2] + (FG[2] - BG[2]) * a)
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))
    return b''.join(rows)


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def main():
    header = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)  # 8 Bit, RGBA
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', header)
           + chunk(b'IDAT', zlib.compress(build_rows(), 9))
           + chunk(b'IEND', b''))
    with open('icon-180.png', 'wb') as fh:
        fh.write(png)
    print(f'icon-180.png geschrieben ({len(png)} Bytes)')


if __name__ == '__main__':
    main()
