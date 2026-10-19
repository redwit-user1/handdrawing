/**
 * 카메라 QR 스캔. 지금은 자리만 잡아 둔 임시 구현 — 웹에서는 스캔할 수 없다(연결 화면은 "코드 직접 입력"만 보인다).
 * 네이티브(iOS·Android) 스캐너는 다음 단계에서 채운다.
 */

/** 이 기기에서 카메라로 QR 을 읽을 수 있는가 */
export async function canScanQr(): Promise<boolean> {
  return false;
}

/** QR 을 읽어 그 내용(문자열)을 돌려준다. 취소하거나 읽을 수 없으면 null */
export async function scanPairingQr(): Promise<string | null> {
  return null;
}
