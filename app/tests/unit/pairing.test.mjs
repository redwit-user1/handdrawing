import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, formatCode, normalizeCode, parsePairingUri } from '../../src/lib/pairing.ts';

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
