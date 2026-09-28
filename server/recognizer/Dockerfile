# 손글씨 인식 서버 (PaddleOCR, CPU)
#
# 폐쇄망 배포: 인터넷이 되는 곳에서 빌드하면 모델이 이미지에 포함되므로,
# `docker save`로 내보내 사내망에 반입하면 런타임에는 외부 접속이 전혀 필요 없다.
#
#   docker build -t handdrawing-recognizer .
#   docker run -p 8765:8765 handdrawing-recognizer
FROM python:3.11-slim

# OpenCV(paddlex 의존) 런타임 라이브러리
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    RECOGNIZER_MODEL=korean_PP-OCRv5_mobile_rec
# 빌드 시점에 모델을 받아 이미지에 굽는다 (~/.paddlex/official_models)
RUN python -c "from paddleocr import TextRecognition; TextRecognition(model_name='korean_PP-OCRv5_mobile_rec')"

COPY app.py render.py ./

EXPOSE 8765
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
