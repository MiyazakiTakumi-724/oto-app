import ytdl from '@distube/ytdl-core';

const YT_ID_RE = /^[\w-]{11}$/;

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

function getAgent() {
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw) return undefined;
  try {
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length > 0) {
      const cleaned = cookies
        .filter((c) => c && c.name && c.value)
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.youtube.com',
          path: c.path || '/',
        }));
      if (cleaned.length > 0) return ytdl.createAgent(cleaned);
    }
  } catch (e) {
    console.warn('YOUTUBE_COOKIES のJSONパースに失敗しました:', e.message);
  }
  return undefined;
}

async function fetchInfoWithFallback(videoUrl, agent) {
  const attempts = [
    { ...(agent ? { agent } : {}), playerClients: ['TV', 'WEB_EMBEDDED', 'WEB'] },
    { ...(agent ? { agent } : {}), playerClients: ['IOS', 'ANDROID'] },
    ...(agent ? [{ agent }] : [{}]),
  ];

  let lastErr;
  for (const opts of attempts) {
    try {
      const info = await ytdl.getInfo(videoUrl, opts);
      const audios = ytdl.filterFormats(info.formats, 'audioonly');
      if (audios.length > 0) return { info, audios };
    } catch (e) {
      lastErr = e;
      console.warn('[ytdl attempt failed]', opts.playerClients || 'default', e?.message);
    }
  }
  throw lastErr || new Error('Failed to find any playable formats');
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const thumbId = searchParams.get('thumb');
  if (!thumbId || !YT_ID_RE.test(thumbId)) {
    return Response.json({ error: '不正なリクエストです' }, { status: 400 });
  }

  for (const quality of ['hqdefault.jpg', 'mqdefault.jpg']) {
    const res = await fetch(`https://i.ytimg.com/vi/${thumbId}/${quality}`);
    if (res.ok) {
      return new Response(res.body, {
        status: 200,
        headers: {
          'Content-Type': res.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }
  }
  return new Response(null, { status: 404 });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON形式で送信してください' }, { status: 400 });
  }

  const videoId = extractVideoId(body?.id || body?.url);
  if (!videoId) {
    return Response.json({ error: '有効なYouTubeの動画URLを入力してください' }, { status: 400 });
  }

  try {
    const agent = getAgent();
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const { info, audios: audioFormats } = await fetchInfoWithFallback(videoUrl, agent);

    // iOS Safari 互換性のため audio/mp4 (M4A/AAC) を最優先で選ぶ
    const mp4Audios = audioFormats
      .filter((f) => f.container === 'mp4' || f.mimeType?.includes('audio/mp4'))
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));

    const format = mp4Audios[0] || ytdl.chooseFormat(audioFormats, { quality: 'highestaudio' });
    const mime = format.mimeType?.split(';')[0]?.trim() || 'audio/mp4';
    const ext = mime === 'audio/mp4' ? 'm4a' : (format.container || 'webm');

    const title = info.videoDetails?.title || `YouTube (${videoId})`;
    const artist = info.videoDetails?.author?.name || '';
    const duration = Number(info.videoDetails?.lengthSeconds) || 0;

    const nodeStream = ytdl.downloadFromInfo(info, {
      format,
      ...(agent ? { agent } : {}),
    });

    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on('data', (chunk) => controller.enqueue(chunk));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });

    const headers = new Headers({
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'X-Track-Title': encodeURIComponent(title),
      'X-Track-Artist': encodeURIComponent(artist),
      'X-Track-Duration': String(duration),
      'X-Track-Ext': ext,
    });
    if (format.contentLength) {
      headers.set('Content-Length', String(format.contentLength));
    }

    return new Response(webStream, { status: 200, headers });
  } catch (err) {
    const msg = String(err?.message || err);
    console.error('[api/youtube error]', msg);

    if (/Sign in to confirm|bot|429|LOGIN_REQUIRED/i.test(msg)) {
      return Response.json(
        { error: 'YouTubeのボット判定によりブロックされました。YOUTUBE_COOKIES を更新してください。' },
        { status: 502 }
      );
    }
    return Response.json(
      { error: `音声の取り込みに失敗しました (${msg})` },
      { status: 500 }
    );
  }
}