// 音声ファイルから曲名・アーティスト・アルバム・ジャケット画像を読み取る(MP3のID3v2タグ)
// 読めない形式はファイル名から推測する

function syncsafe(b, o) {
  return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
}

function decodeText(bytes, enc) {
  let label = 'latin1';
  if (enc === 1) label = 'utf-16';
  else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes).replace(/\0+$/g, '').replace(/\0/g, ' / ').trim();
  } catch {
    return '';
  }
}

// 文字コードに応じた終端(0x00 or 0x0000)の位置を探す
function findTerminator(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  } else {
    for (let i = start; i < b.length; i++) if (b[i] === 0) return i;
  }
  return b.length;
}

function parseID3(buf) {
  const b = new Uint8Array(buf);
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null; // "ID3"
  const ver = b[3];
  if (ver < 3 || ver > 4) return null;
  const size = syncsafe(b, 6);
  const end = Math.min(10 + size, b.length);
  let p = 10;
  if (b[5] & 0x40) p += ver === 4 ? syncsafe(b, 10) : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4;
  const out = {};
  while (p + 10 <= end) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]);
    const body = b.subarray(p + 10, p + 10 + fsize);
    p += 10 + fsize;
    if (fsize <= 0) continue;
    const enc = body[0];
    if (id === 'TIT2') out.title = decodeText(body.subarray(1), enc);
    else if (id === 'TPE1') out.artist = decodeText(body.subarray(1), enc);
    else if (id === 'TALB') out.album = decodeText(body.subarray(1), enc);
    else if (id === 'APIC' && !out.picture) {
      const mimeEnd = findTerminator(body, 1, 0);
      let mime = new TextDecoder('latin1').decode(body.subarray(1, mimeEnd)) || 'image/jpeg';
      if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase();
      const descStart = mimeEnd + 2; // 終端 + 画像種別1バイト
      const descEnd = findTerminator(body, descStart, enc);
      const imgStart = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
      out.picture = new Blob([body.slice(imgStart)], { type: mime });
    }
  }
  return out;
}

function fromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: base };
}

function readDuration(file) {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

// ジャケット画像は大きすぎることが多いので 512px 以内に縮小して保存する
async function shrinkImage(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return null;
  }
}

export async function readTags(file) {
  const guess = fromFilename(file.name);
  let tags = null;
  try {
    tags = parseID3(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  } catch { /* 読めなければファイル名を使う */ }
  const picture = tags?.picture ? await shrinkImage(tags.picture) : null;
  return {
    title: tags?.title || guess.title,
    artist: tags?.artist || guess.artist || '',
    album: tags?.album || '',
    picture,
    duration: await readDuration(file),
  };
}
