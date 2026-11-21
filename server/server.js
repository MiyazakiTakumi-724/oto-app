import express from 'express';
import cors from 'cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
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

app.get('/health', (_req, res) => {
    res.json({ ok: true });
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

    let tmpDir;
    try {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oto-yt-'));
        const outTpl = path.join(tmpDir, 'audio.%(ext)s');
        const args = [
            '--no-playlist',
            '--js-runtimes', 'deno',
            '--remote-components', 'ejs:github',
            '--concurrent-fragments', '4',
            '-f', 'bestaudio[ext=m4a]/bestaudio/best',
            '--write-info-json',
            '-o', outTpl,
        ];

        const cookieText = toNetscapeCookies(process.env.YOUTUBE_COOKIES);
        if (cookieText) {
            const cookieFile = path.join(tmpDir, 'cookies.txt');
            await fs.writeFile(cookieFile, cookieText, 'utf8');
            args.push('--cookies', cookieFile);
        }

        args.push('--', `https://www.youtube.com/watch?v=${videoId}`);

        await execFileAsync('yt-dlp', args, {
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
        });

        const files = await fs.readdir(tmpDir);
        const audioFile = files.find((f) => f.startsWith('audio.') && !f.endsWith('.info.json') && !f.endsWith('.part'));
        if (!audioFile) throw new Error('音声ファイルの取得に失敗しました');

        let meta = {};
        const infoFile = files.find((f) => f.endsWith('.info.json'));
        if (infoFile) {
            try {
                meta = JSON.parse(await fs.readFile(path.join(tmpDir, infoFile), 'utf8'));
            } catch { /* メタが読めなくても続行 */ }
        }

        const ext = path.extname(audioFile).slice(1) || 'm4a';
        const mime = extToMime(ext);
        const title = meta.title || `YouTube (${videoId})`;
        const artist = meta.uploader || meta.channel || '';
        const duration = Math.round(Number(meta.duration) || 0);

        const filePath = path.join(tmpDir, audioFile);
        const stat = await fs.stat(filePath);

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
        });
        res.on('close', () => {
            fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
        });
        stream.pipe(res);
    } catch (err) {
        if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
        const detail = String(err.stderr || err.message || err);
        console.error('[yt-dlp error]', detail);

        if (/Sign in to confirm|bot|cookies|429/i.test(detail)) {
            return res.status(502).json({
                error: 'YouTubeのボット判定によりブロックされました。Renderの環境変数 YOUTUBE_COOKIES を設定・更新してください。',
            });
        }
        return res.status(500).json({
            error: '音声の取り込みに失敗しました。しばらく待ってからもう一度お試しください。',
        });
    }
});

app.listen(PORT, () => {
    console.log(`oto-app yt-dlp server listening on port ${PORT}`);
});