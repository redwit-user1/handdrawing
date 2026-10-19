import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_ALPHABET, REPEATED_LINK_MS, formatCode, isRepeatedLink, normalizeCode, pairErrorMessage, pairingFromUrl, parsePairingUri,
} from '../../src/lib/pairing.ts';

const uri = (server, code) =>
  `goono-note://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;

test('normalizes lowercase hyphen spaces', () => {
  assert.equal(normalizeCode(' k7q2-m9xd '), 'K7Q2M9XD');
  assert.equal(normalizeCode('k7q2 m9xd'), 'K7Q2M9XD');
  assert.equal(normalizeCode('K7Q2M9XD'), 'K7Q2M9XD');
});

test('rejects ambiguous chars', () => {
  for (const bad of ['K7Q2M9X0', 'K7Q2M9XO', 'K7Q2M9X1', 'K7Q2M9XI', 'K7Q2M9XL']) {
    assert.equal(normalizeCode(bad), null, bad);
  }
  assert.equal(CODE_ALPHABET, '23456789ABCDEFGHJKMNPQRSTUVWXYZ');
});

test('rejects wrong length', () => {
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode('K7Q2M9X'), null);
  assert.equal(normalizeCode('K7Q2-M9XDA'), null);
});

test('formats code', () => {
  assert.equal(formatCode('K7Q2M9XD'), 'K7Q2-M9XD');
});

test('parses valid uri', () => {
  assert.deepEqual(parsePairingUri(uri('https://eln.example.com', 'K7Q2-M9XD')), { serverUrl: 'https://eln.example.com', code: 'K7Q2M9XD' });
  // 서버 끝 슬래시 정리, 앞뒤 공백·소문자 코드 허용
  assert.deepEqual(parsePairingUri(`  ${uri('https://eln.example.com/', 'k7q2-m9xd')}\n`), { serverUrl: 'https://eln.example.com', code: 'K7Q2M9XD' });
});

test('rejects other scheme/host', () => {
  for (const t of [
    'https://pair?server=https%3A%2F%2Fx.com&code=K7Q2-M9XD',
    'other-app://pair?server=https%3A%2F%2Fx.com&code=K7Q2-M9XD',
    'goono-note://login?server=https%3A%2F%2Fx.com&code=K7Q2-M9XD',
    'hello world',
    '',
  ]) {
    assert.deepEqual(parsePairingUri(t), { error: 'NOT_PAIRING_QR' }, t);
  }
});

test('rejects http unless allowed', () => {
  const t = uri('http://192.168.0.5:8080', 'K7Q2-M9XD');
  assert.deepEqual(parsePairingUri(t), { error: 'INSECURE_SERVER' });
  assert.deepEqual(parsePairingUri(t, { allowHttp: false }), { error: 'INSECURE_SERVER' });
  assert.deepEqual(parsePairingUri(t, { allowHttp: true }), { serverUrl: 'http://192.168.0.5:8080', code: 'K7Q2M9XD' });
  assert.deepEqual(parsePairingUri(uri('ftp://x.com', 'K7Q2-M9XD'), { allowHttp: true }), { error: 'INSECURE_SERVER' });
  assert.deepEqual(parsePairingUri('goono-note://pair?code=K7Q2-M9XD'), { error: 'INSECURE_SERVER' });
});

test('rejects missing or bad code', () => {
  assert.deepEqual(parsePairingUri('goono-note://pair?server=https%3A%2F%2Fx.com'), { error: 'BAD_CODE' });
  assert.deepEqual(parsePairingUri(uri('https://x.com', 'K7Q2-M9XDA')), { error: 'BAD_CODE' });
  assert.deepEqual(parsePairingUri(uri('https://x.com', 'K7Q2-M9X0')), { error: 'BAD_CODE' });
});

test('maps pair errors to exact copy', () => {
  assert.equal(pairErrorMessage({ message: 'x', status: 401, code: 'INVALID_PAIRING_CODE' }),
    '코드가 맞지 않거나 만료되었습니다. 구노 웹에서 새 QR을 띄워 주세요.');
  assert.equal(pairErrorMessage({ message: 'x', status: 403, code: 'APP_DISABLED' }),
    '이 기관은 태블릿 연결을 사용하지 않습니다. 관리자에게 문의하세요.');
  assert.equal(pairErrorMessage({ message: 'x', status: 403, code: 'DEVICE_NOT_ALLOWED' }),
    '이 기기는 연결할 수 없습니다. 관리자에게 문의하세요.');
  assert.equal(pairErrorMessage({ message: 'x', status: 429, code: 'TOO_MANY_ATTEMPTS' }),
    '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  assert.equal(pairErrorMessage({ message: 'x', status: 429, code: 'TOO_MANY_ATTEMPTS', retryAfterSec: 42 }),
    '시도가 너무 많습니다. 잠시 후 다시 시도하세요. (약 42초 후)');
  assert.match(pairErrorMessage({ message: 'x', status: 0, code: 'NETWORK' }), /^서버에 연결할 수 없습니다\./);
  // 모르는 코드·일반 Error(다른 계정 거부)는 받은 문구 그대로
  assert.equal(pairErrorMessage({ message: '서버 오류 (500)', status: 500, code: 'HTTP_500' }), '서버 오류 (500)');
  assert.equal(pairErrorMessage(new Error('올리지 않은 기록이 있습니다')), '올리지 않은 기록이 있습니다');
});

// ---- 딥링크: 앱 밖에서 열린 URL ----

test('ignores non-pair urls', () => {
  for (const u of [
    'https://example.com/pair?server=https%3A%2F%2Fx.com&code=K7Q2-M9XD',
    'goono-note://other?server=https%3A%2F%2Fx.com&code=K7Q2-M9XD',
    'otherapp://pair?server=https%3A%2F%2Fx.com&code=K7Q2-M9XD',
    'not a url',
    '',
  ]) assert.equal(pairingFromUrl(u), null, u);
});

test('routes pair url', () => {
  assert.deepEqual(pairingFromUrl(uri('https://eln.example.org/', 'k7q2-m9xd')), { serverUrl: 'https://eln.example.org', code: 'K7Q2M9XD' });
  // QR 과 같은 해석 — http 서버는 개발 빌드에서만
  assert.deepEqual(pairingFromUrl(uri('http://192.168.0.5:8080', 'K7Q2-M9XD')), { error: 'INSECURE_SERVER' });
  assert.deepEqual(pairingFromUrl(uri('http://192.168.0.5:8080', 'K7Q2-M9XD'), { allowHttp: true }),
    { serverUrl: 'http://192.168.0.5:8080', code: 'K7Q2M9XD' });
});

test('pair url with bad contents reports the cause instead of being ignored', () => {
  assert.deepEqual(pairingFromUrl('goono-note://pair?code=K7Q2-M9XD'), { error: 'INSECURE_SERVER' });
  assert.deepEqual(pairingFromUrl('goono-note://pair?server=https%3A%2F%2Fx.com'), { error: 'BAD_CODE' });
  assert.deepEqual(pairingFromUrl(uri('https://x.com', 'K7Q2-M9XDA')), { error: 'BAD_CODE' });
});

test('same deep link arriving twice at launch (getLaunchUrl + appUrlOpen) is taken once', () => {
  const url = uri('https://eln.example.org', 'K7Q2-M9XD');
  assert.equal(isRepeatedLink(null, url, 1000), false);
  const prev = { url, at: 1000 };
  assert.equal(isRepeatedLink(prev, url, 1000), true);
  assert.equal(isRepeatedLink(prev, url, 1000 + REPEATED_LINK_MS - 1), true);
  // 시간이 지나 같은 링크를 다시 열거나, 다른 링크면 받는다
  assert.equal(isRepeatedLink(prev, url, 1000 + REPEATED_LINK_MS), false);
  assert.equal(isRepeatedLink(prev, uri('https://eln.example.org', 'K7Q2-M9XE'), 1001), false);
});
