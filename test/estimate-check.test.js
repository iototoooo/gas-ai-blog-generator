/**
 * 「仮の数値」チェックの改善（P1）のテスト。
 * - 36協定の記事（G-3）で、法令の数値・日付に反応した誤警告を再現し、出なくなったことを確認
 * - 仮定した人数・日数・金額の計算例は引き続き検出する
 * - 注記は記事のどこかではなく、計算例の近く（同じ導入・H2・まとめの中）に必要
 * - 判断できない例は安全とみなさず「注意」にする
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/load-gas');
const { BASE_PROPS, makeArticle, claudeSuccess } = require('./helpers/fixtures');

const LABEL = '※以下は説明のための仮の数値です。実際の数値は職場によって異なります。';

function gasEnv(handler) {
  const env = loadGas({ properties: BASE_PROPS, fetchHandler: handler });
  env.gas.setupSheets_();
  env.gas.addTestKeywords_();
  return env;
}
const { gas } = gasEnv();
const issues = (text) => gas.findEstimateIssues_([text]);
const kind = (s) => gas.classifyEstimateSentence_(String(s).normalize('NFKC'));

/** 修正前の判定（記事全体で「例示の言葉＋単位つき数値」があり、注記が記事のどこにもなければ警告） */
function oldHasUnlabeledEstimate(text) {
  const t = String(text).normalize('NFKC');
  const hit = t.split(/[。\n]/).some((s) =>
    /試算|計算例|計算すると|で計算|仮に|たとえば|例えば/.test(s) &&
    /\d+(\.\d+)?\s*(人|名|時間|日|分|円|万円|件|回|%|か月|ヶ月|カ月)/.test(s));
  return hit && !/仮の(数値|数字|計算|例)|架空|説明のための/.test(t);
}

/** 本文を差し替えた記事（引数の順に H2 の1つ目・2つ目・3つ目へ追記） */
function articleWithSections(extras, intro) {
  const a = makeArticle();
  extras.forEach((x, i) => { if (x) a.sections[i].body += '\n\n' + x; });
  if (intro) a.introduction += '\n\n' + intro;
  return gas.normalizeArticle_(a);
}
const warningsOf = (a) => gas.validateArticle_(a, '勤怠管理', '', '').warnings;
const estimateWarnings = (a) => warningsOf(a).filter((w) => /仮の数値/.test(w));

// ---- 36協定の記事（G-3）の誤警告の再現 ----

const KYOTEI_SECTION = [
  '36協定は、労働基準法第36条に基づいて結ぶ協定です。',
  'たとえば、原則の上限は月45時間・年360時間とされています。',
  '例えば、特別条項を使えるのは年6回までとされています。',
  'たとえば1日8時間・週40時間を超える労働が時間外労働にあたります。',
  'たとえば毎月25日に締めて、翌月10日に支払う職場では、締め日前に残業時間を確認します。',
  '例えば、9時から18時までの勤務の場合は、終業時刻の打刻漏れに注意します。'
].join('\n');

test('再現（G-3）：修正前の判定では、法令の数値・日付・時刻だけの36協定の文章で「仮の数値」の警告が出ていた', () => {
  assert.equal(oldHasUnlabeledEstimate(KYOTEI_SECTION), true);
});

test('修正後（G-3）：同じ文章では警告しない（法令の数値・条文番号・日付・時刻は仮の計算例と判定しない）', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(issues(KYOTEI_SECTION))), { unlabeled: [], ambiguous: [] });
  assert.equal(gas.hasUnlabeledEstimate_(KYOTEI_SECTION), false);
  assert.equal(estimateWarnings(articleWithSections([KYOTEI_SECTION])).length, 0);
});

// ---- 正常系：警告しない ----

test('正常系：法令の数値（上限時間・回数・割合・条文番号）は対象外', () => {
  [
    '原則の上限は月45時間・年360時間です。',
    'たとえば、特別条項があっても年720時間以内とされています。',
    '例えば、月60時間を超える時間外労働の割増賃金率は50%以上と定められています。',
    'たとえば、年10日以上の年次有給休暇が付与される労働者には、年5日を取得させる義務があります。',
    'たとえば第36条の協定がない場合、時間外労働はさせられません。'
  ].forEach((s) => assert.equal(kind(s), null, s));
});

test('正常系：日付・時刻・年は対象外', () => {
  [
    'たとえば毎月25日締めの場合、月末までに集計します。',
    '例えば、2026年4月1日から新しいルールで運用する場合です。',
    'たとえば、11月18日に申請があった場合の流れです。',
    '例えば、9時から18時までの勤務の場合です。',
    'たとえば8:30に出勤した場合、打刻の時刻を確認します。'
  ].forEach((s) => assert.equal(kind(s), null, s));
});

test('正常系：計算式の説明だけ（単位つきの数値なし）と、例示の言葉がない数値は対象外', () => {
  [
    '取得率は、一般的に「取得日数の合計÷付与日数の合計×100」で計算します。',
    'たとえば、部署ごとに取得状況を一覧にすると偏りに気づきやすくなります。',
    '確認は月1回、締め日の前に行います。'
  ].forEach((s) => assert.equal(kind(s), null, s));
});

test('正常系：計算例の直前（6文以内）・同じ文・直後の文に注記があれば警告しない', () => {
  const calc = '従業員30人で1人あたり月10分の確認作業がある場合で計算すると、月300分になります。';
  assert.equal(gas.hasUnlabeledEstimate_(LABEL + '\n' + calc), false, '直前');
  assert.equal(gas.hasUnlabeledEstimate_(calc.replace('。', '（仮の数値です）。')), false, '同じ文');
  assert.equal(gas.hasUnlabeledEstimate_(calc + '\n※上記は説明のための仮の数値です。'), false, '直後');
  const list = [LABEL, '', '- 従業員30人×月10分＝300分', '- 従業員50人×月10分＝500分', '- 従業員100人×月10分＝1000分'].join('\n');
  assert.equal(gas.hasUnlabeledEstimate_(list), false, '注記の直後に続く箇条書きの計算例');
});

// ---- 異常系：警告する ----

test('異常系：仮定した人数・日数・金額・割合を使った計算例は検出する', () => {
  [
    'たとえば付与日数が10日で5日取得した場合、取得率は50%になります。',
    '従業員30人で計算すると、月に300分の作業になります。',
    '30人×2時間=60時間の作業になります。',
    'ある月の残業が50時間だった場合を考えます。',
    '仮に月の残業が上限の45時間に近づいたら、業務を見直します。',
    '社員20人の会社で、1人あたり月3,000円かかるとすると、月6万円です。',
    '例えば、50人規模の会社で1人月2時間の集計作業がある場合、合計100時間になります。'
  ].forEach((s) => assert.equal(kind(s), 'estimate', s));
});

test('異常系：注記が記事の別の場所（導入）にあっても、計算例の近くになければ警告する', () => {
  const calc = '従業員30人で計算すると、月に300分の作業になります。';
  assert.equal(oldHasUnlabeledEstimate(LABEL + '\n' + calc), false, '修正前は記事のどこかに注記があれば警告しなかった');
  const a = articleWithSections([null, null, calc], LABEL);
  const w = estimateWarnings(a);
  assert.equal(w.length, 1);
  assert.match(w[0], /近くに「仮の数値」である旨の注記が見当たりません（1か所/);
});

test('異常系：同じH2の中でも、注記から7文以上離れた計算例は警告する（6文以内なら警告しない）', () => {
  const filler = Array.from({ length: 7 }, (_, i) => '確認の手順' + (i + 1) + 'を実施します。').join('\n');
  const calc = '従業員30人で計算すると、月に300分の作業になります。';
  assert.equal(gas.hasUnlabeledEstimate_(LABEL + '\n' + filler + '\n' + calc), true);
  const near = Array.from({ length: 4 }, (_, i) => '確認の手順' + (i + 1) + 'を実施します。').join('\n');
  assert.equal(gas.hasUnlabeledEstimate_(LABEL + '\n' + near + '\n' + calc), false);
});

test('異常系：複数の計算例のうち、注記のない例だけを数える', () => {
  const a = articleWithSections([
    LABEL + '\n従業員30人で計算すると、月に300分の作業になります。',
    'たとえば付与日数が10日で5日取得した場合、取得率は50%になります。',
    '社員20人の会社で、1人あたり月3,000円かかるとすると、月6万円です。'
  ]);
  const r = gas.findEstimateIssues_(gas.articleEstimateSegments_(a));
  assert.equal(r.unlabeled.length, 2);
  assert.match(estimateWarnings(a)[0], /（2か所。例:「たとえば付与日数が10日/);
});

test('判断が難しい例：仮か実際の数値か決められない文は、安全とみなさず「注意」として報告する', () => {
  ['例えば、休憩を1時間とる場合です。', '例えば取得率が50%の部署では、取得の偏りを確認します。',
    'たとえば、特別条項がある場合でも年720時間となります。'].forEach((s) => assert.equal(kind(s), 'ambiguous', s));
  const a = articleWithSections(['例えば取得率が50%の部署では、取得の偏りを確認します。']);
  const w = estimateWarnings(a);
  assert.equal(w.length, 1);
  assert.match(w[0], /自動では判断できません（1か所/);
  assert.match(w[0], /公的資料と一致するか確認/);
  // 近くに注記があれば、仮の数値の例として扱い警告しない
  assert.equal(estimateWarnings(articleWithSections([LABEL + '\n例えば取得率が50%の部署では、取得の偏りを確認します。'])).length, 0);
});

// ---- 記事全体の判定への影響がない ----

test('影響なし：計算例の警告は文字数・見出し数・説明文の判定（エラー）に影響しない', () => {
  const base = gas.normalizeArticle_(makeArticle());
  const a = articleWithSections([null, '従業員30人で計算すると、月に300分の作業になります。']);
  const vb = gas.validateArticle_(base, '勤怠管理', '', '');
  const va = gas.validateArticle_(a, '勤怠管理', '', '');
  assert.equal(JSON.stringify(va.errors), JSON.stringify(vb.errors));
  assert.equal(va.charCount, gas.countArticleChars_(gas.articleToPlainText_(a)));
  assert.equal(va.metaLength, vb.metaLength);
  assert.equal(va.warnings.length, vb.warnings.length + 1);
});

test('影響なし：注記のない計算例だけなら書き直さず、ステータス「生成済み」・処理結果「注意：」（API 1回）', () => {
  const raw = makeArticle();
  raw.sections[1].body += '\n\n従業員30人で計算すると、月に300分の作業になります。';
  const env = gasEnv(() => claudeSuccess(raw));
  const res = env.gas.generateArticleForRow_(2);
  assert.equal(res.ok, true);
  assert.equal(env.state.fetchCalls.length, 1);
  const r = env.gas.getArticleRow_(2);
  assert.equal(r.status, '生成済み');
  assert.match(r.resultMessage, /^注意：.*仮の数値/);
});
