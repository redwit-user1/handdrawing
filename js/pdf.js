/**
 * pdf.js — 외부 라이브러리 없이 캔버스를 단일 페이지 PDF로 저장.
 * 캔버스를 JPEG으로 인코딩해 DCTDecode 스트림으로 임베드하는 최소 구조의 PDF를 만든다.
 */
function downloadCanvasAsPDF(canvas, filename) {
  const W = canvas.width, H = canvas.height;

  // 캔버스 → JPEG 바이트
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const bin = atob(dataUrl.split(',')[1]);
  const jpeg = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i);

  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = []; // 객체 번호 → 바이트 오프셋

  const push = data => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // 바이너리 마커 주석

  offsets[1] = offset;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = offset;
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  offsets[3] = offset;
  push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
    '/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> ' +
    '/Contents 5 0 R >>\nendobj\n');

  offsets[4] = offset;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');

  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  offsets[5] = offset;
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefOffset = offset;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const blob = new Blob(chunks, { type: 'application/pdf' });
  const a = document.createElement('a');
  a.download = filename;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
