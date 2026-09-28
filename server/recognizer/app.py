"""
app.py — 손글씨 노트용 필기 인식 서버 (PaddleOCR 기반 PoC).

에디터 config.js의 recognizerEndpoint 계약을 그대로 구현한다:

    POST /recognize
    { "languages": ["ko", "en"], "strokes": [ { "points": [[x, y], ...] }, ... ] }
    → { "text": "인식된 문자열" }

응답에는 계약 외 참고용 필드(lines: 줄별 텍스트·신뢰도, elapsed_ms)가 추가되며,
에디터는 text만 사용한다.

완전 오프라인 동작: 모델은 최초 1회 다운로드 후 로컬 캐시(~/.paddlex)를 쓰며,
Dockerfile은 빌드 시점에 모델을 이미지에 포함시켜 폐쇄망에서도 바로 뜬다.

환경 변수
  RECOGNIZER_MODEL            인식 모델 (기본 korean_PP-OCRv5_mobile_rec — 한글+영문+숫자)
  RECOGNIZER_ALLOWED_ORIGINS  CORS 허용 오리진, 쉼표 구분 (기본 없음 = 동일 오리진 전용.
                              리버스 프록시로 에디터와 같은 오리진에 붙이면 불필요)
  RECOGNIZER_MIN_SCORE        이 신뢰도 미만인 줄은 결과에서 제외 (기본 0.3)
"""
from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import asynccontextmanager

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from render import strokes_to_line_images

MODEL_NAME = os.environ.get("RECOGNIZER_MODEL", "korean_PP-OCRv5_mobile_rec")
MIN_SCORE = float(os.environ.get("RECOGNIZER_MIN_SCORE", "0.3"))
# 과도한 요청으로 서버가 멈추지 않도록 하는 상한 (노트 한 페이지 분량은 여유 있게 수용)
MAX_STROKES = 5000
MAX_POINTS = 300_000

log = logging.getLogger("recognizer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class StrokeIn(BaseModel):
    points: list[list[float]] = Field(default_factory=list)


class RecognizeIn(BaseModel):
    languages: list[str] = Field(default_factory=lambda: ["ko", "en"])
    strokes: list[StrokeIn] = Field(default_factory=list)


class LineOut(BaseModel):
    text: str
    score: float


class RecognizeOut(BaseModel):
    text: str
    lines: list[LineOut]
    elapsed_ms: int


@asynccontextmanager
async def lifespan(_app: FastAPI):
    get_model()  # 첫 요청이 모델 로드(~10초)를 떠안지 않도록 기동 시 미리 로드
    yield


app = FastAPI(title="handdrawing recognizer", version="0.1.0", lifespan=lifespan)

_origins = [o.strip() for o in os.environ.get("RECOGNIZER_ALLOWED_ORIGINS", "").split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

# 모델은 프로세스당 1개만 로드. Paddle 추론기는 스레드 안전이 보장되지 않으므로
# 락으로 직렬화한다 (CPU 1줄 ~수십 ms라 PoC 규모에서는 충분 — 처리량이 필요하면
# uvicorn --workers N으로 프로세스를 늘린다).
_model = None
_model_lock = threading.Lock()


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from paddleocr import TextRecognition

                t = time.time()
                _model = TextRecognition(model_name=MODEL_NAME)
                log.info("model %s loaded in %.1fs", MODEL_NAME, time.time() - t)
    return _model


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/recognize", response_model=RecognizeOut)
def recognize(req: RecognizeIn) -> RecognizeOut:
    t0 = time.time()
    if len(req.strokes) > MAX_STROKES:
        raise HTTPException(413, f"획이 너무 많습니다 (최대 {MAX_STROKES})")
    if sum(len(s.points) for s in req.strokes) > MAX_POINTS:
        raise HTTPException(413, f"점이 너무 많습니다 (최대 {MAX_POINTS})")

    images = strokes_to_line_images([s.model_dump() for s in req.strokes])
    if not images:
        return RecognizeOut(text="", lines=[], elapsed_ms=0)

    # 모델은 3채널 입력을 기대한다
    batch = [np.stack([np.asarray(im)] * 3, axis=-1) for im in images]
    model = get_model()
    with _model_lock:
        results = list(model.predict(batch, batch_size=8))

    lines = [
        LineOut(text=str(r["rec_text"]).strip(), score=round(float(r["rec_score"]), 4))
        for r in results
    ]
    kept = [l.text for l in lines if l.text and l.score >= MIN_SCORE]
    elapsed = int((time.time() - t0) * 1000)
    log.info("recognize strokes=%d lines=%d elapsed=%dms", len(req.strokes), len(lines), elapsed)
    return RecognizeOut(text="\n".join(kept), lines=lines, elapsed_ms=elapsed)
