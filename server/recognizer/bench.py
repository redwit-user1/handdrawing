"""
bench.py — 합성 손글씨 획으로 인식 서버 정확도(CER)를 측정한다.

실제 태블릿 필기 데이터 없이도 파이프라인 전체(획 좌표 → 서버 렌더 → OCR)를
검증하기 위해, 손글씨 폰트로 문장을 그린 뒤 골격화(skeletonize)해 한 픽셀 굵기의
중심선을 펜 획(점 목록)으로 추적한다. 글자마다 크기·기울기·기준선을 흔들어
손으로 쓴 것처럼 불규칙하게 만든다.

    pip install scikit-image fonttools requests
    python bench.py --font-dir ./fonts --url http://localhost:8765/recognize

--font-dir: 손글씨 TTF 폴더. 웹폰트처럼 유니코드 범위별로 쪼개진 파일들도 되며,
            글자마다 해당 글리프를 가진 파일을 골라 쓴다.
"""
from __future__ import annotations

import argparse
import glob
import json
import random
import time
import urllib.request

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
from skimage.morphology import skeletonize

SAMPLES = [
    ["시료 A 온도 25도 측정"],
    ["반응 시간 30분", "수율 82%"],
    ["완충액 pH 7.4 준비"],
    ["원심분리 3000rpm 10분"],
    ["결과 양호 재현성 확인"],
    ["샘플 3번 흡광도 0.52"],
    ["세포 배양 2일차", "배지 교체 완료"],
    ["실험 노트 작성자 김연구"],
]


class FontSet:
    """글리프를 가진 폰트 파일을 글자마다 찾아 준다 (범위별 분할 웹폰트 대응)"""

    def __init__(self, font_dir: str, px: int) -> None:
        self.fonts = []
        for path in sorted(glob.glob(f"{font_dir}/**/*.ttf", recursive=True)):
            cmap = TTFont(path, lazy=True).getBestCmap() or {}
            self.fonts.append((set(cmap), ImageFont.truetype(path, px)))
        if not self.fonts:
            raise SystemExit(f"TTF 없음: {font_dir}")

    def for_char(self, ch: str):
        for cps, font in self.fonts:
            if ord(ch) in cps:
                return font
        return None


def trace_skeleton(sk: np.ndarray, step: int = 2) -> list[list[tuple[int, int]]]:
    """1픽셀 골격 → 폴리라인 목록 (끝점에서 출발해 이웃을 따라 걷는 단순 추적)"""
    ys, xs = np.nonzero(sk)
    pix = set(zip(xs.tolist(), ys.tolist()))
    nbrs = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

    def neigh(p):
        return [(p[0] + dx, p[1] + dy) for dx, dy in nbrs if (p[0] + dx, p[1] + dy) in pix]

    visited: set = set()
    starts = sorted(pix, key=lambda p: len(neigh(p)))  # 끝점(이웃 1개) 우선
    paths = []
    for s in starts:
        if s in visited:
            continue
        # 이미 그린 픽셀에서 갈라지는 가지는 그 픽셀부터 이어 그려 틈을 없앤다
        joint = [n for n in neigh(s) if n in visited]
        path = ([joint[0]] if joint else []) + [s]
        visited.add(s)
        cur = s
        while True:
            nxt = [n for n in neigh(cur) if n not in visited]
            if not nxt:
                break
            cur = nxt[0]
            visited.add(cur)
            path.append(cur)
        # 점(마침표·소수점)은 한 픽셀 골격 → 점 1개짜리 획으로 보낸다 (탭으로 찍은 점과 동일)
        paths.append(path[::step] + [path[-1]] if len(path) >= 2 else path)
    return paths


def synth_strokes(lines: list[str], fonts: FontSet, rng: random.Random) -> list[dict]:
    """문장들 → 손글씨 흉내 획 목록 (월드 좌표)"""
    px, line_gap = 72, 110
    strokes: list[dict] = []
    for li, text in enumerate(lines):
        x = 20
        base_y = 20 + li * line_gap
        for ch in text:
            if ch == " ":
                x += px * rng.uniform(0.35, 0.5)
                continue
            font = fonts.for_char(ch)
            if font is None:
                continue
            size = px * 2
            glyph = Image.new("L", (size, size), 0)
            ImageDraw.Draw(glyph).text((px // 2, px // 3), ch, font=font, fill=255)
            glyph = glyph.rotate(rng.uniform(-6, 6), resample=Image.BICUBIC)
            scale = rng.uniform(0.9, 1.1)
            glyph = glyph.resize((int(size * scale), int(size * scale)))
            arr = np.asarray(glyph) > 100
            bbox = np.argwhere(arr)
            if bbox.size == 0:
                continue
            (gy0, gx0), (gy1, gx1) = bbox.min(0), bbox.max(0)
            dy = rng.uniform(-5, 5)
            for path in trace_skeleton(skeletonize(arr)):
                strokes.append({
                    "points": [[round(float(x + px_ - gx0), 2), round(float(base_y + dy + py), 2)]
                               for px_, py in path]
                })
            x += (gx1 - gx0) + px * rng.uniform(0.06, 0.14)
    return strokes


def cer(ref: str, hyp: str) -> float:
    """문자 오류율 = 편집거리 / 정답 길이 (공백·줄바꿈 무시)"""
    r = ref.replace(" ", "").replace("\n", "")
    h = hyp.replace(" ", "").replace("\n", "")
    d = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hc in enumerate(h, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (rc != hc))
    return d[len(h)] / max(len(r), 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--font-dir", required=True)
    ap.add_argument("--url", default="http://localhost:8765/recognize")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--dump", help="첫 샘플 요청 JSON을 이 경로에 저장 (수동 재현용)")
    args = ap.parse_args()

    fonts = FontSet(args.font_dir, 72)
    rng = random.Random(args.seed)
    total, ms = 0.0, []
    for i, lines in enumerate(SAMPLES):
        body = {"languages": ["ko", "en"], "strokes": synth_strokes(lines, fonts, rng)}
        if i == 0 and args.dump:
            with open(args.dump, "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False)
        req = urllib.request.Request(
            args.url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
        )
        t = time.time()
        with urllib.request.urlopen(req) as res:
            out = json.load(res)
        ms.append((time.time() - t) * 1000)
        ref = "\n".join(lines)
        e = cer(ref, out["text"])
        total += e
        print(f"[{'OK ' if e == 0 else 'ERR'}] CER {e:5.1%}  획 {len(body['strokes']):4d}  "
              f"{ms[-1]:6.0f}ms  정답={ref!r}  인식={out['text']!r}")
    print(f"\n평균 CER {total / len(SAMPLES):.1%} · 평균 응답 {sum(ms) / len(ms):.0f}ms (샘플 {len(SAMPLES)}개)")


if __name__ == "__main__":
    main()
