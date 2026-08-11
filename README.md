# 손글씨 노트 (Handdrawing)

태블릿 사용에 특화된 웹 기반 드로잉 노트 편집기입니다. 빌드 과정이나 외부 의존성 없이
순수 HTML / CSS / JavaScript로 작성되어 있으며, 정적 파일 서버만 있으면 어디서든 동작합니다.

## 실행 방법

```bash
# 저장소 루트에서 아무 정적 서버나 실행
python3 -m http.server 8000
# 또는
npx serve .
```

브라우저(태블릿 권장)에서 `http://<주소>:8000` 접속.
HTTPS/localhost 환경에서는 PWA로 설치해 전체 화면 앱처럼 사용할 수 있습니다.

## 온프레미스(사내망) 배포

이 앱은 온프레미스 배포를 전제로 설계되어 있습니다.

- **외부 의존성 0개**: CDN·외부 API·트래킹 호출이 전혀 없습니다. 정적 파일을 사내
  웹서버(nginx, Apache, IIS 등)에 올리기만 하면 되고, 인터넷이 차단된 폐쇄망에서도
  전 기능이 동작합니다 (필기 인식만 아래 참고).
- **데이터가 밖으로 나가지 않음**: 노트는 각 기기의 `localStorage`에만 저장되고,
  필기 인식도 온디바이스(내장 API) 또는 사내 인식 서버로만 처리됩니다.
- **HTTP만으로 동작**: 모든 편집 기능은 HTTP에서 동작합니다. 단, PWA 설치·오프라인
  캐시(서비스 워커)와 클립보드 복사는 브라우저 정책상 **HTTPS(또는 localhost)**가
  필요하므로, 사내 CA 인증서로 HTTPS를 켜는 것을 권장합니다.
- **nginx 예시**:
  ```nginx
  server {
    listen 443 ssl;
    server_name note.internal.example.com;
    ssl_certificate     /etc/ssl/internal.crt;
    ssl_certificate_key /etc/ssl/internal.key;
    root /var/www/handdrawing;
    location / { try_files $uri $uri/ =404; }
  }
  ```
- **버전 업데이트**: 파일 교체 후 `sw.js`의 `CACHE` 이름이 바뀌면 클라이언트가
  자동으로 새 버전을 받습니다.

### 사내 필기 인식 서버 (선택)

내장 인식 API가 없는 브라우저(iPad Safari 등)를 위해 `config.js`의
`recognizerEndpoint`에 사내 인식 서버 URL을 지정할 수 있습니다. 서버 사양:

```
POST /recognize
Content-Type: application/json

요청: { "languages": ["ko", "en"],
        "strokes": [ { "points": [[x, y], ...] }, ... ] }
응답: { "text": "인식된 문자열" }
```

서버 구현 후보: 획 좌표를 이미지로 렌더링한 뒤 TrOCR 계열 한국어 손글씨 모델
(Hugging Face 공개 모델)로 인식하거나, MyScript 같은 상용 온프레미스 SDK를
연동하면 됩니다. 앱 쪽은 위 JSON 계약만 지키면 어떤 구현이든 무방합니다.

## 브라우저 호환성 (iPad 포함)

| 기능 | Chrome/Edge | iPad Safari | Firefox |
| --- | --- | --- | --- |
| 필기·필압(Apple Pencil 포함)·팜 리젝션 | ✅ | ✅ (Pointer Events 필압 지원) | ✅ |
| 핀치 줌·패닝·도형·올가미·실행 취소 | ✅ | ✅ | ✅ |
| 고주파 입력(`getCoalescedEvents`) | ✅ | ✅ 18.2+ (미만은 자동 폴백, 기능 동일) | ✅ |
| PNG / PDF 내보내기 | ✅ | ✅ | ✅ |
| 필기 인식 (내장 API) | ✅ | ❌ → `recognizerEndpoint`로 대체 | ❌ → 동일 |
| PWA 홈 화면 설치 | ✅ | ✅ (`apple-touch-icon` 포함) | 제한적 |
| 노트 저장 | localStorage | localStorage† | localStorage |

† iPad Safari는 ITP 정책상 **7일간 방문하지 않으면** 사이트 데이터를 삭제할 수
있습니다. 홈 화면에 PWA로 설치하면 삭제 대상에서 제외되며, 노트 패널의
**전체 백업/복원**(JSON 파일)으로 기기 간 이동·보관도 가능합니다.

## 태블릿 특화 기능

| 기능 | 설명 |
| --- | --- |
| 스타일러스 필압 | Pointer Events의 `pressure` 값으로 획 굵기가 자연스럽게 변합니다 (EMA 스무딩 적용) |
| 팜 리젝션 | 펜 사용 중이거나 직후 600ms 동안 손바닥(터치) 입력을 무시합니다 |
| 펜 자동 감지 | 펜이 처음 감지되면 손가락 그리기를 자동으로 끄고 손가락은 화면 이동에 사용합니다 |
| 펜 지우개 버튼 | 스타일러스의 지우개 단/버튼(`buttons & 32`)을 누르면 즉시 지우개로 동작합니다 |
| 두 손가락 제스처 | 핀치 줌(0.25×–8×) + 패닝. 그리기 직후 두 번째 손가락이 닿으면 획을 취소하고 제스처로 전환합니다 |
| 고주파 입력 | `getCoalescedEvents()`로 120Hz+ 펜 샘플을 모두 사용해 곡선을 부드럽게 렌더링합니다 |
| 큰 터치 타깃 | 모든 툴바 버튼이 44px 이상으로 손가락 조작에 최적화되어 있습니다 |
| 전체 화면 PWA | manifest + 서비스 워커로 오프라인에서도 동작하며 홈 화면에 설치할 수 있습니다 |

## 편집 기능

- **도구**: 펜(필압 반영) / 형광펜(반투명, 굵기 일정) / 지우개(획 단위) / 도형 / 올가미 선택 / 이동(팬)
- **도형**: 직선·화살표·사각형·타원 (드래그로 크기 조절, 미리보기 표시)
- **올가미 선택**: 자유 곡선으로 획들을 선택 → 드래그 이동, 복제, 삭제, 텍스트 인식
- **필기 인식**: 브라우저 내장 Handwriting Recognition API로 선택 영역(또는 전체)을
  텍스트로 변환 (온디바이스 처리, 한국어·영어. Chrome/ChromeOS 등 지원 브라우저 필요.
  미지원 브라우저에서는 안내 메시지 표시)
- **색상**: 기본 6색 + 사용자 지정 색상 피커
- **굵기**: 3단계 프리셋
- **실행 취소 / 다시 실행**: 획 추가·삭제·이동·전체 지우기 모두 지원 (최대 100단계)
- **무한 캔버스**: 자유로운 패닝·줌, 점 격자 표시 토글
- **노트 관리**: 여러 노트 생성/전환/삭제/이름 변경, `localStorage` 자동 저장
- **전체 백업/복원**: 모든 노트를 JSON 파일로 내보내고 다른 기기·브라우저에서 병합 복원
- **내보내기**: PNG 이미지 또는 PDF 문서 (외부 라이브러리 없이 직접 PDF 생성,
  콘텐츠 경계를 계산해 여백 포함 고해상도로 저장)

## 키보드 단축키 (키보드 연결 시)

| 키 | 동작 |
| --- | --- |
| `Ctrl+Z` / `Ctrl+Y`(또는 `Ctrl+Shift+Z`) | 실행 취소 / 다시 실행 |
| `P` / `H` / `E` / `S` / `L` / `Space` | 펜 / 형광펜 / 지우개 / 도형 / 올가미 / 이동 |
| `Delete` | 선택한 획 삭제 |
| `Esc` | 선택 해제 / 팝오버 닫기 |
| `Ctrl+0`, `Ctrl+=`, `Ctrl+-` | 줌 재설정 / 확대 / 축소 |
| `Ctrl+휠` | 커서 기준 줌 |

## 구조

```
index.html          앱 셸과 툴바 마크업
styles.css          태블릿 친화적 UI 스타일 (다크 모드 지원)
js/store.js         localStorage 노트 저장소
js/engine.js        캔버스 드로잉 엔진 (입력 처리·렌더링·선택·실행 취소)
js/pdf.js           의존성 없는 단일 페이지 PDF 생성기 (JPEG DCTDecode 임베드)
js/recognize.js     Handwriting Recognition API 래퍼 (필기 → 텍스트)
js/app.js           UI ↔ 엔진 ↔ 저장소 연결
manifest.webmanifest, sw.js, icon.svg   PWA 리소스
```

획 데이터는 월드 좌표 기준 `{ tool, color, size, points: [[x, y, pressure], ...] }` 형태로
저장되며, 완료된 획은 오프스크린 캔버스에 캐시해 필기 중에도 60fps를 유지합니다.
