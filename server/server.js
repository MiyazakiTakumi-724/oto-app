import express from 'express';
import cors from 'cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const app = express();
const PORT = process.env.PORT || 3001;
const YT_ID_RE = /^[\w-]{11}$/;

// アプリを置いている場所(Vercel と GitHub Pages)からの取り込みを許す。
// 環境変数 ALLOWED_ORIGIN にカンマ区切りでURLを足せる("*" ならどこからでも)
const APP_ORIGINS = ['https://oto-app-beryl.vercel.app', 'https://miyazakitakumi-724.github.io'];
const extraOrigins = String(process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

app.use(cors({
    origin: extraOrigins.includes('*') ? '*' : [...new Set([...APP_ORIGINS, ...extraOrigins])],
    exposedHeaders: [
        'Content-Length',
        'X-Track-Title',
        'X-Track-Artist',
        'X-Track-Duration',
        'X-Track-Ext',
    ],
}));
app.use(express.json());

function extractVideoId(input) {
    const s = String(input || '').trim();
    if (YT_ID_RE.test(s)) return s;
    try {
        const u = new URL(s);
        const host = u.hostname.replace(/^www\.|^m\./, '');
        if (host === 'youtu.be') {
            const id = u.pathname.slice(1, 12);
            return YT_ID_RE.test(id) ? id : null;
        }
        if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
            const v = u.searchParams.get('v')?.slice(0, 11);
            if (v && YT_ID_RE.test(v)) return v;
            const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
            if (m) return m[1];
        }
    } catch {
        return null;
    }
    return null;
}

// Cookie-Editor の JSON配列を yt-dlp 用の Netscape形式へ変換
function toNetscapeCookies(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (trimmed.startsWith('# Netscape')) return trimmed + '\n';
    try {
        const list = JSON.parse(trimmed);
        if (!Array.isArray(list) || !list.length) return null;
        const lines = ['# Netscape HTTP Cookie File'];
        for (const c of list) {
            if (!c?.domain || !c?.name) continue;
            const domain = String(c.domain);
            const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
            const p = c.path || '/';
            const secure = c.secure ? 'TRUE' : 'FALSE';
            const exp = c.expirationDate ? Math.floor(Number(c.expirationDate)) : 0;
            lines.push([domain, includeSub, p, secure, exp, c.name, c.value ?? ''].join('\t'));
        }
        return lines.join('\n') + '\n';
    } catch (e) {
        console.warn('[cookies parse failed]', e.message);
        return null;
    }
}

function extToMime(ext) {
    const map = {
        m4a: 'audio/mp4',
        mp4: 'audio/mp4',
        mp3: 'audio/mpeg',
        webm: 'audio/webm',
        opus: 'audio/ogg',
        ogg: 'audio/ogg',
    };
    return map[ext.toLowerCase()] || 'audio/mp4';
}

const lastLine = (s) => String(s || '').trim().split('\n').pop();
const tail = (s, n = 15) => String(s || '').trim().split('\n').slice(-n).join('\n');

// ---------- yt-dlp を新しく保つ ----------
// YouTube はよく仕様を変えるので、古い yt-dlp はすぐ取り込めなくなる。
// 起動時と6時間ごとに、yt-dlp が普段使いに勧めている nightly 版の最新へ更新する。
// yt-dlp は自分のファイルを上書きして更新するので、取り込み中は更新を待ち、更新中の取り込みも待たせる
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 30 * 60 * 1000;
let running = 0; // 実行中の yt-dlp の数
let updating = null; // 更新中なら、その Promise
let lastUpdateAt = 0;
let lastUpdateOk = false;
let ytDlpVersion = '';

function updateYtDlp() {
    if (updating) return updating;
    lastUpdateAt = Date.now();
    updating = (async () => {
        while (running > 0) await sleep(1000);
        try {
            const { stdout } = await execFileAsync('yt-dlp', ['--update-to', 'nightly'], { timeout: 90_000 });
            lastUpdateOk = true;
            console.log('[yt-dlp update]', lastLine(stdout));
        } catch (e) {
            lastUpdateOk = false;
            console.warn('[yt-dlp update failed]', lastLine(e.stderr || e.message));
        }
        try {
            ytDlpVersion = (await execFileAsync('yt-dlp', ['--version'], { timeout: 30_000 })).stdout.trim();
        } catch { /* 版がわからなくても続ける */ }
    })().finally(() => { updating = null; });
    return updating;
}

// YouTube の変更で動かなくなったらしいときは、前の更新から10分たっていれば、すぐ更新し直す
function updateYtDlpSoon() {
    if (Date.now() - lastUpdateAt > 10 * 60 * 1000) updateYtDlp();
}

async function withYtDlp(fn) {
    if (Date.now() - lastUpdateAt > (lastUpdateOk ? UPDATE_EVERY_MS : UPDATE_RETRY_MS)) updateYtDlp();
    while (updating) await updating;
    running++;
    try {
        return await fn();
    } finally {
        running--;
    }
}

// ---------- Cookie ----------
// YouTube はクラウドのサーバーからのアクセスに「ボットではない確認」を求めるので、ログインした Cookie を使う。
// ブラウザで開いたままのログインの Cookie は YouTube が作り直すので、書き出した方はすぐ無効になる
// (長持ちする作り方は README)
const COOKIE_TEXT = toNetscapeCookies(process.env.YOUTUBE_COOKIES);
// yt-dlp が「Cookie が無効になった」と言ったら、このサーバーが動いている間はもう使わない。
// YOUTUBE_COOKIES を更新すると Render がサーバーを起動し直すので、新しい Cookie をまた使い始める
let cookiesExpired = false;
const COOKIES_INVALID_RE = /cookies are no longer valid/i;
const MEDIA_403_RE = /unable to download video data: HTTP Error 403/i;

function botMessage() {
    if (!COOKIE_TEXT) {
        return 'YouTubeにボットと判定されました。Renderの環境変数 YOUTUBE_COOKIES にYouTubeのCookieを設定すると取り込めます(手順はREADMEにあります)。';
    }
    if (cookiesExpired) {
        return 'YouTubeにボットと判定されました。サーバーのCookie(YOUTUBE_COOKIES)の期限が切れているので、新しくしてください。長持ちする作り方はREADMEにあります。';
    }
    return 'YouTubeにボットと判定されました。Cookieは切れていないようなので、しばらく待ってからもう一度お試しください(何度も続くときは、Cookieを新しくしてみてください)。';
}

// ---------- 失敗の見分け ----------
// yt-dlp のエラーから、何が起きて、どうすればいいかがわかるメッセージにする(上から順に当てはめる)
const FAILURES = [
    { kind: 'private', re: /Private video/i, status: 422, message: '非公開の動画なので取り込めません。' },
    { kind: 'members', re: /members-only|Join this channel/i, status: 422, message: 'メンバー限定の動画なので取り込めません。' },
    { kind: 'age', re: /confirm your age|age-restricted|inappropriate for some users/i, status: 422, message: '年齢制限のある動画なので取り込めません。' },
    { kind: 'geo', re: /not available from your location|not made this video available in your country/i, status: 422, message: 'この動画は、サーバーのある国では見られないため取り込めません。' },
    { kind: 'live', re: /live event will begin|Premieres? in|Premiere will begin/i, status: 422, message: '始まる前のライブ配信やプレミア公開は取り込めません。' },
    { kind: 'rate', re: /try again later|rate-limited|HTTP Error 429|Too Many Requests/i, status: 503, message: 'YouTubeへのアクセスが多すぎて、一時的に止められています。1時間ほど待ってからお試しください。' },
    { kind: 'unavailable', re: /Video unavailable|video is (?:unavailable|not available)|has been removed|no longer available|been terminated/i, status: 422, message: 'この動画は削除されたか、見られなくなっています。' },
    { kind: 'bot', re: /not a bot|captcha/i, status: 502 },
    { kind: 'outdated', re: /Requested format is not available|Only images are available|Unable to extract|challenge solving failed|Signature extraction failed|nsig extraction failed|report this issue/i, status: 502, message: 'YouTube側の変更で取り込めませんでした。取り込みツール(yt-dlp)が対応すると、サーバーが自動で更新します。時間をおいてからお試しください。' },
];
const CONTENT_FAILURES = new Set(['private', 'members', 'age', 'geo', 'live', 'unavailable']);
// ページや API の読み込みを 429/403 で断られたときは、YouTube がこのサーバーを止めている
// (yt-dlp は最後に「Failed to extract any player response; please report this issue」と出すが、yt-dlp の不具合ではない)
const BLOCKED_RE = /Unable to download (?:webpage|API page): HTTP Error (?:429|403)/i;

function describeFailure({ log, timedOut }) {
    if (timedOut) {
        return { kind: 'timeout', status: 504, message: '時間がかかりすぎたので中止しました。配信中のライブや、とても長い動画は取り込めないことがあります。' };
    }
    // まず ERROR の行で見分け、わからなければ WARNING も含めた全体で見る
    const errors = log.split('\n').filter((l) => l.startsWith('ERROR:')).join('\n');
    let f = FAILURES.find((x) => x.re.test(errors)) || FAILURES.find((x) => x.re.test(log));
    if ((!f || f.kind === 'outdated') && BLOCKED_RE.test(log)) f = FAILURES.find((x) => x.kind === 'bot');
    if (!f) return { kind: 'other', status: 500, message: '音声の取り込みに失敗しました。しばらく待ってからもう一度お試しください。' };
    return f.kind === 'bot' ? { ...f, message: botMessage() } : f;
}

// ---------- 取り込み ----------
async function runYtDlp(videoId, dir, { cookies, signal }) {
    const args = [
        '--no-playlist',
        '--js-runtimes', 'deno',
        '--remote-components', 'ejs:github',
        '--concurrent-fragments', '4',
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '--write-info-json',
        '-o', path.join(dir, 'audio.%(ext)s'),
    ];
    if (cookies) {
        const cookieFile = path.join(dir, 'cookies.txt');
        await fs.writeFile(cookieFile, COOKIE_TEXT, 'utf8');
        args.push('--cookies', cookieFile);
    }
    args.push('--', `https://www.youtube.com/watch?v=${videoId}`);

    try {
        const { stderr } = await execFileAsync('yt-dlp', args, {
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            signal,
        });
        return { ok: true, log: String(stderr || '') };
    } catch (err) {
        return {
            ok: false,
            log: String(err.stderr || err.message || err),
            timedOut: Boolean(err.killed) && !signal.aborted,
        };
    }
}

// Cookie が切れていて失敗したときは、Cookie なしでもう一度だけ試す
// (切れた Cookie を付けたままだと、ボット判定で止められやすい)
async function download(videoId, tmpDir, signal) {
    let attempt = 0;
    const tryOnce = async (cookies) => {
        const dir = path.join(tmpDir, String(++attempt));
        await fs.mkdir(dir);
        return { ...(await runYtDlp(videoId, dir, { cookies, signal })), dir };
    };

    const withCookies = Boolean(COOKIE_TEXT) && !cookiesExpired;
    let result = await tryOnce(withCookies);
    if (withCookies && COOKIES_INVALID_RE.test(result.log)) {
        if (!cookiesExpired) console.warn('[cookies] YOUTUBE_COOKIES が無効になっています。新しくしてください');
        cookiesExpired = true;
        if (!result.ok && !signal.aborted && !CONTENT_FAILURES.has(describeFailure(result).kind)) {
            result = await tryOnce(false);
        }
    }
    // 音声の本体のダウンロードを 403 で断られることがときどきあるが、すぐやり直せば通ることが多い
    if (!result.ok && !signal.aborted && MEDIA_403_RE.test(result.log)) {
        result = await tryOnce(withCookies && !cookiesExpired);
    }
    return result;
}

app.get('/health', (_req, res) => {
    res.json({ ok: true, ytdlp: ytDlpVersion || undefined });
});

// サムネイル取得（既存の app.js と同じ仕様）
app.get('/api/youtube', async (req, res) => {
    const thumbId = String(req.query.thumb || '');
    if (!YT_ID_RE.test(thumbId)) {
        return res.status(400).json({ error: '不正なリクエストです' });
    }
    for (const quality of ['hqdefault.jpg', 'mqdefault.jpg']) {
        const r = await fetch(`https://i.ytimg.com/vi/${thumbId}/${quality}`);
        if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(buf);
        }
    }
    return res.status(404).end();
});

// YouTube URL → 音声ファイル（M4A優先）
app.post('/api/youtube', async (req, res) => {
    const videoId = extractVideoId(req.body?.id || req.body?.url);
    if (!videoId) {
        return res.status(400).json({ error: '有効なYouTubeの動画URLを入力してください' });
    }

    // アプリで取り込みをキャンセルしたら、yt-dlp も止める
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });

    let tmpDir;
    const cleanup = () => {
        if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    };
    try {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oto-yt-'));
        const result = await withYtDlp(() => download(videoId, tmpDir, abort.signal));
        if (abort.signal.aborted) return cleanup();

        if (!result.ok) {
            cleanup();
            const failure = describeFailure(result);
            console.error(`[yt-dlp error] ${videoId} (${failure.kind})\n${tail(result.log)}`);
            if (failure.kind === 'outdated') updateYtDlpSoon();
            return res.status(failure.status).json({ error: failure.message, code: failure.kind });
        }

        const files = await fs.readdir(result.dir);
        const audioFile = files.find((f) => f.startsWith('audio.') && !f.endsWith('.info.json') && !f.endsWith('.part'));
        if (!audioFile) throw new Error('音声ファイルの取得に失敗しました');

        let meta = {};
        const infoFile = files.find((f) => f.endsWith('.info.json'));
        if (infoFile) {
            try {
                meta = JSON.parse(await fs.readFile(path.join(result.dir, infoFile), 'utf8'));
            } catch { /* メタが読めなくても続行 */ }
        }

        const ext = path.extname(audioFile).slice(1) || 'm4a';
        const mime = extToMime(ext);
        const title = meta.title || `YouTube (${videoId})`;
        const artist = meta.uploader || meta.channel || '';
        const duration = Math.round(Number(meta.duration) || 0);

        const filePath = path.join(result.dir, audioFile);
        const stat = await fs.stat(filePath);
        if (abort.signal.aborted) return cleanup();

        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Track-Title', encodeURIComponent(title));
        res.setHeader('X-Track-Artist', encodeURIComponent(artist));
        res.setHeader('X-Track-Duration', String(duration));
        res.setHeader('X-Track-Ext', ext);

        const stream = createReadStream(filePath);
        stream.on('error', () => {
            if (!res.headersSent) res.status(500).end();
            else res.destroy();
        });
        res.on('close', cleanup);
        stream.pipe(res);
    } catch (err) {
        cleanup();
        console.error('[youtube error]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: '音声の取り込みに失敗しました。しばらく待ってからもう一度お試しください。' });
        }
    }
});

app.listen(PORT, () => {
    console.log(`oto-app yt-dlp server listening on port ${PORT}`);
    updateYtDlp();
});
