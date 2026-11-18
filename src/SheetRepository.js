/**
 * SheetRepository.js
 * スプレッドシートの読み書きを集約する。シート構造の詳細はここと Config.js だけが知っている。
 */

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw createAppError_('NOT_FOUND',
      '「' + name + '」シートが見つかりません。メニュー「記事生成 > 初期設定 > シートを初期化」を実行してください。');
  }
  return sheet;
}

/** 行データをオブジェクトに変換 */
function rowToArticle_(rowNumber, values) {
  var c = ARTICLE_COLUMNS;
  var v = function (col) { return values[col - 1]; };
  return {
    rowNumber: rowNumber,
    id: String(v(c.ID) || '').trim(),
    keyword: String(v(c.KEYWORD) || '').trim(),
    subKeywords: String(v(c.SUB_KEYWORDS) || '').trim(),
    status: String(v(c.STATUS) || '').trim() || STATUS.NOT_GENERATED,
    title: String(v(c.TITLE) || ''),
    metaDescription: String(v(c.META_DESCRIPTION) || ''),
    charCount: v(c.CHAR_COUNT),
    wpPostId: String(v(c.WP_POST_ID) || '').trim(),
    wpUrl: String(v(c.WP_URL) || ''),
    resultMessage: String(v(c.RESULT_MESSAGE) || ''),
    startedAt: v(c.STARTED_AT),
    updatedAt: v(c.UPDATED_AT),
    generationCount: Number(v(c.GENERATION_COUNT) || 0)
  };
}

function getArticleRow_(rowNumber) {
  if (rowNumber < 2) throw createAppError_('INVALID_STATE', '見出し行は処理できません。');
  var sheet = getSheet_(SHEET_NAMES.ARTICLES);
  if (rowNumber > sheet.getLastRow()) {
    throw createAppError_('NOT_FOUND', rowNumber + '行目にデータがありません。');
  }
  var values = sheet.getRange(rowNumber, 1, 1, ARTICLE_HEADERS.length).getValues()[0];
  return rowToArticle_(rowNumber, values);
}

function listArticleRows_() {
  var sheet = getSheet_(SHEET_NAMES.ARTICLES);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, ARTICLE_HEADERS.length).getValues();
  return values.map(function (row, i) { return rowToArticle_(i + 2, row); })
    .filter(function (a) { return a.keyword !== ''; });
}

/**
 * 指定行の複数フィールドを更新する。fields は ARTICLE_COLUMNS のキー名 → 値。
 * 最終更新日時は自動で更新する。
 */
function updateArticleFields_(rowNumber, fields) {
  var sheet = getSheet_(SHEET_NAMES.ARTICLES);
  var range = sheet.getRange(rowNumber, 1, 1, ARTICLE_HEADERS.length);
  var values = range.getValues()[0];
  Object.keys(fields).forEach(function (key) {
    var col = ARTICLE_COLUMNS[key];
    if (!col) throw new Error('未知の列です: ' + key);
    values[col - 1] = fields[key];
  });
  values[ARTICLE_COLUMNS.UPDATED_AT - 1] = formatDateTime_();
  range.setValues([values]);
}

/** IDが空なら採番する（KW-001形式） */
function ensureArticleId_(article) {
  if (article.id) return article.id;
  var rows = listArticleRows_();
  var maxNum = 0;
  rows.forEach(function (a) {
    var m = /^KW-(\d+)$/.exec(a.id);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });
  var id = 'KW-' + ('000' + (maxNum + 1)).slice(-3);
  updateArticleFields_(article.rowNumber, { ID: id });
  article.id = id;
  return id;
}

/** 記事本文シートに保存（同じIDがあれば上書き） */
function upsertArticleBody_(record) {
  var sheet = getSheet_(SHEET_NAMES.BODIES);
  var row = [
    record.id, record.keyword, record.title, record.bodyMarkdown, record.bodyHtml,
    record.metaDescription, formatDateTime_(), record.model,
    record.inputTokens || 0, record.outputTokens || 0,
    record.apiCalls || 0,
    record.estimatedCostUsd === null || record.estimatedCostUsd === undefined ? '単価未登録' : record.estimatedCostUsd
  ];
  var existingRow = findBodyRowNumber_(sheet, record.id);
  if (existingRow) {
    sheet.getRange(existingRow, 1, 1, BODY_HEADERS.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function findBodyRowNumber_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var ids = sheet.getRange(2, BODY_COLUMNS.ID, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return null;
}

function getArticleBody_(id) {
  var sheet = getSheet_(SHEET_NAMES.BODIES);
  var rowNumber = findBodyRowNumber_(sheet, id);
  if (!rowNumber) return null;
  var v = sheet.getRange(rowNumber, 1, 1, BODY_HEADERS.length).getValues()[0];
  return {
    rowNumber: rowNumber,
    id: v[BODY_COLUMNS.ID - 1],
    title: v[BODY_COLUMNS.TITLE - 1],
    bodyMarkdown: v[BODY_COLUMNS.BODY_MARKDOWN - 1],
    bodyHtml: v[BODY_COLUMNS.BODY_HTML - 1],
    metaDescription: v[BODY_COLUMNS.META_DESCRIPTION - 1]
  };
}

/** 「利用する」にチェックが入ったサンプル記事の本文を結合して返す */
function getActiveSampleText_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES.SAMPLES);
  if (!sheet) return '';
  var last = sheet.getLastRow();
  if (last < 2) return '';
  var values = sheet.getRange(2, 1, last - 1, SAMPLE_HEADERS.length).getValues();
  return values
    .filter(function (r) {
      var flag = r[SAMPLE_COLUMNS.ENABLED - 1];
      return (flag === true || String(flag).toUpperCase() === 'TRUE') && String(r[SAMPLE_COLUMNS.BODY - 1]).trim() !== '';
    })
    .slice(0, 2) // プロンプト肥大化を防ぐため最大2本
    .map(function (r) {
      return '【' + r[SAMPLE_COLUMNS.TITLE - 1] + '】\n' + String(r[SAMPLE_COLUMNS.BODY - 1]).trim();
    })
    .join('\n\n----\n\n');
}

/** 実行ログを追記（失敗しても本処理は止めない） */
function appendLog_(id, action, result, detail) {
  try {
    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES.LOGS);
    if (!sheet) return;
    sheet.appendRow([formatDateTime_(), id || '', action, result, truncate_(detail || '', 1000)]);
  } catch (e) {
    console.warn('ログの書き込みに失敗しました: ' + e.message);
  }
}
