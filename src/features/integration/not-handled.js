'use strict';
/**
 * 路由处理器共用的哨兵值。
 *
 * 分叉新增的接口被拆出 daemon.js 后，每个处理器要么「已处理」（返回一个 Promise，
 * 内部已经把响应写完），要么「不归我管」（原样返回 NOT_HANDLED）。用 Symbol 而不是
 * null/false，是为了让「处理器返回 undefined 表示已处理」这种情况不会被误判。
 */
const NOT_HANDLED = Symbol('workdaddy.not-handled');

module.exports = { NOT_HANDLED };
