/**
 * Menu.js
 * カスタムメニューと、メニューから呼ばれる関数（画面とのやり取り）。
 * ここ以外のファイルは UI に依存しない（テストしやすくするため）。
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('記事生成')
    .addItem('選択行の記事を生成', 'menuGenerateSelected')
    .addItem('未生成の記事をまとめて生成（最大' + RUNTIME_LIMITS.MAX_BATCH_SIZE + '件）', 'menuGeneratePending')
    .addItem('選択行を再生成（上書き）', 'menuRegenerateSelected')
    .addSeparator()
    .addItem('選択行をWordPressに下書き保存', 'menuPostSelected')
    .addSeparator()
    .addItem('選択行の本文を開く', 'menuOpenBody')
    .addItem('停止した処理をリセット', 'menuResetStuck')
    .addSeparator()
    .addSubMenu(ui.createMenu('初期設定')
      .addItem('シートを初期化', 'menuSetupSheets')
      .addItem('テスト用キーワードを追加', 'menuAddTestKeywords')
      .addItem('設定状況を確認', 'menuShowSettingsStatus')
      .addItem('WordPress接続テスト', 'menuTestWordPress'))
    .addToUi();
}

function menuGenerateSelected() {
  runMenuAction_(function () {
    var rows = getSelectedArticleRows_();
    var out = generateRows_(rows, {});
    showBatchResult_('記事生成', out);
  });
}

function menuRegenerateSelected() {
  runMenuAction_(function () {
    var rows = getSelectedArticleRows_();
    var ui = SpreadsheetApp.getUi();
    var answer = ui.alert('再生成の確認',
      rows.length + '行の記事を作り直します。現在のタイトル・本文は上書きされ、APIの利用料金が発生します。よろしいですか？',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;
    var out = generateRows_(rows, { regenerate: true });
    showBatchResult_('記事の再生成', out);
  });
}

function menuGeneratePending() {
  runMenuAction_(function () {
    var rows = findPendingRowNumbers_();
    if (rows.length === 0) {
      alert_('未生成の記事はありません。');
      return;
    }
    var out = generateRows_(rows, {});
    showBatchResult_('一括生成', out);
  });
}

function menuPostSelected() {
  runMenuAction_(function () {
    var rows = getSelectedArticleRows_();
    var deadline = createDeadline_();
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      if (!deadline.hasTimeFor(RUNTIME_LIMITS.MIN_TIME_FOR_API_CALL_MS * 2)) {
        lines.push('実行時間の上限が近いため、' + rows.slice(i).join(', ') + '行目は未処理です。もう一度実行してください。');
        break;
      }
      var r;
      try {
        r = postDraftForRow_(rows[i], { deadline: deadline });
      } catch (e) {
        r = { ok: false, message: toUserMessage_(e) };
      }
      lines.push(rows[i] + '行目：' + (r.ok ? '✅ ' : (r.skipped ? 'ℹ️ ' : '❌ ')) + r.message);
      if (r.skipped) break; // 未設定なら以降も同じ
    }
    alert_(lines.join('\n'));
  });
}

function menuOpenBody() {
  runMenuAction_(function () {
    var rows = getSelectedArticleRows_();
    var article = getArticleRow_(rows[0]);
    var body = article.id ? getArticleBody_(article.id) : null;
    if (!body) {
      alert_('この行の本文はまだありません。先に記事を生成してください。');
      return;
    }
    var sheet = getSheet_(SHEET_NAMES.BODIES);
    getSpreadsheet_().setActiveSheet(sheet);
    sheet.getRange(body.rowNumber, BODY_COLUMNS.BODY_MARKDOWN).activate();
  });
}

function menuResetStuck() {
  runMenuAction_(function () {
    var ui = SpreadsheetApp.getUi();
    var answer = ui.alert('リセットの確認',
      '「生成中」「投稿中」のまま止まっている行をエラー状態に戻します。\n' +
      '「はい」：10分以上止まっている行のみ\n「いいえ」：すべての処理中の行（実行中の処理がないことを確認してから）',
      ui.ButtonSet.YES_NO_CANCEL);
    if (answer === ui.Button.CANCEL || answer === ui.Button.CLOSE) return;
    var count = resetStuckRows_(answer === ui.Button.NO);
    alert_(count + '行をリセットしました。');
  });
}

function menuSetupSheets() {
  runMenuAction_(function () {
    var created = setupSheets_();
    alert_(created.length > 0
      ? '次のシートを作成しました：' + created.join('、')
      : 'シートは作成済みです（見出しと入力規則を整えました）。');
  });
}

function menuAddTestKeywords() {
  runMenuAction_(function () {
    setupSheets_();
    var added = addTestKeywords_();
    alert_(added > 0 ? 'テスト用キーワードを' + added + '件追加しました。' : 'テスト用キーワードは追加済みです。');
  });
}

function menuShowSettingsStatus() {
  runMenuAction_(function () {
    var s = getSettings_();
    alert_([
      '【Claude API】',
      'CLAUDE_API_KEY：' + describeSecret_(s.claudeApiKey),
      'モデル：' + s.claudeModel + (getModelProfile_(s.claudeModel) ? '' : '（単価未登録のため費用は記録されません）') +
        ' / effort：' + s.claudeEffort + ' / max_tokens：' + s.claudeMaxTokens,
      '応答拒否時のフォールバック：' + (s.claudeUseFallback ? '有効' : '無効（このモデルは非対応、または設定でオフ）'),
      'プロンプト：' + s.promptVersion + (s.promptVersion === 'v1' ? '（改善前の初期版・比較用）' : ''),
      '紹介するサービス：' + (s.promptVersion === 'v1' ? '（v1 では紹介しない）' : s.serviceName + '（' + s.serviceCategory + '）') +
        ' / 確定情報 SERVICE_FACTS：' + (s.serviceFacts ? '設定済み' : '未設定（機能・料金は記事に書かれません）'),
      '',
      '【WordPress（任意）】',
      'WP_BASE_URL：' + (s.wpBaseUrl || '未設定'),
      'WP_USERNAME：' + describeSecret_(s.wpUsername),
      'WP_APP_PASSWORD：' + describeSecret_(s.wpAppPassword),
      '',
      isWordPressConfigured_(s) ? 'WordPressへの下書き保存が利用できます。' : 'WordPress未設定：記事生成とスプレッドシート保存のみ利用できます。'
    ].join('\n'));
  });
}

function menuTestWordPress() {
  runMenuAction_(function () {
    var s = getSettings_();
    var info = wpTestConnection_(s, createDeadline_());
    alert_('WordPressに接続できました。\nユーザー：' + info.name + '\n投稿の編集権限：' + (info.canEditPosts ? 'あり' : 'なし（投稿者以上の権限が必要です）'));
  });
}

/** 選択範囲から、記事管理シートのデータ行番号を返す */
function getSelectedArticleRows_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getActiveSheet();
  if (sheet.getName() !== SHEET_NAMES.ARTICLES) {
    throw createAppError_('INVALID_STATE', '「' + SHEET_NAMES.ARTICLES + '」シートで処理したい行を選択してから実行してください。');
  }
  var range = sheet.getActiveRange();
  var start = Math.max(range.getRow(), 2);
  var end = Math.min(range.getRow() + range.getNumRows() - 1, sheet.getLastRow());
  var rows = [];
  for (var r = start; r <= end; r++) rows.push(r);
  if (rows.length === 0) {
    throw createAppError_('INVALID_STATE', 'データ行（2行目以降）を選択してください。');
  }
  if (rows.length > RUNTIME_LIMITS.MAX_BATCH_SIZE) {
    throw createAppError_('INVALID_STATE', '一度に選択できるのは' + RUNTIME_LIMITS.MAX_BATCH_SIZE + '行までです（GASの実行時間制限のため）。');
  }
  return rows;
}

function showBatchResult_(title, out) {
  var lines = out.results.map(function (r) {
    return (r.id || (r.rowNumber + '行目')) + '：' + (r.ok ? '✅ ' : '❌ ') + r.message;
  });
  if (out.skipped.length > 0) {
    lines.push('');
    lines.push('⏸ 未処理：' + out.skipped.join(', ') + '行目（実行時間の上限または致命的エラーのため）。もう一度実行してください。');
  }
  alert_(title + 'の結果\n\n' + lines.join('\n'));
}

function runMenuAction_(fn) {
  try {
    fn();
  } catch (e) {
    var settings = {};
    try { settings = getSettings_(); } catch (ignore) { /* 設定読み込み失敗時もメッセージは出す */ }
    alert_('エラー：' + toUserMessage_(e, settings.claudeApiKey ? getSecretValues_(settings) : []));
  }
}

function alert_(message) {
  SpreadsheetApp.getUi().alert(message);
}
