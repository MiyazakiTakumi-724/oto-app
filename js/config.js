// Googleドライブ同期に使う OAuth クライアントID(Google Cloud Console で作成した「ウェブアプリケーション」のID)
// 公開しても問題のない値。空のままだと同期機能は「準備中」と表示される
export const GOOGLE_CLIENT_ID = '275197767218-0itib9aoddq7883lus6pjke4cprj56gc.apps.googleusercontent.com';

// YouTube取り込み用サーバー(開発者の家のPCで動かし、Tailscale Funnel で公開)
export const YT_API_ENDPOINT = 'https://dynabook-724.tail35b56f.ts.net/api/youtube';