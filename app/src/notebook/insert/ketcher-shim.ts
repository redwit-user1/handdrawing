/**
 * Ketcher 는 Node 전역 process/global 을 참조한다 — Ketcher import 보다 먼저 최소 폴리필을 둔다.
 * (editor-ai ketcher-shim.ts 와 같은 방식)
 */
const g = globalThis as unknown as { process?: { env?: Record<string, unknown> }; global?: unknown };
if (typeof g.process === 'undefined') g.process = { env: {} };
else if (typeof g.process.env === 'undefined') g.process.env = {};
if (typeof g.global === 'undefined') g.global = globalThis;
export {};
