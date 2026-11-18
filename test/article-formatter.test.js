'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/load-gas');
const { makeArticle, japaneseText } = require('./helpers/fixtures');

const plain = (v) => JSON.parse(JSON.stringify(v));

test('文字数カウント：空白・改行・Markdown記号を除外する', () => {
  const { gas } = loadGas();
  assert.equal(gas.countArticleChars_('## 見出し\n\nあいう えお\n- 項目'), 3 + 5 + 2);
});

test('正常な記事は検証エラーなし（2,000〜3,000文字・H2が3つ・説明文120字以内）', () => {
  const { gas } = loadGas();
  const a = gas.normalizeArticle_(makeArticle());
  const v = gas.validateArticle_(a, '勤怠管理 エクセル 限界', '');
  assert.deepEqual(plain(v.errors), []);
  assert.ok(v.charCount >= 2000 && v.charCount <= 3000, `charCount=${v.charCount}`);
  assert.ok(v.metaLength <= 120);
});

test('文字数不足・超過・見出し数違反をエラーとして検出する', () => {
  const { gas } = loadGas();
  const short = gas.validateArticle_(gas.normalizeArticle_(makeArticle({ sectionChars: 300 })), 'x', '');
  assert.match(short.errors.join(), /短すぎます/);
  const long = gas.validateArticle_(gas.normalizeArticle_(makeArticle({ sectionChars: 1200 })), 'x', '');
  assert.match(long.errors.join(), /長すぎます/);
  const raw = makeArticle();
  raw.sections = raw.sections.slice(0, 2);
  const two = gas.validateArticle_(gas.normalizeArticle_(raw), 'x', '');
  assert.match(two.errors.join(), /H2見出しが2個/);
});

test('必須項目が欠けたJSONは INVALID_RESPONSE', () => {
  const { gas } = loadGas();
  assert.throws(() => gas.normalizeArticle_({ title: 'a' }), (e) => e.code === 'INVALID_RESPONSE');
});

test('メタディスクリプションを120文字以内に切り詰める（句点優先）', () => {
  const { gas } = loadGas();
  const long = 'あ'.repeat(90) + '。' + 'い'.repeat(60);
  const r = gas.fitMetaDescription_(long);
  assert.equal(r.trimmed, true);
  assert.equal(r.text, 'あ'.repeat(90) + '。');
  const noPeriod = gas.fitMetaDescription_('う'.repeat(150));
  assert.equal(Array.from(noPeriod.text).length, 120);
  assert.ok(noPeriod.text.endsWith('…'));
  assert.equal(gas.fitMetaDescription_('短い説明').trimmed, false);
});

test('タイトルにメインキーワードがない場合は警告', () => {
  const { gas } = loadGas();
  const a = gas.normalizeArticle_(makeArticle({ article: { title: '集中のコツ' } }));
  const v = gas.validateArticle_(a, '勤怠管理 エクセル 限界', '');
  assert.match(v.warnings.join(), /勤怠管理/);
});

test('サンプル記事の丸写し（25文字以上の一致）を検出する', () => {
  const { gas } = loadGas();
  const sample = '片づけが続かないのは意志が弱いからではありません。最初のハードルを高くしすぎていることが原因です。';
  const copied = gas.normalizeArticle_(makeArticle({
    article: { introduction: '冒頭です。' + sample + 'それでは始めましょう。' + japaneseText(150) }
  }));
  const v = gas.validateArticle_(copied, '勤怠管理', sample);
  assert.ok(v.overlaps.length > 0);
  assert.match(v.warnings.join(), /サンプル記事と25文字以上一致/);

  const original = gas.normalizeArticle_(makeArticle());
  assert.equal(gas.validateArticle_(original, '勤怠管理', sample).overlaps.length, 0);
});

test('HTML変換：H2・段落・箇条書き・エスケープ', () => {
  const { gas } = loadGas();
  const a = gas.normalizeArticle_(makeArticle({
    article: {
      introduction: '導入<script>alert(1)</script>',
      sections: [
        { heading: '## 見出し1', body: '段落1\n\n- 項目A\n- 項目B' },
        { heading: '見出し2', body: 'A & B' },
        { heading: '見出し3', body: '"引用"' }
      ]
    }
  }));
  const html = gas.articleToHtml_(a);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<h2>見出し1</h2>'), '先頭の#は除去される');
  assert.ok(html.includes('<ul>\n<li>項目A</li>\n<li>項目B</li>\n</ul>'));
  assert.ok(html.includes('A &amp; B'));
  assert.equal((html.match(/<h2>/g) || []).length, 4, 'H2×3 + まとめ');
  assert.ok(!html.includes('<h1>'), 'タイトルは本文に含めない');
});

test('Markdown変換：タイトル・H2・まとめを含む', () => {
  const { gas } = loadGas();
  const md = gas.articleToMarkdown_(gas.normalizeArticle_(makeArticle()));
  assert.ok(md.startsWith('# 勤怠管理'));
  assert.equal((md.match(/^## /gm) || []).length, 4);
  assert.ok(md.includes('## まとめ'));
});
