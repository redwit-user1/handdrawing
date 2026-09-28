# 필기 인식 서버 (PaddleOCR PoC)

내장 필기 인식 API가 없는 브라우저(iPad Safari, Windows/Mac Chrome, Firefox 등 — 내장 API는
사실상 ChromeOS 전용이고 한국어를 지원하지 않음)에서 한글 필기 인식을 제공하는 **무료·오프라인**
인식 서버입니다. 에디터의 `config.js` → `recognizerEndpoint` 계약을 그대로 구현합니다.

- 엔진: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 3.x 인식 모델
  `korean_PP-OCRv5_mobile_rec` (Apache-2.0, 한글+영문+숫자, CPU 동작, 모델 약 10MB)
- 외부 API 호출 없음 — 폐쇄망 온프레미스 배포 가능 (모델은 빌드 시 이미지에 포함)

## 동작 방식

```
POST /recognize { languages, strokes: [{points: [[x,y],...]}, ...] }
  1. 획을 줄 단위로 묶음 (세로 겹침 클러스터링 + 받침·점 등 고아 획 흡수)
  2. 줄마다 높이를 64px로 정규화해 흰 배경에 고정 굵기 선으로 렌더 (원본 줌·필압 무관)
  3. 줄 이미지들을 한 번에 배치 추론
→ { "text": "줄1\n줄2", "lines": [{text, score}, ...], "elapsed_ms": 42 }
```

에디터는 `text`만 쓰고, `lines`(줄별 신뢰도)·`elapsed_ms`는 디버깅용 참고 필드입니다.

## 실행

```bash
cd server/recognizer
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 8765          # 최초 실행 시 모델 자동 다운로드(~10MB)
curl localhost:8765/healthz
```

Docker (폐쇄망 반입용 — 인터넷 되는 곳에서 빌드하면 모델이 이미지에 포함됨):

```bash
docker build -t handdrawing-recognizer server/recognizer
docker run -p 8765:8765 handdrawing-recognizer
```

에디터 연결 (`config.js`):

```js
recognizerEndpoint: '/api/recognize',   // 리버스 프록시로 같은 오리진에 붙이는 것을 권장
```

다른 오리진에서 직접 호출한다면 서버에 CORS 허용 오리진을 지정합니다:
`RECOGNIZER_ALLOWED_ORIGINS=https://eln.example.com uvicorn app:app ...`

nginx 예시 (에디터와 같은 도메인의 `/api/recognize`로 노출):

```nginx
location = /api/recognize {
  proxy_pass http://127.0.0.1:8765/recognize;
  client_max_body_size 5m;
}
```

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `RECOGNIZER_MODEL` | `korean_PP-OCRv5_mobile_rec` | PaddleOCR 인식 모델명 |
| `RECOGNIZER_ALLOWED_ORIGINS` | (없음 = 동일 오리진 전용) | CORS 허용 오리진, 쉼표 구분 |
| `RECOGNIZER_MIN_SCORE` | `0.3` | 이 신뢰도 미만인 줄은 `text`에서 제외 |

요청 상한: 획 5,000개 / 점 300,000개 (초과 시 413).

## 측정 결과 (2026-09, 4코어 CPU, GPU 없음)

실제 태블릿 필기 데이터 대신, 한글 손글씨 폰트로 쓴 문장을 **골격화해 펜 획 좌표로 변환**하고
글자마다 크기·기울기·기준선을 흔든 합성 필기로 측정했습니다 (`bench.py`, 8문장 × 시드 3개).

| 필체 | 문자 오류율(CER) | 비고 |
| --- | --- | --- |
| 나눔손글씨 펜 (또박또박한 필기) | **6.5%** | 대부분 완전 일치, 오류는 `측정→착정`, `완료→완로` 류 |
| 나눔손글씨 붓 (흘려 쓴 필기) | 14.2% | 흘림이 심한 자모에서 오류 증가 |

- 응답 시간: 한 줄 약 30~80ms, 모델 로드 약 10초(최초 1회)
- 렌더 파라미터(선 굵기 = 글자 높이 × 0.075, 글자 높이 64px)는 위 데이터로 4×3 조합을
  스윕해 가장 좋은 값으로 정했습니다.
- **한계**: 합성 데이터는 실제 필기보다 깔끔합니다. 실사용 정확도는 실제 사용자 필기로 다시
  측정해야 하며, 영문·기호가 섞인 짧은 토큰(`pH` → `개`)과 흘림체에 약합니다.

재현:

```bash
pip install scikit-image fonttools
python bench.py --font-dir <손글씨 TTF 폴더> --url http://localhost:8765/recognize
python -m pytest -q test_render.py     # 렌더/줄 분리 단위 테스트 (모델 불필요)
```

## 정확도 개선 로드맵

1. **실데이터 수집** — ELN 사용 중 인식 결과를 사용자가 고친 쌍(획 + 정답 텍스트)을 동의하에
   모으면 그대로 평가·학습 데이터가 됩니다.
2. **파인튜닝** — AI Hub 공개 "한국어 글자체 이미지(손글씨)" 데이터로 PP-OCRv5 인식 모델을
   파인튜닝 (PaddleOCR 학습 도구 사용, 모델 교체는 `RECOGNIZER_MODEL`/모델 경로만 변경).
3. **획 기반 모델 검토** — 이미지 OCR은 획 순서·방향 정보를 버립니다. 온라인 필기
   인식(획 시퀀스 입력) 모델이 한글에 더 유리하나, 공개 한국어 사전학습 모델이 드물어 2단계
   이후 검토 대상입니다.
