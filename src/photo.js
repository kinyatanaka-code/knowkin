import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

/** 写真を長辺1600px・JPEGに縮める（Claudeが読みやすく、容量も小さくなる） */
export async function toJpeg(buffer, mimetype = '') {
  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `${id}.img`);
  const outPath = path.join(os.tmpdir(), `${id}.jpg`);
  await fs.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-i', inPath, '-vf', "scale='if(gt(iw,ih),min(1600,iw),-2)':'if(gt(iw,ih),-2,min(1600,ih))'", '-frames:v', '1', '-q:v', '4', outPath]);
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-200)))));
    });
    return { data: await fs.readFile(outPath), mime: 'image/jpeg' };
  } catch (e) {
    // 変換できない形式でも、そのまま扱える画像なら小さければ保存する
    if (/^image\/(jpeg|png|webp|gif)$/.test(mimetype) && buffer.length <= 5 * 1024 * 1024) return { data: buffer, mime: mimetype };
    throw new Error('写真を読み込めませんでした。JPEGかPNGで保存してからお試しください');
  } finally {
    await fs.rm(inPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}
