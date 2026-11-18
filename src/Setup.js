/**
 * Setup.js
 * シートの初期化、テスト用キーワード・サンプル記事の投入。
 * 既存データは上書きしない（何度実行しても安全）。
 */

/**
 * 案件の正式なテスト用キーワード5本（勤怠管理サービス「キンタイ Cloud」のブログ向け）。
 * 「テスト用キーワードを追加」は、同じキーワードの行が既にあれば追加しない。
 */
var TEST_KEYWORDS = [
  { keyword: '勤怠管理 エクセル 限界', sub: '' },
  { keyword: '有給休暇 管理 方法', sub: '5日義務, 取得率' },
  { keyword: 'テレワーク 勤怠管理 課題', sub: '打刻, 中抜け' },
  { keyword: '36協定 残業時間 上限', sub: '特別条項, 罰則' },
  { keyword: '勤怠管理システム 比較 選び方', sub: 'クラウド, 料金' }
];

/** 動作確認用のダミーサンプル記事（教材のサンプル記事に差し替えて使う） */
var DUMMY_SAMPLE_ARTICLE = {
  id: 'SAMPLE-001',
  title: '【ダミー】片づけが続かない人へ。今日から始める「5分だけ」整理術',
  body: [
    '「休みの日にまとめて片づけよう」と思っていたのに、気づけば夕方。そんな経験はありませんか？',
    '',
    'じつは片づけが続かないのは、意志が弱いからではありません。最初のハードルを高くしすぎていることが、いちばんの原因なんです。',
    '',
    'この記事では、忙しい人でも無理なく続けられる「5分だけ」の整理術を紹介します。読み終わるころには、今日やることがひとつ決まっているはずですよ。',
    '',
    '## まずは「場所」ではなく「時間」を決める',
    '',
    '片づけを始めるとき、多くの人は「リビングを片づける」のように場所で考えます。でも、範囲が広いと終わりが見えず、手が止まってしまいがちです。',
    '',
    'おすすめは、タイマーを5分にセットしてから始めること。5分たったら、途中でもやめてOKです。「これだけでいい」と思えると、不思議と体が動きます。',
    '',
    '## まとめ',
    '',
    '片づけを続けるコツは、がんばりすぎないことでした。まずは今日、5分だけタイマーをかけてみてください。小さな一歩が、すっきりした部屋への近道です。'
  ].join('\n'),
  note: '動作確認用のダミーです。教材のサンプル記事を新しい行に貼り付け、「利用する」をTRUEにしてから、この行をFALSEにしてください。'
};

/** すべてのシートを作成（不足分のみ） */
function setupSheets_() {
  var ss = getSpreadsheet_();
  var created = [];

  var articles = ensureSheet_(ss, SHEET_NAMES.ARTICLES, ARTICLE_HEADERS, created);
  applyStatusValidation_(articles);
  articles.setColumnWidth(ARTICLE_COLUMNS.KEYWORD, 180);
  articles.setColumnWidth(ARTICLE_COLUMNS.SUB_KEYWORDS, 220);
  articles.setColumnWidth(ARTICLE_COLUMNS.TITLE, 280);
  articles.setColumnWidth(ARTICLE_COLUMNS.META_DESCRIPTION, 320);
  articles.setColumnWidth(ARTICLE_COLUMNS.RESULT_MESSAGE, 320);

  var bodies = ensureSheet_(ss, SHEET_NAMES.BODIES, BODY_HEADERS, created);
  bodies.setColumnWidth(BODY_COLUMNS.BODY_MARKDOWN, 480);
  bodies.setColumnWidth(BODY_COLUMNS.BODY_HTML, 240);

  var samples = ensureSheet_(ss, SHEET_NAMES.SAMPLES, SAMPLE_HEADERS, created);
  samples.setColumnWidth(SAMPLE_COLUMNS.BODY, 480);
  if (samples.getLastRow() < 2) {
    samples.appendRow([DUMMY_SAMPLE_ARTICLE.id, DUMMY_SAMPLE_ARTICLE.title, DUMMY_SAMPLE_ARTICLE.body, true, DUMMY_SAMPLE_ARTICLE.note]);
  }

  ensureSheet_(ss, SHEET_NAMES.LOGS, LOG_HEADERS, created);
  return created;
}

function ensureSheet_(ss, name, headers, created) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created.push(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.setFrozenRows(1);
  return sheet;
}

function applyStatusValidation_(sheet) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_LIST, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, ARTICLE_COLUMNS.STATUS, 500, 1).setDataValidation(rule);
}

/** テスト用キーワード5本を追加（同じキーワードが既にあれば追加しない） */
function addTestKeywords_() {
  var sheet = getSheet_(SHEET_NAMES.ARTICLES);
  var existing = listArticleRows_().map(function (a) { return a.keyword; });
  var added = 0;
  TEST_KEYWORDS.forEach(function (k) {
    if (existing.indexOf(k.keyword) !== -1) return;
    var row = new Array(ARTICLE_HEADERS.length);
    for (var i = 0; i < row.length; i++) row[i] = '';
    row[ARTICLE_COLUMNS.KEYWORD - 1] = k.keyword;
    row[ARTICLE_COLUMNS.SUB_KEYWORDS - 1] = k.sub;
    row[ARTICLE_COLUMNS.STATUS - 1] = STATUS.NOT_GENERATED;
    row[ARTICLE_COLUMNS.GENERATION_COUNT - 1] = 0;
    sheet.appendRow(row);
    var article = rowToArticle_(sheet.getLastRow(), row);
    ensureArticleId_(article);
    added++;
  });
  return added;
}
