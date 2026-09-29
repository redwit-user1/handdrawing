import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyServerNote, classifyUploadError, CLOCK_ROLLBACK_TOLERANCE_MS, editBlock, sessionLock } from '../../src/lib/rules.ts';

const NOW = Date.parse('2026-09-29T10:00:00Z');
const session = (over = {}) => ({
  serverUrl: 'http://x', deviceId: 'dev-1', deviceName: 'iPad', token: 't',
  tokenExpiresAt: '2026-10-13T10:00:00Z', offlineGraceDays: 14,
  user: { userMno: 12, loginId: 'r', name: '김연구' }, lastServerContactAt: '2026-09-29T09:00:00Z', ...over,
});
const note = (over = {}) => ({
  id: 'n1', noteMno: 101, projectMno: 3, projectName: 'P', title: 'T', createdAt: '', updatedAt: '',
  serverStatus: 'WRITING', editLocation: 'THIS_DEVICE', released: false, releaseRequested: false, reclaimed: false,
  latestServerVersionId: 5001, versionSeq: 1, workingSavedAt: null, workingDirty: false, ...over,
});
const server = (over = {}) => ({
  noteMno: 101, clientNoteId: 'n1', title: 'T', projectMno: 3, status: 'WRITING',
  editLocation: { type: 'DEVICE', deviceId: 'dev-1' }, latestVersionId: 5001, updatedAt: '', ...over,
});

test('세션 잠금: 폐기·재로그인·기한 만료·시계 되돌림', () => {
  assert.equal(sessionLock(session(), NOW), null);
  assert.equal(sessionLock(session({ revoked: true }), NOW), 'REVOKED');
  assert.equal(sessionLock(session({ needsLogin: true }), NOW), 'NEEDS_LOGIN');
  assert.equal(sessionLock(session({ tokenExpiresAt: '2026-09-29T09:59:59Z' }), NOW), 'OFFLINE_EXPIRED');
  assert.equal(sessionLock(session({ clockHighWater: NOW + CLOCK_ROLLBACK_TOLERANCE_MS - 1 }), NOW), null, '허용 범위 안');
  assert.equal(sessionLock(session({ clockHighWater: NOW + CLOCK_ROLLBACK_TOLERANCE_MS + 1 }), NOW), 'CLOCK_ROLLBACK');
});

test('편집 가능 여부', () => {
  assert.equal(editBlock(note(), session(), NOW), null);
  assert.equal(editBlock(note({ serverStatus: 'REJECT' }), session(), NOW), null, '반려된 노트는 다시 작성 가능');
  assert.equal(editBlock(note({ serverStatus: 'INSPECTION' }), session(), NOW).kind, 'NOT_WRITABLE');
  assert.equal(editBlock(note({ serverStatus: 'COMPLETE' }), session(), NOW).kind, 'NOT_WRITABLE');
  assert.equal(editBlock(note({ released: true }), session(), NOW).kind, 'RELEASED');
  assert.equal(editBlock(note({ releaseRequested: true }), session(), NOW).kind, 'RELEASE_PENDING');
  assert.equal(editBlock(note({ reclaimed: true }), session(), NOW).kind, 'RECLAIMED');
  assert.equal(editBlock(note(), session({ tokenExpiresAt: '2026-09-01T00:00:00Z' }), NOW).kind, 'LOCK');
});

test('서버 상태 반영: 편집 위치가 이 기기면 그대로', () => {
  const r = applyServerNote(note(), server({ status: 'REJECT' }), 'dev-1');
  assert.equal(r.editLocation, 'THIS_DEVICE');
  assert.equal(r.serverStatus, 'REJECT');
  assert.equal(r.reclaimed, false);
});

test('서버 상태 반영: 반납하지 않았는데 WEB 이면 회수됨', () => {
  const r = applyServerNote(note(), server({ editLocation: { type: 'WEB' } }), 'dev-1');
  assert.equal(r.editLocation, 'WEB');
  assert.equal(r.reclaimed, true);
});

test('서버 상태 반영: 다른 기기로 넘어가도 회수됨', () => {
  const r = applyServerNote(note(), server({ editLocation: { type: 'DEVICE', deviceId: 'dev-2' } }), 'dev-1');
  assert.equal(r.reclaimed, true);
});

test('서버 상태 반영: 반납 응답만 못 받은 경우는 반납 완료로', () => {
  const r = applyServerNote(note({ releaseRequested: true }), server({ editLocation: { type: 'WEB' } }), 'dev-1');
  assert.equal(r.released, true);
  assert.equal(r.reclaimed, false);
  assert.equal(r.releaseRequested, false);
});

test('서버 상태 반영: 서버 번호가 없던 노트는 목록에서 번호를 받는다(생성 응답 유실)', () => {
  const r = applyServerNote(note({ noteMno: null }), server({ noteMno: 777 }), 'dev-1');
  assert.equal(r.noteMno, 777);
});

test('업로드 오류 분류', () => {
  assert.equal(classifyUploadError(0, 'NETWORK', 0), 'STOP');
  assert.equal(classifyUploadError(503, 'HTTP_503', 0), 'STOP');
  assert.equal(classifyUploadError(401, 'TOKEN_EXPIRED', 0), 'AUTH');
  assert.equal(classifyUploadError(401, 'DEVICE_REVOKED', 0), 'AUTH');
  assert.equal(classifyUploadError(409, 'NOT_EDIT_OWNER', 0), 'REJECT_NOTE');
  assert.equal(classifyUploadError(409, 'NOT_WRITABLE', 0), 'REJECT_NOTE');
  assert.equal(classifyUploadError(409, 'STALE_BASE', 0), 'REJECT_NOTE');
  assert.equal(classifyUploadError(422, 'HASH_MISMATCH', 0), 'RETRY');
  assert.equal(classifyUploadError(422, 'HASH_MISMATCH', 2), 'SKIP');
  assert.equal(classifyUploadError(413, 'TOO_LARGE', 0), 'SKIP');
});
