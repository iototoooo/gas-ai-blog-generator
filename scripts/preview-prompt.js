#!/usr/bin/env node
/**
 * Claude に送るプロンプトを、版ごとにローカルで表示する（API は呼ばない）。
 *
 * 使い方：
 *   npm run prompt:preview -- "勤怠管理 効率化" "打刻漏れ, 月末 締め"          v2（既定）
 *   npm run prompt:preview -- "勤怠管理 効率化" "" --version=v1                 v1（改善前）
 *   npm run prompt:preview -- "勤怠管理 効率化" "" --facts="（確定情報の例）"   サービス確定情報あり
 */
'use strict';

const { loadGas } = require('../test/helpers/load-gas');

function renderPrompts(opts) {
  const props = { PROMPT_VERSION: opts.version || 'v2' };
  if (opts.facts) props.SERVICE_FACTS = opts.facts;
  const { gas } = loadGas({ properties: props });
  const settings = gas.getSettings_();
  const service = settings.promptVersion === 'v1' ? null
    : { name: settings.serviceName, category: settings.serviceCategory, facts: settings.serviceFacts };
  return {
    version: settings.promptVersion,
    system: gas.buildSystemPrompt_(settings),
    user: gas.buildUserPrompt_({ keyword: opts.keyword, subKeywords: opts.sub || '', sampleText: '', service: service, feedback: [] })
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => (args.find((a) => a.startsWith('--' + name + '=')) || '').split('=').slice(1).join('=');
  const pos = args.filter((a) => !a.startsWith('--'));
  if (!pos[0]) {
    console.error('使い方: npm run prompt:preview -- "<キーワード>" "<サブキーワード>" [--version=v1|v2] [--facts=...]');
    process.exit(1);
  }
  const p = renderPrompts({ keyword: pos[0], sub: pos[1], version: flag('version'), facts: flag('facts') });
  console.log('===== プロンプト ' + p.version + '：システム =====\n' + p.system);
  console.log('\n===== プロンプト ' + p.version + '：ユーザー（サンプル記事は省略） =====\n' + p.user);
}

module.exports = { renderPrompts };
