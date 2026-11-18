/**
 * Generator.js
 * 記事生成の本体。行の確保（ロック＋ステータス遷移）→ Claude 呼び出し → 検証 → 保存。
 */

/**
 * 行を処理対象として確保する（二重実行防止）。
 * ドキュメントロックの中でステータスを確認し、処理中ステータスに書き換えてから返す。
 *
 * @param {number} rowNumber
 * @param {Object} rule
 * @param {string[]} rule.allowed 処理を開始してよいステータス
 * @param {string} rule.processing 処理中ステータス（生成中 / 投稿中）
 * @param {function(Object):string|null} [rule.extraCheck] 追加チェック。エラーメッセージを返すと中止
 * @return {Object} 確保した行（記事オブジェクト）
 */
function claimArticleRow_(rowNumber, rule) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(RUNTIME_LIMITS.LOCK_WAIT_MS)) {
    throw createAppError_('LOCK_TIMEOUT', '別の処理が実行中です。しばらく待ってから再実行してください。');
  }
  try {
    var article = getArticleRow_(rowNumber);
    if (!article.keyword) {
      throw createAppError_('INVALID_STATE', rowNumber + '行目のキーワードが空です。');
    }
    var allowed = rule.allowed.indexOf(article.status) !== -1;
    var stale = article.status === rule.processing && isStale_(article.startedAt);
    if (!allowed && !stale) {
      throw createAppError_('INVALID_STATE', describeBlockedStatus_(article, rule.processing));
    }
    if (rule.extraCheck) {
      var problem = rule.extraCheck(article);
      if (problem) throw createAppError_('INVALID_STATE', problem);
    }
    ensureArticleId_(article);
    updateArticleFields_(rowNumber, {
      STATUS: rule.processing,
      STARTED_AT: formatDateTime_(),
      RESULT_MESSAGE: rule.processing + '…'
    });
    SpreadsheetApp.flush();
    article.previousStatus = article.status;
    article.status = rule.processing;
    return article;
  } finally {
    lock.releaseLock();
  }
}

/** 処理中のまま一定時間が過ぎた行か（GASのタイムアウトなどで中断した可能性） */
function isStale_(startedAt) {
  if (!startedAt) return true;
  var t = startedAt instanceof Date ? startedAt.getTime() : parseSheetDate_(startedAt);
  if (isNaN(t)) return true;
  return Clock_.now() - t > RUNTIME_LIMITS.STALE_PROCESSING_MS;
}

function parseSheetDate_(value) {
  // "yyyy/MM/dd HH:mm:ss" 形式（スクリプトのタイムゾーン = Asia/Tokyo 前提）
  var m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +m[6]);
}

function describeBlockedStatus_(article, processing) {
  var s = article.status;
  if (s === processing) return '「' + s + '」の処理が進行中です。10分以上変化がない場合は「停止した処理をリセット」を実行してください。';
  if (s === STATUS.GENERATED) return '生成済みです。作り直す場合はメニュー「選択行を再生成（上書き）」を使ってください。';
  if (s === STATUS.NEEDS_REVIEW) {
    return '文字数などの必須条件を満たしていない記事（要確認）です。内容を確認し、問題なければステータスを「生成済み」に変更してから下書き保存してください。' +
      '作り直す場合は「選択行を再生成（上書き）」を使ってください。';
  }
  if (s === STATUS.DRAFT_SAVED) return 'WordPressに下書き保存済みです。二重投稿を防ぐため処理しません。';
  if (s === STATUS.GENERATING || s === STATUS.POSTING) return '「' + s + '」の処理が進行中です。';
  if (s === STATUS.NOT_GENERATED || s === STATUS.GENERATION_ERROR) return '記事がまだ生成されていません。先に記事を生成してください。';
  return 'ステータス「' + s + '」の行はこの操作の対象外です。';
}

/**
 * 1行分の記事を生成してシートに保存する。
 * @param {number} rowNumber
 * @param {Object} [options]
 * @param {boolean} [options.regenerate] 生成済みの記事を上書き再生成する
 * @param {Object} [options.deadline]
 * @return {{ok:boolean, id:string, message:string}}
 */
function generateArticleForRow_(rowNumber, options) {
  options = options || {};
  var deadline = options.deadline || createDeadline_();
  var settings = getSettings_();
  requireClaudeSettings_(settings);

  var allowed = [STATUS.NOT_GENERATED, STATUS.GENERATION_ERROR];
  if (options.regenerate) allowed = allowed.concat([STATUS.GENERATED, STATUS.NEEDS_REVIEW, STATUS.POST_ERROR]);

  var article = claimArticleRow_(rowNumber, {
    allowed: allowed,
    processing: STATUS.GENERATING,
    extraCheck: function (a) {
      return a.wpPostId ? 'WordPressに投稿済み（投稿ID: ' + a.wpPostId + '）のため再生成できません。' : null;
    }
  });

  var meter = createUsageMeter_(CLAUDE_DEFAULTS.MAX_API_CALLS_PER_ARTICLE);
  try {
    var sampleText = getActiveSampleText_();
    var outcome = generateValidatedArticle_(settings, article, sampleText, deadline, meter);
    var a = outcome.article;
    var v = outcome.validation;
    var usageText = describeUsage_(meter);

    upsertArticleBody_({
      id: article.id,
      keyword: article.keyword,
      title: a.title,
      bodyMarkdown: articleToMarkdown_(a),
      bodyHtml: articleToHtml_(a),
      metaDescription: a.metaDescription,
      model: meter.model || settings.claudeModel,
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      apiCalls: meter.calls,
      estimatedCostUsd: estimateCostUsd_(meter.model || settings.claudeModel, meter.inputTokens, meter.outputTokens)
    });

    // 必須条件（文字数・見出し数・説明文長）を満たさない記事は「要確認」にし、そのままでは WordPress へ保存できないようにする
    var failsSpec = v.errors.length > 0;
    var message;
    if (failsSpec) {
      message = '要確認：' + v.errors.concat(v.warnings).join(' / ');
    } else if (v.warnings.length > 0) {
      message = '注意：' + v.warnings.join(' / ');
    } else {
      message = 'OK：' + v.charCount + '文字 / 説明文' + v.metaLength + '文字（試行' + outcome.attempts + '回・プロンプト' + settings.promptVersion + '）';
    }

    updateArticleFields_(rowNumber, {
      STATUS: failsSpec ? STATUS.NEEDS_REVIEW : STATUS.GENERATED,
      TITLE: a.title,
      META_DESCRIPTION: a.metaDescription,
      CHAR_COUNT: v.charCount,
      RESULT_MESSAGE: truncate_(message, 500),
      GENERATION_COUNT: article.generationCount + 1
    });
    appendLog_(article.id, '記事生成', failsSpec ? '要確認' : '成功', message + ' ／ プロンプト' + settings.promptVersion + ' ／ ' + usageText);
    return { ok: true, id: article.id, message: message, usage: meter, needsReview: failsSpec };
  } catch (e) {
    var userMessage = toUserMessage_(e, getSecretValues_(settings));
    updateArticleFields_(rowNumber, {
      STATUS: STATUS.GENERATION_ERROR,
      RESULT_MESSAGE: userMessage
    });
    // 失敗時も、課金された可能性のある使用量をログに残す
    appendLog_(article.id, '記事生成', '失敗', userMessage + ' ／ プロンプト' + settings.promptVersion + ' ／ ' + describeUsage_(meter));
    return { ok: false, id: article.id, message: userMessage, code: e.code, usage: meter };
  }
}

/** 使用量の記録用テキスト（実行ログに残す） */
function describeUsage_(meter) {
  var model = meter.model || '-';
  var cost = estimateCostUsd_(meter.model, meter.inputTokens, meter.outputTokens);
  return 'モデル ' + model + ' / API呼び出し ' + meter.calls + '回 / 入力 ' + meter.inputTokens +
    ' / 出力 ' + meter.outputTokens + 'トークン / 推定 ' + (cost === null ? '単価未登録' : '$' + cost);
}

/**
 * Claude を呼び出し、仕様違反（文字数・見出し数・説明文長）があれば指摘を添えて再生成する。
 * 最大試行回数に達しても直らない場合は最後の結果を返し、呼び出し側で「要確認」として保存する。
 */
function generateValidatedArticle_(settings, row, sampleText, deadline, meter) {
  meter = meter || createUsageMeter_();
  var systemPrompt = buildSystemPrompt_(settings);
  // v1 は改善前との比較用なので、サービス情報を渡さない（初期版と同じ入力にする）
  var service = settings.promptVersion === 'v1' ? null :
    { name: settings.serviceName, category: settings.serviceCategory, facts: settings.serviceFacts };
  var feedback = [];
  var last = null;
  var skippedNote = null;

  for (var attempt = 1; attempt <= settings.maxGenerationAttempts; attempt++) {
    if (attempt > 1) {
      // 書き直しは「時間」と「呼び出し回数」の両方に余裕があるときだけ行う（長時間化・課金の膨張を防ぐ）
      if (!deadline.hasTimeFor(RUNTIME_LIMITS.PER_ARTICLE_BUDGET_MS)) {
        skippedNote = '実行時間の上限が近いため、書き直しを省略しました。';
        break;
      }
      if (meter.remainingCalls <= 0) {
        skippedNote = 'API呼び出し回数の上限に達したため、書き直しを省略しました。';
        break;
      }
    }

    var userPrompt = buildUserPrompt_({
      keyword: row.keyword,
      subKeywords: row.subKeywords,
      sampleText: sampleText,
      service: service,
      feedback: feedback
    });
    var res;
    try {
      res = requestArticleFromClaude_(settings, systemPrompt, userPrompt, deadline, meter);
    } catch (e) {
      // 書き直しで失敗した場合は、1回目の記事（課金済み）を捨てずに「要確認」で保存する
      if (!last) throw e;
      skippedNote = '書き直しに失敗したため、前回の記事を保存しました（' + (e.code || 'ERROR') + '）。';
      break;
    }

    var article = normalizeArticle_(res.article);
    var validation = validateArticle_(article, row.keyword, sampleText, settings.serviceName);
    var current = { article: article, validation: validation, model: res.model || settings.claudeModel, attempts: attempt };
    // 書き直しても直らない場合に備え、必須条件に最も近い記事を残す（後の試行が悪化することがあるため）
    last = !last || isBetterAttempt_(current.validation, last.validation) ? current : last;
    last.attempts = attempt;
    if (validation.errors.length === 0) break;
    feedback = validation.errors;
  }
  if (skippedNote) last.validation.warnings.push(skippedNote);

  // 説明文が120文字を超えたままなら、句点で切り詰めて必ず上限内に収める
  var fitted = fitMetaDescription_(last.article.metaDescription);
  if (fitted.trimmed) {
    last.article.metaDescription = fitted.text;
    var keptWarnings = last.validation.warnings;
    last.validation = validateArticle_(last.article, row.keyword, sampleText, settings.serviceName);
    last.validation.warnings = keptWarnings.filter(function (w) { return last.validation.warnings.indexOf(w) === -1; })
      .concat(last.validation.warnings);
    last.validation.warnings.push('メタディスクリプションを' + ARTICLE_RULES.META_MAX_CHARS + '文字以内に自動調整しました。');
  }
  last.usage = meter;
  last.promptVersion = settings.promptVersion;
  return last;
}

/** a の方が必須条件に近いか（エラー数が少ない → 文字数の範囲からのずれが小さい） */
function isBetterAttempt_(a, b) {
  if (a.errors.length !== b.errors.length) return a.errors.length < b.errors.length;
  return charRangeGap_(a.charCount) < charRangeGap_(b.charCount);
}

function charRangeGap_(count) {
  var r = ARTICLE_RULES;
  if (count < r.MIN_CHARS) return r.MIN_CHARS - count;
  if (count > r.MAX_CHARS) return count - r.MAX_CHARS;
  return 0;
}

/**
 * 複数行を順番に生成する。実行時間の上限が近づいたら新しい行には着手しない。
 * @return {{results:Object[], skipped:number[]}}
 */
function generateRows_(rowNumbers, options) {
  options = options || {};
  var deadline = options.deadline || createDeadline_();
  var results = [];
  var skipped = [];
  for (var i = 0; i < rowNumbers.length; i++) {
    if (!deadline.hasTimeFor(RUNTIME_LIMITS.PER_ARTICLE_BUDGET_MS)) {
      skipped = rowNumbers.slice(i);
      break;
    }
    if (i > 0) sleepMs_(RUNTIME_LIMITS.BATCH_INTERVAL_MS);
    try {
      results.push(generateArticleForRow_(rowNumbers[i], { regenerate: options.regenerate, deadline: deadline }));
    } catch (e) {
      results.push({ ok: false, rowNumber: rowNumbers[i], message: toUserMessage_(e), code: e.code });
      if (e.code === 'CONFIG_MISSING' || e.code === 'LOCK_TIMEOUT') {
        skipped = rowNumbers.slice(i + 1);
        break;
      }
    }
    // 認証エラーは全件で同じ結果になるため、残りを中止する
    var last = results[results.length - 1];
    if (last && last.code === 'AUTH_ERROR') {
      skipped = rowNumbers.slice(i + 1);
      break;
    }
  }
  return { results: results, skipped: skipped };
}

/** 「未生成」の行番号を最大 MAX_BATCH_SIZE 件返す */
function findPendingRowNumbers_() {
  return listArticleRows_()
    .filter(function (a) { return a.status === STATUS.NOT_GENERATED; })
    .map(function (a) { return a.rowNumber; })
    .slice(0, RUNTIME_LIMITS.MAX_BATCH_SIZE);
}

/** 「生成中」「投稿中」のまま止まった行をエラー状態に戻す */
function resetStuckRows_(force) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(RUNTIME_LIMITS.LOCK_WAIT_MS)) {
    throw createAppError_('LOCK_TIMEOUT', '別の処理が実行中です。しばらく待ってから再実行してください。');
  }
  try {
    var count = 0;
    listArticleRows_().forEach(function (a) {
      if ((a.status === STATUS.GENERATING || a.status === STATUS.POSTING) && (force || isStale_(a.startedAt))) {
        var next = a.status === STATUS.GENERATING ? STATUS.GENERATION_ERROR : STATUS.POST_ERROR;
        updateArticleFields_(a.rowNumber, {
          STATUS: next,
          RESULT_MESSAGE: '処理が途中で止まったためリセットしました。再実行してください。'
        });
        appendLog_(a.id, 'リセット', a.status + ' → ' + next, '');
        count++;
      }
    });
    return count;
  } finally {
    lock.releaseLock();
  }
}
