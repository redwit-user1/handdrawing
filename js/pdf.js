/**
 * pdf.js — 외부 라이브러리 없이 캔버스들을 A4 여러 페이지 PDF로 저장.
 * 페이지마다 캔버스를 JPEG으로 인코딩해 DCTDecode 스트림으로 임베드하는 최소 구조의 PDF를 만든다.
 */
const PDF_A4 = { w: 595.28, h: 841.89, margin: 42.52 }; // pt (A4, 여백 15mm — engine의 A4_BODY_ASPECT와 짝)

function buildPagesPDFBlob(canvases) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = []; // 객체 번호 → 바이트 오프셋

  const push = data => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  };

  // 객체 번호: 1 Catalog, 2 Pages, 페이지 i마다 (Page, Image, Contents) 3개
  const pageObj = i => 3 + i * 3;
  const n = canvases.length;

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // 바이너리 마커 주석

  offsets[1] = offset;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = offset;
  const kids = canvases.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  const bodyW = PDF_A4.w - PDF_A4.margin * 2;
  const bodyH = PDF_A4.h - PDF_A4.margin * 2;

  canvases.forEach((canvas, i) => {
    const W = canvas.width, H = canvas.height;
    const bin = atob(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
    const jpeg = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) jpeg[k] = bin.charCodeAt(k);

    // 본문 영역에 비율 유지로 맞추고 위쪽에 붙인다
    const s = Math.min(bodyW / W, bodyH / H);
    const dw = +(W * s).toFixed(2), dh = +(H * s).toFixed(2);
    const dx = PDF_A4.margin, dy = +(PDF_A4.h - PDF_A4.margin - dh).toFixed(2);

    const p = pageObj(i);
    offsets[p] = offset;
    push(`${p} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_A4.w} ${PDF_A4.h}] ` +
      `/Resources << /XObject << /Im0 ${p + 1} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
      `/Contents ${p + 2} 0 R >>\nendobj\n`);

    offsets[p + 1] = offset;
    push(`${p + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream\nendobj\n');

    const content = `q ${dw} 0 0 ${dh} ${dx} ${dy} cm /Im0 Do Q`;
    offsets[p + 2] = offset;
    push(`${p + 2} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const size = 3 + n * 3;
  const xrefOffset = offset;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}

function downloadPagesAsPDF(canvases, filename) {
  const blob = buildPagesPDFBlob(canvases);
  const a = document.createElement('a');
  a.download = filename;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
