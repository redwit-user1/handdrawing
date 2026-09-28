"""
render.py — 획(stroke) 좌표를 OCR 입력용 줄(line) 이미지로 변환한다.

PaddleOCR 인식 모델은 "글자 한 줄이 담긴 이미지"를 입력으로 받는다. 반면 에디터는
월드 좌표의 획 목록을 보내므로, 여기서
  1) 획들을 줄 단위로 묶고 (세로 겹침 기반 클러스터링)
  2) 줄마다 높이를 정규화해 흰 배경에 검은 선으로 다시 그린다.
원본 펜 굵기·필압은 기기/줌마다 달라 무시하고, 글자 높이에 비례한 고정 굵기로
그린다 — 인식 모델 입장에서 입력 분포가 일정해져 정확도가 안정된다.

모델 의존성이 없는 순수 함수만 두어 단독 테스트가 가능하다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median

from PIL import Image, ImageDraw

# 렌더 파라미터 — PP-OCRv5 인식 모델 입력 높이(48px)보다 크게 그려 축소 시 안티앨리어싱 효과를 얻는다
TEXT_HEIGHT_PX = 64
PAD_Y_PX = 12
PAD_X_PX = 16
STROKE_WIDTH_RATIO = 0.075  # 선 굵기 = 글자 높이 × 비율
MAX_LINE_WIDTH_PX = 3200    # 이보다 긴 줄은 모델 입력 비율이 무너지므로 축소


@dataclass
class Stroke:
    points: list[tuple[float, float]]
    x0: float = field(init=False)
    y0: float = field(init=False)
    x1: float = field(init=False)
    y1: float = field(init=False)

    def __post_init__(self) -> None:
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        self.x0, self.x1 = min(xs), max(xs)
        self.y0, self.y1 = min(ys), max(ys)

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclass
class Line:
    strokes: list[Stroke]
    y0: float
    y1: float

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    def add(self, s: Stroke) -> None:
        self.strokes.append(s)
        self.y0 = min(self.y0, s.y0)
        self.y1 = max(self.y1, s.y1)


def parse_strokes(raw: list[dict]) -> list[Stroke]:
    """요청 JSON의 strokes → Stroke 목록 (점이 없거나 좌표가 깨진 획은 버린다)"""
    out: list[Stroke] = []
    for s in raw:
        pts: list[tuple[float, float]] = []
        for p in s.get("points") or []:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                try:
                    pts.append((float(p[0]), float(p[1])))
                except (TypeError, ValueError):
                    continue
        if pts:
            out.append(Stroke(pts))
    return out


def _overlap_ratio(a0: float, a1: float, b0: float, b1: float) -> float:
    """두 세로 구간의 겹침 / 짧은 쪽 길이 (점 획처럼 높이 0이어도 안전)"""
    inter = min(a1, b1) - max(a0, b0)
    shorter = max(min(a1 - a0, b1 - b0), 1e-6)
    return inter / shorter


def group_lines(strokes: list[Stroke]) -> list[Line]:
    """
    획들을 줄 단위로 묶는다 (위→아래 순서).

    한글은 자모 단위로 획이 잘게 나뉘어(예: 'ㅡ'는 높이가 거의 0) 획 높이만으로
    줄을 판정하면 쪼개진다. 그래서 글자 크기 추정치(획 크기 중앙값)만큼 여유를 둔
    세로 겹침으로 묶고, 마지막에 서로 크게 겹치는 줄을 다시 합친다.
    """
    if not strokes:
        return []
    char_size = median(max(s.x1 - s.x0, s.h) for s in strokes) or 1.0
    slack = char_size * 0.35

    lines: list[Line] = []
    for s in sorted(strokes, key=lambda s: s.cy):
        best, best_r = None, 0.0
        for ln in lines:
            r = _overlap_ratio(s.y0 - slack, s.y1 + slack, ln.y0, ln.y1)
            # 받침처럼 줄 아래로 삐져나온 획: 겹침 비율은 낮아도 중심이 줄 범위 안이면 같은 줄
            if ln.y0 - slack <= s.cy <= ln.y1 + slack:
                r = max(r, 0.5)
            if r > best_r:
                best, best_r = ln, r
        if best is not None and best_r >= 0.5:
            best.add(s)
        else:
            lines.append(Line([s], s.y0, s.y1))

    # 병합 패스: 획 순서 때문에 한 줄이 둘로 갈린 경우를 합친다
    merged = True
    while merged:
        merged = False
        lines.sort(key=lambda l: l.y0)
        for i in range(len(lines) - 1):
            a, b = lines[i], lines[i + 1]
            if _overlap_ratio(a.y0, a.y1, b.y0, b.y1) >= 0.5:
                for s in b.strokes:
                    a.add(s)
                del lines[i + 1]
                merged = True
                break

    # 고아 줄 흡수: 획 몇 개짜리 낮은 줄(떨어진 받침·점 등)은 세로로 가장 가까운 줄에 붙인다.
    # 진짜 한 줄짜리 짧은 메모("7" 등)를 먹지 않도록 가까운 경우에만 합친다.
    if len(lines) > 1:
        med_h = median(l.h for l in lines) or char_size
        for ln in sorted(lines, key=lambda l: l.h):
            if ln not in lines or len(lines) == 1:
                continue
            if ln.h >= med_h * 0.5 or len(ln.strokes) > 3:
                continue
            others = [o for o in lines if o is not ln]
            gap = lambda o: max(o.y0 - ln.y1, ln.y0 - o.y1, 0.0)
            near = min(others, key=gap)
            if gap(near) <= med_h * 0.4:
                for s in ln.strokes:
                    near.add(s)
                lines.remove(ln)
    lines.sort(key=lambda l: l.y0)
    return lines


def render_line(line: Line, ref_height: float) -> Image.Image:
    """
    한 줄을 흰 배경 그레이스케일 이미지로 그린다.

    ref_height: 스케일 기준 글자 높이 — 'ㅡ'만 있는 줄처럼 높이가 비정상적으로
    작은 줄이 과도하게 확대되지 않도록 줄 높이의 하한으로 쓴다.
    """
    xs0 = min(s.x0 for s in line.strokes)
    xs1 = max(s.x1 for s in line.strokes)
    h = max(line.h, ref_height * 0.6, 1e-3)
    scale = TEXT_HEIGHT_PX / h
    width_px = (xs1 - xs0) * scale + PAD_X_PX * 2
    if width_px > MAX_LINE_WIDTH_PX:
        scale *= MAX_LINE_WIDTH_PX / width_px
    text_h = h * scale
    stroke_w = max(2, round(text_h * STROKE_WIDTH_RATIO))

    W = int((xs1 - xs0) * scale + PAD_X_PX * 2 + stroke_w)
    H = int(text_h + PAD_Y_PX * 2 + stroke_w)
    # 줄 높이가 하한으로 보정된 경우 세로 중앙 정렬
    y_off = PAD_Y_PX + (text_h - line.h * scale) / 2

    img = Image.new("L", (max(W, 8), max(H, 8)), 255)
    d = ImageDraw.Draw(img)
    r = stroke_w / 2
    for s in line.strokes:
        pts = [((x - xs0) * scale + PAD_X_PX, (y - line.y0) * scale + y_off) for x, y in s.points]
        if len(pts) > 1:
            d.line(pts, fill=0, width=stroke_w, joint="curve")
        # 둥근 끝점 (점 획 포함)
        for x, y in (pts[0], pts[-1]):
            d.ellipse((x - r, y - r, x + r, y + r), fill=0)
    return img


def strokes_to_line_images(raw_strokes: list[dict]) -> list[Image.Image]:
    """요청 strokes → 위→아래 순서의 줄 이미지 목록"""
    strokes = parse_strokes(raw_strokes)
    lines = group_lines(strokes)
    if not lines:
        return []
    ref_h = median(l.h for l in lines)
    return [render_line(l, ref_h) for l in lines]
