/**
 * プロンプト v2（具体性・実行可能性・検索意図・サービス導線・事実性の強化）のテスト。
 * Claude API は呼ばず、送信されるリクエストの中身と、生成後の検証（要確認の警告）を確認する。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('./helpers/load-gas');
const { BASE_PROPS, makeArticle, claudeSuccess, japaneseText } = require('./helpers/fixtures');

const V1_SNAPSHOT = fs.readFileSync(path.join(__dirname, 'fixtures', 'prompt-v1-system.txt'), 'utf8');

function setup(props = {}, handler) {
  const env = loadGas({ properties: Object.assign({}, BASE_PROPS, props), fetchHandler: handler || (() => claudeSuccess(makeArticle())) });
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  return env;
}
function sentBody(env, i = 0) {
  return JSON.parse(env.state.fetchCalls[i].options.payload);
}
function userText(body) {
  return body.messages[0].content.map ? [].concat(body.messages[0].content).map((c) => (typeof c === 'string' ? c : c.text)).join('') : body.messages[0].content;
}
function systemText(body) {
  return typeof body.system === 'string' ? body.system : body.system.map((b) => b.text).join('');
}
/** 本文に文章を差し込んだ記事（文字数などの仕様は満たす） */
function articleWith(extra, where = 'summary') {
  const a = makeArticle();
  if (where === 'summary') a.summary = a.summary + '\n\n' + extra;
  else a.sections[1].body = a.sections[1].body + '\n\n' + extra;
  return a;
}

// ---- 設定と版の切り替え ----

test('プロンプト版：既定は v2。PROMPT_VERSION=v1 で初期版に戻せ、不正値は v2 になる', () => {
  assert.equal(setup().gas.getSettings_().promptVersion, 'v2');
  assert.equal(setup({ PROMPT_VERSION: 'v1' }).gas.getSettings_().promptVersion, 'v1');
  assert.equal(setup({ PROMPT_VERSION: 'V1' }).gas.getSettings_().promptVersion, 'v1');
  assert.equal(setup({ PROMPT_VERSION: 'v9' }).gas.getSettings_().promptVersion, 'v2');
});

test('プロンプト版：v1 は初期コミット（2aeaddb）の文言と完全に一致する（改善前との比較用）', () => {
  const { gas } = setup();
  assert.equal(gas.buildSystemPrompt_({ promptVersion: 'v1' }), V1_SNAPSHOT);
  assert.notEqual(gas.buildSystemPrompt_({ promptVersion: 'v2' }), V1_SNAPSHOT);
  assert.equal(gas.buildSystemPrompt_(), gas.buildSystemPrompt_({ promptVersion: 'v2' }), '引数なしは v2');
});

test('サービス設定：既定は「キンタイ Cloud」、Script Properties で名前・カテゴリ・確定情報を上書きできる', () => {
  const s1 = setup().gas.getSettings_();
  assert.equal(s1.serviceName, 'キンタイ Cloud');
  assert.equal(s1.serviceFacts, '');
  const s2 = setup({ SERVICE_NAME: '別サービス', SERVICE_CATEGORY: '給与計算サービス', SERVICE_FACTS: '無料トライアルあり' }).gas.getSettings_();
  assert.deepEqual([s2.serviceName, s2.serviceCategory, s2.serviceFacts], ['別サービス', '給与計算サービス', '無料トライアルあり']);
});

// ---- v2 の指示内容 ----

test('v2：既存の仕様（2,000〜3,000文字・H2ちょうど3つ・まとめ・説明文120文字以内）を維持している', () => {
  const p = setup().gas.buildSystemPrompt_({ promptVersion: 'v2' });
  ['2000〜3000文字', 'ちょうど3つ', '120文字以内', 'まとめ', '導入'].forEach((w) => assert.ok(p.includes(w), w));
});

test('v2：具体的な業務場面・実行できる手順・検索意図に答える見出しを指示している', () => {
  const p = setup().gas.buildSystemPrompt_({ promptVersion: 'v2' });
  assert.match(p, /具体的な業務場面を最低1つ/);
  assert.match(p, /誰が・いつ・どの作業で・何に困るか/);
  assert.match(p, /3〜5個の箇条書き/);
  assert.match(p, /確認方法/);
  assert.match(p, /いちばん知りたい問いに直接答える/);
  assert.match(p, /抽象的な見出しにしない/);
  assert.match(p, /最初の3文以内で「この記事の結論/);
});

test('v2：仮の計算例には注記を必須にし、実績・調査結果に見える書き方を禁止している', () => {
  const p = setup().gas.buildSystemPrompt_({ promptVersion: 'v2' });
  assert.ok(p.includes('※以下は説明のための仮の数値です。実際の数値は職場によって異なります。'));
  assert.match(p, /実績・調査結果・平均値のように見える書き方をしない/);
  assert.match(p, /実話・事例・体験談として書かない/);
});

test('v2：サービス導線は控えめに（関連時のみ・最大2回）、確定情報以外の機能・料金・実績を書かせない', () => {
  const p = setup().gas.buildSystemPrompt_({ promptVersion: 'v2' });
  assert.match(p, /関連があるときだけ、まとめの中で1回/);
  assert.match(p, /最大2回/);
  assert.match(p, /<service_facts> に書かれている内容だけ/);
  assert.match(p, /<service_facts> がない場合は、機能・料金・実績・効果を一切書かない/);
  assert.match(p, /関連が薄い場合は、サービスに触れない/);
  assert.match(p, /売り込み表現/);
});

test('v2：法令・制度は数値や期限を断定せず、公的情報・専門家への確認を促す', () => {
  const p = setup().gas.buildSystemPrompt_({ promptVersion: 'v2' });
  assert.match(p, /条文番号・具体的な数値・期限を断定しない/);
  assert.match(p, /厚生労働省/);
  assert.match(p, /社会保険労務士/);
  assert.match(p, /改正/);
  assert.match(p, /存在を確認できない製品・機能・事例・料金/);
});

// ---- 実際に送られるリクエスト ----

test('リクエスト（v2）：システムプロンプトが v2、ユーザープロンプトにサービス名と「情報なし」の注意が入る', () => {
  const env = setup();
  assert.equal(env.gas.generateArticleForRow_(2).ok, true);
  const body = sentBody(env);
  assert.equal(systemText(body), env.gas.buildSystemPrompt_({ promptVersion: 'v2' }));
  const u = userText(body);
  assert.match(u, /<service_name>キンタイ Cloud<\/service_name>/);
  assert.match(u, /<service_category>勤怠管理サービス<\/service_category>/);
  assert.match(u, /機能・料金・実績の情報は提供されていません/);
  assert.doesNotMatch(u, /<service_facts>/);
  assert.equal(body.output_config.format.type, 'json_schema', '出力形式（JSON Schema）は変わらない');
});

test('リクエスト（v2）：SERVICE_FACTS を設定すると、その内容だけが確定情報として渡される', () => {
  const env = setup({ SERVICE_FACTS: '- スマートフォンで打刻できる（テスト用の値）' });
  env.gas.generateArticleForRow_(2);
  const u = userText(sentBody(env));
  assert.match(u, /<service_facts>\n- スマートフォンで打刻できる（テスト用の値）\n<\/service_facts>/);
  assert.doesNotMatch(u, /提供されていません/);
});

test('リクエスト（v1）：初期版と同じ入力（サービス情報なし）で送られ、比較できる', () => {
  const env = setup({ PROMPT_VERSION: 'v1' });
  env.gas.generateArticleForRow_(2);
  const body = sentBody(env);
  assert.equal(systemText(body), V1_SNAPSHOT);
  assert.doesNotMatch(userText(body), /<service/);
});

test('比較用の記録：処理結果と実行ログにプロンプト版が残る（既存の列構成は変えない）', () => {
  const env = setup({ PROMPT_VERSION: 'v1' });
  env.gas.generateArticleForRow_(2);
  assert.match(env.gas.getArticleRow_(2).resultMessage, /プロンプトv1/);
  const env2 = setup();
  env2.gas.generateArticleForRow_(2);
  assert.match(env2.gas.getArticleRow_(2).resultMessage, /プロンプトv2/);
  const log = env2.spreadsheet.getSheetByName('実行ログ');
  assert.match(String(log.getCell(log.getLastRow(), 5)), /プロンプトv2/);
  assert.equal(env2.spreadsheet.getSheetByName('記事本文').getLastColumn(), 12, '記事本文シートは12列のまま');
});

// ---- 生成後の確認（要確認の警告。書き直し＝再課金はしない） ----

test('検証：サービス名が3回以上出てくると「宣伝が強すぎないか」の要確認（空白・全角の違いも数える）', () => {
  const { gas } = setup();
  const ok = gas.normalizeArticle_(articleWith('勤怠の集計に困ったら、キンタイ Cloud のようなサービスを確認するのも一つの方法です。'));
  assert.equal(gas.validateArticle_(ok, '勤怠管理', '', 'キンタイ Cloud').warnings.length, 0);
  const many = gas.normalizeArticle_(articleWith('キンタイ Cloudなら安心。キンタイＣｌｏｕｄで解決。キンタイ　Cloud をぜひ。'));
  const v = gas.validateArticle_(many, '勤怠管理', '', 'キンタイ Cloud');
  assert.equal(v.serviceMentions, 3);
  assert.ok(v.warnings.some((w) => w.includes('宣伝が強すぎないか')));
  assert.equal(v.errors.length, 0, '警告のみ（書き直しの対象にしない）');
});

test('検証：誇大・断定表現（絶対・100%・No.1・業界最安など）を要確認にする', () => {
  const { gas } = setup();
  const a = gas.normalizeArticle_(articleWith('この方法なら絶対に残業が減り、満足度100％、業界最安のNo.1サービスです。'));
  const w = gas.validateArticle_(a, '勤怠管理', '', '').warnings.join('');
  ['絶対に', '100%', '業界最安', 'No.1'].forEach((x) => assert.ok(w.includes(x), x));
  // 「No.10」のような番号は誤検知しない
  const b = gas.normalizeArticle_(articleWith('手順No.10を参照してください。'));
  assert.equal(gas.validateArticle_(b, '勤怠管理', '', '').warnings.length, 0);
});

test('検証：試算・計算例に「仮の数値」の注記がなければ要確認、注記があれば問題なし', () => {
  const { gas } = setup();
  const bad = gas.normalizeArticle_(articleWith('たとえば従業員30人で1人あたり月10分の確認作業がある場合で計算すると、月300分になります。', 'section'));
  assert.ok(gas.validateArticle_(bad, '勤怠管理', '', '').warnings.some((w) => w.includes('仮の数値')));
  const good = gas.normalizeArticle_(articleWith('※以下は説明のための仮の数値です。実際の数値は職場によって異なります。\n従業員30人で1人あたり月10分の確認作業がある場合で計算すると、月300分になります。', 'section'));
  assert.equal(gas.validateArticle_(good, '勤怠管理', '', '').warnings.length, 0);
});

test('検証：注意（警告のみ）では書き直さず、ステータスは「生成済み」・処理結果は「注意：」（API呼び出しは1回のまま）', () => {
  const env = setup({}, () => claudeSuccess(articleWith('絶対に解決します。')));
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);
  assert.equal(env.state.fetchCalls.length, 1);
  assert.match(env.gas.getArticleRow_(2).resultMessage, /^注意：.*誇大・断定表現/);
  assert.equal(env.gas.getArticleRow_(2).status, '生成済み');
});

test('出力形式：JSON Schema は変更していない（既存データ・変換処理と互換）', () => {
  const { gas } = setup();
  assert.deepEqual(Object.keys(gas.ARTICLE_SCHEMA.properties), ['title', 'meta_description', 'introduction', 'sections', 'summary']);
  assert.ok(japaneseText(10).length > 0);
});

// ---- v1/v2 実測比較を受けた追加（効果・費用の断定、箇条書きの HTML 変換） ----

test('v2：効果・費用・手間を断定しないよう、避ける例と書き方の例を示している', () => {
  const p = setup().gas.buildSystemPrompt_({ promptVersion: 'v2' });
  assert.match(p, /効果・費用・手間・期間は職場によって異なるため断定しない/);
  assert.ok(p.includes('「費用や体制の変更は要らず、効果は翌月の締め作業で確認できます」'));
  assert.match(p, /条件や可能性として書く/);
  assert.match(p, /「費用はかからない」「体制変更は不要」と断定しない/);
  assert.doesNotMatch(p, /費用や大きな体制変更が要らない方法から/, '断定を誘う旧指示は削除');
  assert.match(p, /順番のある手順は「1. 」/);
});

test('検証：「費用や体制の変更は要らず、効果は翌月の締め作業で確認できます」を要確認にし、条件付きの書き方は通す', () => {
  const { gas } = setup();
  const bad = gas.normalizeArticle_(articleWith('費用や体制の変更は要らず、効果は翌月の締め作業で確認できます。', 'section'));
  const w = gas.validateArticle_(bad, '勤怠管理', '', '').warnings.join('');
  assert.match(w, /効果・費用を断定している可能性/);
  assert.match(w, /費用や体制の変更は要らず/);
  const good = gas.normalizeArticle_(articleWith('多くの場合、追加の費用をかけずに試せます。翌月の締め作業で、集計にかかった時間を前月と比べてみてください。効果が期待できます。', 'section'));
  assert.equal(gas.validateArticle_(good, '勤怠管理', '', '').warnings.length, 0);
});

test('HTML変換：段落の直後に空行なしで続く箇条書きも <p> と <ul><li> に分かれる', () => {
  const { gas } = setup();
  const html = gas.paragraphsToHtml_('手順は次のとおりです。\n- 打刻データを出力する\n- 申請書と突き合わせる\n- 差異を記録する\n\n最後に見直します。');
  assert.equal(html, [
    '<p>手順は次のとおりです。</p>',
    '<ul>\n<li>打刻データを出力する</li>\n<li>申請書と突き合わせる</li>\n<li>差異を記録する</li>\n</ul>',
    '<p>最後に見直します。</p>'
  ].join('\n'));
});

test('HTML変換：番号付きの手順（1. / 2) / ３．）は <ol><li>、「・」も箇条書きになる', () => {
  const { gas } = setup();
  assert.equal(gas.paragraphsToHtml_('1. 現状を書き出す\n2) 担当を決める\n3．週1回見直す'),
    '<ol>\n<li>現状を書き出す</li>\n<li>担当を決める</li>\n<li>週1回見直す</li>\n</ol>');
  assert.equal(gas.paragraphsToHtml_('・紙の申請\n・エクセル集計'), '<ul>\n<li>紙の申請</li>\n<li>エクセル集計</li>\n</ul>');
});

test('HTML変換：箇条書きに見えるが箇条書きでない行（-10%、2026年、*強調*）は段落のまま', () => {
  const { gas } = setup();
  assert.equal(gas.paragraphsToHtml_('-10%の削減を目指す例です。'), '<p>-10%の削減を目指す例です。</p>');
  assert.equal(gas.paragraphsToHtml_('2026年の制度について'), '<p>2026年の制度について</p>');
  assert.equal(gas.paragraphsToHtml_('*注意*してください'), '<p>*注意*してください</p>');
});

test('HTML変換：箇条書きの中身もエスケープされ、記事全体で ul/ol と li の開始・終了タグ数が一致する', () => {
  const { gas } = setup();
  const a = makeArticle();
  a.sections[1].body = a.sections[1].body + '\n\n改善の手順：\n1. <b>現状</b>を確認\n2. A & B を比較\n- 補足\n\nまとめの段落。';
  const html = gas.articleToHtml_(gas.normalizeArticle_(a));
  assert.ok(html.includes('<li>&lt;b&gt;現状&lt;/b&gt;を確認</li>'));
  assert.ok(html.includes('<li>A &amp; B を比較</li>'));
  const count = (re) => (html.match(re) || []).length;
  assert.equal(count(/<ol>/g), count(/<\/ol>/g));
  assert.equal(count(/<ul>/g), count(/<\/ul>/g));
  assert.equal(count(/<li>/g), count(/<\/li>/g));
  assert.equal(count(/<li>/g), 3);
  assert.doesNotMatch(html, /<p>[^<]*<br>- /, '箇条書きが段落内に残っていない');
});

test('テスト用キーワード：案件の正式な5本（勤怠管理関連）で、既存の「勤怠管理 エクセル 限界」の行は重複追加しない', () => {
  const env = loadGas({ properties: BASE_PROPS });
  const { gas } = env;
  assert.deepEqual(Array.from(gas.TEST_KEYWORDS, (k) => [k.keyword, k.sub]), [
    ['勤怠管理 エクセル 限界', ''],
    ['有給休暇 管理 方法', '5日義務, 取得率'],
    ['テレワーク 勤怠管理 課題', '打刻, 中抜け'],
    ['36協定 残業時間 上限', '特別条項, 罰則'],
    ['勤怠管理システム 比較 選び方', 'クラウド, 料金']
  ]);
  gas.setupSheets_();
  const sheet = env.spreadsheet.getSheetByName('記事管理');
  // 実シートと同じく、v1・v2 の2行が既にある状態
  sheet.appendRow(['KW-001', '勤怠管理 エクセル 限界', '', '生成済み', 'v1の記事', '', 2211, '', '', 'OK', '', '', 1]);
  sheet.appendRow(['KW-002', '勤怠管理 エクセル 限界', '', '生成済み', 'v2の記事', '', 2110, '', '', 'OK', '', '', 1]);
  assert.equal(gas.addTestKeywords_(), 4);
  const rows = gas.listArticleRows_();
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.id, r.title, r.status]), [['KW-001', 'v1の記事', '生成済み'], ['KW-002', 'v2の記事', '生成済み']]);
  assert.deepEqual(rows.slice(2).map((r) => [r.id, r.keyword, r.status]), [
    ['KW-003', '有給休暇 管理 方法', '未生成'],
    ['KW-004', 'テレワーク 勤怠管理 課題', '未生成'],
    ['KW-005', '36協定 残業時間 上限', '未生成'],
    ['KW-006', '勤怠管理システム 比較 選び方', '未生成']
  ]);
});
