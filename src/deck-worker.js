// 提案資料の PDF を絵にして数える作業だけを、別の小さなプロセスでする。
// 絵をかく道具（ネイティブのライブラリ）が万一落ちても、knowkin 本体（コネクタ・画面）が止まらないようにするため。
import { analyzePdf } from './deck-design.js';

process.on('message', async ({ file }) => {
  try {
    const fs = await import('node:fs/promises');
    const pdf = await fs.readFile(file);
    const pages = [];
    const r = await analyzePdf(pdf, async (i, { jpg, text }) => { pages.push({ i, jpg: Buffer.from(jpg).toString('base64'), text }); });
    process.send({ ok: true, designs: r.designs, summary: r.summary, pages }, () => process.exit(0));
  } catch (e) {
    process.send({ ok: false, error: e.message || String(e) }, () => process.exit(0));
  }
});
