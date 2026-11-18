/**
 * テスト用のダミーデータ（Claude / WordPress のレスポンス）。
 * 実APIを呼ばずに、本番と同じ形式のレスポンスを返す。
 */
'use strict';

const { httpResponse } = require('./gas-mock');

const FAKE_API_KEY = 'sk-ant-test-FAKE-KEY-0000000000';
const FAKE_WP_PASSWORD = 'abcd EFGH ijkl MNOP qrst UVWX';

const BASE_PROPS = { CLAUDE_API_KEY: FAKE_API_KEY };
const WP_PROPS = {
  CLAUDE_API_KEY: FAKE_API_KEY,
  WP_BASE_URL: 'https://blog.example.com/',
  WP_USERNAME: 'editor',
  WP_APP_PASSWORD: FAKE_WP_PASSWORD
};

/** 指定文字数（空白除く）の日本語文章を作る */
function japaneseText(chars, seed = 'あ') {
  const sentence = `${seed}について具体的な手順を順番に説明していきますので参考にしてください。`;
  let out = '';
  while (out.length < chars) out += sentence;
  out = out.slice(0, chars);
  // 段落を2つに分ける（空行区切り）
  const mid = Math.floor(out.length / 2);
  return out.slice(0, mid) + '\n\n' + out.slice(mid);
}

/**
 * 記事JSONを作る。sectionChars で本文量を調整（既定は合計約2,500文字）
 */
function makeArticle(overrides = {}) {
  const sectionChars = overrides.sectionChars || 700;
  return Object.assign({
    title: '勤怠管理をエクセルで続ける限界と見直しの4ステップ',
    meta_description: '勤怠管理をエクセルで続けると、締め作業の手間や集計ミスが増えがちです。限界のサインと、今日からできる見直しの手順を解説します。',
    introduction: japaneseText(200, '導入'),
    sections: [
      { heading: 'エクセル管理が限界になる3つのサイン', body: japaneseText(sectionChars, '原因') },
      { heading: '集計ミスを減らす見直しの手順', body: japaneseText(sectionChars, '手順') },
      { heading: '仕組みを変えるか判断するポイント', body: japaneseText(sectionChars, '判断') }
    ],
    summary: japaneseText(200, 'まとめ')
  }, overrides.article || {});
}

/** Claude Messages API の成功レスポンス */
function claudeSuccess(article, extra = {}) {
  return httpResponse(200, Object.assign({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: JSON.stringify(article) }
    ],
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 1200, output_tokens: 3400 }
  }, extra));
}

function claudeError(code, type, message, headers = {}) {
  return httpResponse(code, { type: 'error', error: { type, message } }, headers);
}

function wpPost(id, status = 'draft') {
  return { id, status, link: `https://blog.example.com/?p=${id}`, slug: 'aiblog-kw-001' };
}

module.exports = {
  FAKE_API_KEY, FAKE_WP_PASSWORD, BASE_PROPS, WP_PROPS,
  japaneseText, makeArticle, claudeSuccess, claudeError, wpPost, httpResponse
};
