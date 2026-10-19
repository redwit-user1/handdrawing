/**
 * 카메라 QR 스캔 — 네이티브(iOS·Android)에서만. 웹에서는 스캔할 수 없어 연결 화면에 "코드 직접 입력"만 보인다.
 * 플러그인은 필요할 때만 불러온다(웹 번들에 웹용 스캐너 라이브러리를 싣지 않는다).
 */
import { Capacitor } from '@capacitor/core';

/** 이 기기에서 카메라로 QR 을 읽을 수 있는가 */
export async function canScanQr(): Promise<boolean> {
  return Capacitor.isNativePlatform();
}

/** 플러그인이 "사용자가 닫았다"를 알리는 방식 — iOS 는 오류 코드 OS-PLUG-BARC-0006, 그 밖에는 취소 문구로 구분한다 */
function isCancel(e: unknown): boolean {
  const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
  return code === 'OS-PLUG-BARC-0006' || (typeof message === 'string' && /cancel/i.test(message));
}

/** QR 을 읽어 그 내용(문자열)을 돌려준다. 사용자가 닫으면 null. 카메라를 쓸 수 없는 등 그 밖의 실패는 던진다 */
export async function scanPairingQr(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner');
  try {
    const r = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: 'QR 코드를 화면 안에 맞춰 주세요',
    });
    return r.ScanResult ? r.ScanResult : null;
  } catch (e) {
    if (isCancel(e)) return null;
    throw e;
  }
}
