"""render.py 단위 테스트 — 모델 없이 실행된다: python -m pytest -q"""
from render import group_lines, parse_strokes, strokes_to_line_images


def box(x0, y0, x1, y1):
    """사각 윤곽 획 (글자 흉내)"""
    return {"points": [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]}


def test_parse_drops_empty_and_broken_points():
    st = parse_strokes([
        {"points": []},
        {"points": [[1, 2, 0.5], ["x", 3], [4]]},  # 필압(3번째 값) 무시, 깨진 점 제거
        {},
    ])
    assert len(st) == 1
    assert st[0].points == [(1.0, 2.0)]


def test_two_lines_are_separated_top_to_bottom():
    raw = [box(200, 150, 240, 190), box(0, 0, 40, 40), box(60, 0, 100, 40), box(0, 150, 40, 190)]
    lines = group_lines(parse_strokes(raw))
    assert len(lines) == 2
    assert lines[0].y1 < lines[1].y0
    assert len(lines[0].strokes) == 2 and len(lines[1].strokes) == 2


def test_batchim_below_line_joins_same_line():
    # 받침(ㅇ)처럼 줄 아래로 삐져나온 작은 획이 별도 줄로 분리되면 안 된다
    raw = [box(0, 0, 40, 40), box(60, 0, 100, 40), box(120, 0, 160, 40), box(125, 35, 150, 55)]
    assert len(group_lines(parse_strokes(raw))) == 1


def test_flat_strokes_stay_on_one_line():
    # 'ㅡ'처럼 높이 0인 획들도 같은 줄로 묶인다
    raw = [{"points": [[0, 20], [40, 20]]}, {"points": [[60, 22], [100, 22]]}, box(120, 0, 160, 40)]
    assert len(group_lines(parse_strokes(raw))) == 1


def test_dot_stroke_renders_ink():
    # 점 하나짜리 획(마침표)도 잉크가 찍혀야 한다
    img = strokes_to_line_images([box(0, 0, 40, 40), {"points": [[60, 38]]}])[0]
    right_half = img.crop((img.width * 3 // 4, 0, img.width, img.height))
    assert right_half.getextrema()[0] == 0


def test_render_normalizes_height_regardless_of_zoom():
    small = strokes_to_line_images([box(0, 0, 10, 10), box(15, 0, 25, 10)])[0]
    large = strokes_to_line_images([box(0, 0, 1000, 1000), box(1500, 0, 2500, 1000)])[0]
    assert abs(small.height - large.height) <= 2


def test_empty_input():
    assert strokes_to_line_images([]) == []
