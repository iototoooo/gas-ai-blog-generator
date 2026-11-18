/**
 * GAS グローバルサービスのインメモリモック。
 * 実際の Google / Anthropic / WordPress には一切接続しない。
 */
'use strict';

/** 未定義のメソッド（書式設定など）を「何もせず自身を返す」チェーン可能オブジェクトにする */
function chainable(target) {
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return () => proxy;
    }
  });
  return proxy;
}

class MockSheet {
  constructor(name, spreadsheet) {
    this.name = name;
    this.ss = spreadsheet;
    this.data = []; // 0始まりの2次元配列
    this.activeRange = null;
    this.validations = []; // setDataValidation の呼び出し記録
  }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.data.length - 1; r >= 0; r--) {
      if ((this.data[r] || []).some((v) => v !== '' && v !== null && v !== undefined)) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    return this.data.reduce((m, row) => Math.max(m, (row || []).length), 0);
  }
  getCell(r, c) {
    const row = this.data[r - 1];
    const v = row ? row[c - 1] : undefined;
    return v === undefined || v === null ? '' : v;
  }
  setCell(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1) throw new Error(`Invalid range ${row},${col}`);
    const sheet = this;
    return chainable({
      getRow: () => row,
      getColumn: () => col,
      getNumRows: () => numRows,
      getNumColumns: () => numCols,
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(sheet.getCell(row + r, col + c));
          out.push(line);
        }
        return out;
      },
      getValue: () => sheet.getCell(row, col),
      setValues(values) {
        if (values.length !== numRows || values.some((v) => v.length !== numCols)) {
          throw new Error(`setValues size mismatch: expected ${numRows}x${numCols}`);
        }
        values.forEach((line, r) => line.forEach((v, c) => sheet.setCell(row + r, col + c, v)));
        return this;
      },
      setValue(v) { sheet.setCell(row, col, v); return this; },
      setDataValidation(rule) { sheet.validations.push({ row, col, numRows, numCols, rule }); return this; },
      activate() { sheet.ss.activeSheet = sheet; sheet.activeRange = this; return this; }
    });
  }
  appendRow(values) {
    const r = this.getLastRow() + 1;
    values.forEach((v, i) => this.setCell(r, i + 1, v === undefined ? '' : v));
    return this;
  }
  getActiveRange() { return this.activeRange; }
  /** テスト用：選択範囲を設定 */
  select(row, numRows = 1) {
    this.activeRange = this.getRange(row, 1, numRows, 1);
    this.ss.activeSheet = this;
  }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = [];
    this.activeSheet = null;
    const first = new MockSheet('シート1', this);
    this.sheets.push(first);
    this.activeSheet = first;
  }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('duplicate sheet ' + name);
    const s = new MockSheet(name, this);
    this.sheets.push(s);
    return s;
  }
  getSheets() { return this.sheets.slice(); }
  getActiveSheet() { return this.activeSheet; }
  setActiveSheet(s) { this.activeSheet = s; return s; }
  toast() {}
}

function createUi(state) {
  const Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' };
  const ButtonSet = { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' };
  const makeMenu = (title) => {
    const menu = { title, items: [], addedToUi: false };
    menu.addItem = (label, fn) => { menu.items.push({ label, fn }); return menu; };
    menu.addSeparator = () => { menu.items.push({ separator: true }); return menu; };
    menu.addSubMenu = (sub) => { menu.items.push({ submenu: sub }); return menu; };
    menu.addToUi = () => { menu.addedToUi = true; state.menus.push(menu); return menu; };
    return menu;
  };
  return {
    Button,
    ButtonSet,
    createMenu: makeMenu,
    alert(...args) {
      const message = args.length === 1 ? args[0] : args[1];
      state.alerts.push(String(message));
      return state.nextAlertResponses.length > 0 ? state.nextAlertResponses.shift() : Button.YES;
    }
  };
}

/** UrlFetchApp のレスポンス */
function httpResponse(code, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getHeaders: () => headers,
    getAllHeaders: () => headers
  };
}

/**
 * GAS 環境一式を作る。
 * @param {Object} opts
 * @param {Object} opts.properties Script Properties の初期値
 * @param {Function} opts.fetchHandler (url, options, callIndex) => httpResponse | throw
 */
function createGasEnvironment(opts = {}) {
  const state = {
    alerts: [],
    menus: [],
    nextAlertResponses: [],
    fetchCalls: [],
    sleeps: [],
    logs: [],
    lockHeld: false,
    lockAvailable: true,
    flushCount: 0
  };
  const spreadsheet = new MockSpreadsheet();
  const props = Object.assign({}, opts.properties || {});
  let fetchHandler = opts.fetchHandler || (() => { throw new Error('外部通信は禁止です（モック未設定）'); });

  const ui = createUi(state);
  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getUi: () => ui,
      flush: () => { state.flushCount++; },
      newDataValidation: () => {
        const rule = { type: 'validation', values: null, allowInvalid: true };
        const builder = chainable({
          requireValueInList(values) { rule.values = values.slice(); return builder; },
          setAllowInvalid(v) { rule.allowInvalid = v; return builder; },
          build: () => rule
        });
        return builder;
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => Object.assign({}, props)
      })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        const call = { url, options: JSON.parse(JSON.stringify(options || {})) };
        state.fetchCalls.push(call);
        return fetchHandler(url, options, state.fetchCalls.length - 1);
      }
    },
    LockService: {
      getDocumentLock: () => ({
        tryLock: () => {
          if (!state.lockAvailable || state.lockHeld) return false;
          state.lockHeld = true;
          return true;
        },
        releaseLock: () => { state.lockHeld = false; }
      })
    },
    Utilities: {
      sleep: (ms) => { state.sleeps.push(ms); },
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
      formatDate: (date, tz, pattern) => {
        // Asia/Tokyo 固定の簡易実装（yyyy/MM/dd HH:mm:ss のみ）
        const d = new Date(date.getTime() + 9 * 3600 * 1000);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
      }
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Logger: { log: (...a) => state.logs.push(a.join(' ')) },
    console: {
      log: (...a) => state.logs.push(a.join(' ')),
      warn: (...a) => state.logs.push(a.join(' ')),
      error: (...a) => state.logs.push(a.join(' '))
    }
  };

  return {
    globals,
    state,
    spreadsheet,
    props,
    setFetchHandler: (h) => { fetchHandler = h; }
  };
}

module.exports = { createGasEnvironment, httpResponse, MockSheet, MockSpreadsheet };
