"""Render the share image (web/public/og.png, 1200x630) from the map file, so link previews
show the real map rather than a stock picture.

    .venv/bin/python pipeline/og_image.py
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / "web" / "src" / "generated"
OUT = ROOT / "web" / "public" / "og.png"

# Light-mode surface, ink and the six-step amber ramp from styles.css.
SURFACE, INK, INK2 = "#f7f4ee", "#1c1a17", "#5b554c"
TIERS = ["#caa236", "#bb8300", "#a96600", "#914c00", "#753600", "#582400"]


def main():
    raw = (GEN / "map.bin").read_bytes()
    n = len(raw) // 10
    xy = np.frombuffer(raw[: n * 8], dtype="<u2").reshape(4, n)[:2] / 65535
    tier = np.frombuffer(raw[n * 8 : n * 9], dtype="u1")
    pop = np.frombuffer(raw[n * 9 :], dtype="u1")
    order = np.argsort(pop)

    fig = plt.figure(figsize=(12, 6.3), dpi=100, facecolor=SURFACE)
    ax = fig.add_axes([0.53, 0.03, 0.46, 0.94])
    ax.set_facecolor(SURFACE)
    sizes = 1.2 + (pop[order] / 50) ** 2 * 0.9
    ax.scatter(xy[0][order], xy[1][order], s=sizes, c=[TIERS[t] for t in tier[order]], alpha=0.8, linewidths=0)
    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(-0.02, 1.02)
    ax.axis("off")
    plt.rcParams["font.serif"] = ["Iowan Old Style", "Palatino", "Georgia", "DejaVu Serif"]
    top = {"va": "top", "ha": "left"}
    fig.text(0.05, 0.9, "NOSE MAP · A DATA STORY", fontsize=15, color="#914c00", weight="bold", **top)
    fig.text(0.05, 0.8, "How 24,063\nperfumes sort\nthemselves", fontsize=48, color=INK, family="serif",
             linespacing=1.0, **top)
    fig.text(0.05, 0.33, "Islands of peony and oud, musk everywhere,\nclones stacked on clones.", fontsize=16,
             color=INK2, linespacing=1.4, **top)
    fig.text(0.05, 0.12, "Every dot is a perfume, placed by its ingredients.", fontsize=13, color=INK2, **top)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, facecolor=SURFACE)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
