import type { Plugin } from 'vite';

/**
 * Ketcher 계산 엔진(Indigo, Emscripten embind)은 C++ 함수 호출 래퍼를 문자열 코드(`new Function`)로 만든다.
 * eval 을 막는 보안 정책(웹 체험판 등)에서는 엔진이 시작하자마자 실패하므로, 그 함수 하나(craftInvokerFunction)를
 * Emscripten 의 DYNAMIC_EXECUTION=0 구현과 같은 일반 클로저로 바꾼다. 동작은 같고 조금 느릴 뿐이다.
 *
 *  - WASM 판: 워커 파일(indigoWorker-*.js) — Vite worker 번들에도 이 플러그인을 건다
 *  - 순수 JS 판: 워커 코드가 base64 로 main.js 안에 들어 있다 — 풀어서 고치고 다시 넣는다
 */
const START = 'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){';
const END = 'return createNamedFunction(humanName,invokerFn)}';

const REPLACEMENT = `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
var argCount=argTypes.length;
if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");}
var isClassMethodFunc=argTypes[1]!==null&&classType!==null;
var needsDestructorStack=usesDestructorStack(argTypes);
var returns=argTypes[0].name!=="void";
var expected=argCount-2;
var invokerFn=function(...args){
if(args.length!==expected){throwBindingError("function "+humanName+" called with "+args.length+" arguments, expected "+expected);}
var destructors=needsDestructorStack?[]:null;
var thisWired;
var callArgs=[cppTargetFunc];
if(isClassMethodFunc){thisWired=argTypes[1]["toWireType"](destructors,this);callArgs.push(thisWired);}
var wired=[];
for(var i=0;i<expected;++i){var w=argTypes[i+2]["toWireType"](destructors,args[i]);wired.push(w);callArgs.push(w);}
var rv=cppInvokerFunc(...callArgs);
if(needsDestructorStack){runDestructors(destructors);}
else{for(var j=isClassMethodFunc?1:2;j<argTypes.length;++j){var param=j===1?thisWired:wired[j-2];if(argTypes[j].destructorFunction!==null){argTypes[j].destructorFunction(param);}}}
if(returns){return argTypes[0]["fromWireType"](rv);}
};
return createNamedFunction(humanName,invokerFn)}`;

/** 코드 안의 craftInvokerFunction 을 바꾼다. 없으면 null */
export function patchEmbindSource(code: string): string | null {
  const i = code.indexOf(START);
  if (i < 0) return null;
  const j = code.indexOf(END, i);
  if (j < 0) return null;
  return code.slice(0, i) + REPLACEMENT + code.slice(j + END.length);
}

const B64_WORKER = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/;

export function embindNoEval(): Plugin {
  return {
    name: 'embind-no-eval',
    enforce: 'pre',
    transform(code, id) {
      if (!/ketcher-standalone[\\/]dist[\\/]/.test(id)) return null;
      // WASM 판 워커
      if (/indigoWorker-[0-9a-f]+\.js$/.test(id.split('?')[0])) {
        const out = patchEmbindSource(code);
        if (!out) this.warn(`embind-no-eval: craftInvokerFunction 을 찾지 못했습니다 (WASM 워커 ${id})`);
        return out ? { code: out, map: null } : null;
      }
      // 순수 JS 판: base64 워커
      const m = B64_WORKER.exec(code);
      if (m) {
        const src = Buffer.from(m[1], 'base64').toString('utf8');
        const out = patchEmbindSource(src);
        if (!out) { this.warn('embind-no-eval: craftInvokerFunction 을 찾지 못했습니다 (JS 워커)'); return null; }
        return { code: code.replace(m[1], Buffer.from(out, 'utf8').toString('base64')), map: null };
      }
      return null;
    },
  };
}
