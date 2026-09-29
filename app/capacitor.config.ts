import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kr.redwit.goono.note',
  appName: '구노 연구노트',
  webDir: 'dist',
  // 앱 내장 자산은 capacitor://localhost(iOS) / https://localhost(Android) 에서 서빙된다.
  // 구노 서버는 이 두 오리진을 CORS 로 허용해야 한다 (docs/SYNC-API.md).
  // 운영 구노 서버는 https 여야 한다. 개발 중 같은 망의 http 모의 서버에 붙을 때만 GOONO_DEV_HTTP=1 로
  // cap sync 한다 (Android 혼합 콘텐츠·평문 허용. iOS 는 Info.plist 의 NSAllowsLocalNetworking 참고).
  server: process.env.GOONO_DEV_HTTP === '1' ? { cleartext: true } : undefined,
  android: {
    allowMixedContent: process.env.GOONO_DEV_HTTP === '1',
  },
  ios: {
    contentInset: 'never',
  },
};

export default config;
