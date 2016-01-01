"use strict";

const _ = require('lodash');
const assert = require('assert');
const validator = require('validator');
const debug = require('debug')('sotrade:stocks');
const qctx = require('./qctx.js');
const buscomponent = require('./stbuscomponent.js');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;
require('datejs');

/**
 * Provides client requests for small-scale finance updates and display.
 * @public
 * @module stocks
 */

/**
 * Main object of the {@link module:stocks} module
 * @public
 * @constructor module:stocks~Stocks
 * @augments module:stbuscomponent~STBusComponent
 */
class Stocks extends buscomponent.BusComponent {
  constructor() {
    super();
  
    this.knownStockIDs = null; // ISIN list for more efficient stock updating
    this.quoteLoader = null;
    this.leaderStockTextIDFormat = /^__LEADER_(\d+)__$/;
  }
}

Stocks.prototype.onBusConnect = function() {
  return this.request({name: 'getStockQuoteLoader'}).then(ql => {
    assert.ok(ql);
    
    this.quoteLoader = ql;
    
    const ctx = new qctx.QContext({parentComponent: this});
    
    this.quoteLoader.on('record', rec => {
      return Promise.resolve().then(() => {
        return this.updateRecord(ctx, rec);
      });
    });
    
    return this.updateStockIDCache(ctx);
  });
};

/**
 * Updates the internal cache of stock ids
 * 
 * @function module:stocks~Stocks#updateStockIDCache
 */
Stocks.prototype.updateStockIDCache = function(ctx) {
  return this.knownStockIDs = ctx.query('SELECT stockid, stocktextid FROM stocks').then(stockidlist => {
    debug('Generating ISIN |-> id map', stockidlist.length + ' entries');
    
    return this.knownStockIDs = _.chain(stockidlist).map(entry => {
      assert.equal(typeof entry.stockid, 'number');
      assert.ok(this.leaderStockTextIDFormat.test(entry.stocktextid) || validator.isISIN(entry.stocktextid));
      return [entry.stocktextid, entry.stockid];
    }).zipObject().value();
  });
};

/**
 * Indicates whether a [stock record]{@link StockRecord} is admissible for this game instance.
 * This checks the stock exchange and the currency of the record against the game config.
 * 
 * @param {object} cfg   The server main config.
 * @param {StockRecord}  rec The record to test.
 * 
 * @return {boolean} Whether the record is admissible for this game instance.
 * 
 * @function module:stocks~Stocks#stocksFilter
 */
Stocks.prototype.stocksFilter = function(cfg, rec) {
  return _.chain(cfg.stockExchanges).keys().contains(rec.exchange).value() && rec.currency_name === cfg.requireCurrency;
};

/**
 * Regularly called function to perform various cleanup and update tasks.
 * 
 * Calls the following functions (not necessarily all of these, but in the given order):
 * {@link module:stocks~Stocks#cleanUpUnusedStocks}
 * {@link module:stocks~Stocks#updateStockValues}
 * {@link busreq~updateLeaderMatrix}
 * {@link busreq~updateProvisions}
 * {@link module:stocks~Stocks#updateRankingInformation}
 * {@link module:stocks~Stocks#weeklyCallback}
 * {@link module:stocks~Stocks#dailyCallback}
 * {@link module:stocks~Stocks#updateStockIDCache}
 * 
 * @param {Query} query  A query structure, indicating which functions of the above should be called:
 * @param {Query} query.weekly  Run {@link module:stocks~Stocks#weeklyCallback}
 * @param {Query} query.daily  Run {@link module:stocks~Stocks#dailyCallback}
 * @param {Query} query.provisions  Run {@link busreq~updateProvisions}
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function busreq~regularCallbackStocks
 */
Stocks.prototype.regularCallback = buscomponent.provide('regularCallbackStocks', ['query', 'ctx'], function(query, ctx) {
  if (ctx.getProperty('readonly')) {
    return;
  }
    
  let rcbST, rcbET, cuusET, usvET, ulmET, uriET, uvhET, upET, wcbET, usicST;
  rcbST = Date.now();
  
  return this.cleanUpUnusedStocks(ctx).then(() => {
    cuusET = Date.now();
    return this.updateStockValues(ctx);
  }).then(() => {
    usvET = Date.now();
    return this.request({name: 'updateLeaderMatrix', ctx: ctx});
  }).then(() => {
    ulmET = Date.now();
    
    if (query.provisions) {
      return this.request({name: 'updateProvisions', ctx: ctx});
    }
  }).then(() => {
    upET = Date.now();
    return this.updateRankingInformation(ctx);
  }).then(() => {
    uriET = Date.now();
    return this.updateValueHistory(ctx);
  }).then(() => {
    uvhET = Date.now();
    
    if (query.weekly) {
      return this.weeklyCallback(ctx).then(() => {
        wcbET = Date.now();
        return this.dailyCallback(ctx);
      });
    } else if (query.daily) {
      wcbET = Date.now();
      return this.dailyCallback(ctx);
    } else {
      wcbET = Date.now();
    }
  }).then(() => {
    usicST = Date.now();
    return this.updateStockIDCache(ctx);
  }).then(() => {
    rcbET = Date.now();
    console.log('cleanUpUnusedStocks:      ' + (cuusET  - rcbST)  + ' ms');
    console.log('updateStockValues:        ' + (usvET   - cuusET) + ' ms');
    console.log('updateLeaderMatrix:       ' + (ulmET   - usvET)  + ' ms');
    console.log('updateProvisions:         ' + (upET    - ulmET)  + ' ms');
    console.log('updateRankingInformation: ' + (uriET   - upET)   + ' ms');
    console.log('updateValueHistory:       ' + (uvhET   - uriET)  + ' ms');
    console.log('weeklyCallback:           ' + (wcbET   - uvhET)  + ' ms');
    console.log('dailyCallback:            ' + (usicST  - wcbET)  + ' ms');
    console.log('updateStockIDCache:       ' + (rcbET   - usicST) + ' ms');
    console.log('Total stocks rcb:         ' + (rcbET   - rcbST)  + ' ms');
  });
});

/**
 * Updates follower finance data, specifically the <code>fperf_cur</code> and
 * <code>operf_cur</code> values.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @return {object}  A Promise indicating task completion
 * @function module:stocks~Stocks#updateRankingInformation
 */
Stocks.prototype.updateRankingInformation = function(ctx) {
  debug('Update ranking information');
  
  return ctx.query('UPDATE users_finance SET ' +
    'fperf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.stockid ' +
      'WHERE uid = users_finance.uid AND leader IS NOT NULL), ' +
    'operf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.stockid ' +
      'WHERE uid = users_finance.uid AND leader IS NULL)');
};

/**
 * Adds new entries to the global user finance history.
 * These values can later be retrieved and used for charting and ranking.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @return {object}  A Promise indicating task completion
 * @function module:stocks~Stocks#updateValueHistory
 */
Stocks.prototype.updateValueHistory = function(ctx) {
  debug('Update value history');
  
  const copyFields = 'totalvalue, wprov_sum, lprov_sum, fperf_bought, fperf_cur, fperf_sold, operf_bought, operf_cur, operf_sold';
  return ctx.query('INSERT INTO tickshistory (ticks, time) ' +
    'SELECT value, UNIX_TIMESTAMP() FROM globalvars WHERE name="ticks"').then(() => {
    return ctx.query('DROP TEMPORARY TABLE IF EXISTS users_dindex; ' +
      'CREATE TEMPORARY TABLE users_dindex SELECT uid, deletiontime FROM users; ' +
      'INSERT INTO valuehistory (uid, ' + copyFields + ', time) SELECT users_finance.uid, ' + copyFields + ', UNIX_TIMESTAMP() ' +
      'FROM users_finance JOIN users_dindex ON users_dindex.uid = users_finance.uid WHERE users_dindex.deletiontime IS NULL; ' +
      'DROP TABLE users_dindex');
  });
};

/**
 * This function is intended to be called on each day start.
 * The day start value property of all stocks is set to the current “bid” price.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @return {object}  A Promise indicating task completion
 * @function module:stocks~Stocks#dailyCallback
 */
Stocks.prototype.dailyCallback = function(ctx) {
  debug('Daily callback');
  
  return ctx.query('UPDATE stocks SET daystartvalue = bid');
};

/**
 * This function is intended to be called on each week start.
 * The week start value property of all stocks is set to the current “bid” price.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @return {object}  A Promise indicating task completion
 * @function module:stocks~Stocks#weeklyCallback
 */
Stocks.prototype.weeklyCallback = function(ctx) {
  debug('Weekly callback');
  
  return ctx.query('UPDATE stocks SET weekstartvalue = bid');
};

/**
 * Cleans up the stock tables.
 * Deletes depot entries with 0 shares and sets the <code>lrutime</code> 
 * (least recent use time) flag on all stocks.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 *
 * @return {object}  A Promise indicating task completion
 * @function module:stocks~Stocks#cleanUpUnusedStocks
 */
Stocks.prototype.cleanUpUnusedStocks = function(ctx) {
  debug('Clean up unused stocks');
  
  return ctx.query('DELETE FROM depot_stocks WHERE amount = 0')
  .then(() => {
    return ctx.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE ' +
      '(SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.stockid = stocks.stockid) != 0 ' +
      'OR (SELECT COUNT(*) FROM watchlists AS w WHERE w.watched  = stocks.stockid) != 0 ' +
      'OR leader IS NOT NULL');
  });
};

/**
 * Updates the stock tables.
 * Fetches all stocks currently in use and updates the corresponding database values.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @return {object}  A Promise indicating task completion 
 * @function module:stocks~Stocks#updateStockValues
 */
Stocks.prototype.updateStockValues = function(ctx) {
  debug('Update stock values');
  
  let stocklist = [];
  let cfg;
  return this.getServerConfig().then(cfg_ => {
    cfg = cfg_;
    return ctx.query('SELECT * FROM stocks ' +
      'WHERE leader IS NULL AND UNIX_TIMESTAMP()-lastchecktime > ? AND UNIX_TIMESTAMP()-lrutime < ?',
    [cfg.lrutimeLimit, cfg.refetchLimit]);
  }).then(res => {
    stocklist = _.pluck(res, 'stocktextid');
    return this.request({name: 'neededStocksDQ'});
  }).then(dqNeededStocks => {
    stocklist = _.union(stocklist, dqNeededStocks);
    
    stocklist = stocklist.filter(s => !this.leaderStockTextIDFormat.test(s));
    
    if (stocklist.length > 0) {
      return this.quoteLoader.loadQuotesList(stocklist, rec => this.stocksFilter(cfg, rec));
    }
  });
};

/**
 * Represents the values and properties of a stock at a given time.
 * @typedef module:stocks~StockRecord
 * @type {object}
 * 
 * @property {string} symbol  A unique identifier (e.g. ISIN) of the stock
 * @property {number} lastvalue  The current stock value (1/10000 units)
 * @property {number} ask  The current stock ask price (1/10000 units)
 * @property {number} bid  The current stock bid price (1/10000 units)
 * @property {string} name  A human-readable name for the stock
 * @property {?int} leader   If this is a leader stock, this is the leader’s user id.
 * @property {?string} leadername  If this is a leader stock, this is the leader’s user name.
 * @property {string} exchange  A unique identifier of the stock exchange where the stock is being traded.
 * @property {int} pieces  The number of shares of this stock that have been traded on the current day.
 */

/**
 * Updates the stock tables.
 * Fetches all stocks currently in use and updates the corresponding database values.
 * Also, for each record, emit a <code>stock-update</code> event on the bus.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {module:stocks~StockRecord} rec  A stock record to process
 * 
 * @function module:stocks~Stocks#updateRecord
 */
Stocks.prototype.updateRecord = function(ctx, rec) {
  if (rec.failure) {
    return;
  }
  
  assert.notEqual(rec.lastTradePrice, null);
  if (rec.lastTradePrice === 0) { // happens with API sometimes.
    return;
  }
  
  assert.notStrictEqual(rec.pieces, null);
  
  return Promise.resolve().then(() => {
    if (ctx.getProperty('readonly')) {
      return;
    }
    
    let knownStockIDs;
    
    // on duplicate key is likely to be somewhat slower than other options
    // -> check whether we already know the primary key
    return Promise.resolve(this.knownStockIDs).then(knownStockIDs_ => {
      knownStockIDs = knownStockIDs_;
      return knownStockIDs[rec.symbol]; // might be a promise from INSERT INTO
    }).then(ksid => {
      const updateQueryString = 'lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), ' +
        'name = IF(LENGTH(name) >= ?, name, ?), exchange = ?, pieces = ? ';
      const updateParams = [rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000,
        rec.name.length, rec.name, rec.exchange, rec.pieces];
      
      if (typeof ksid === 'number') {
        return ctx.query('UPDATE stocks SET ' + updateQueryString +
          'WHERE stockid = ?', updateParams.concat([ksid]));
      } else {
        assert.equal(typeof ksid, 'undefined');
        
        return knownStockIDs[rec.symbol] = ctx.query('INSERT INTO stocks (stocktextid, lastvalue, ask, bid, lastchecktime, ' +
          'lrutime, leader, name, exchange, pieces) '+
          'VALUES (?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), NULL, ?, ?, ?) ON DUPLICATE KEY ' +
          'UPDATE ' + updateQueryString,
          [rec.symbol, rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000,
          rec.name, rec.exchange, rec.pieces].concat(updateParams)).then(function(res) {
            if (res.affectedRows === 1) { // insert took place
              return knownStockIDs[rec.symbol] = res.insertId;
            }
            
            // no insert -> look the id up
            return ctx.query('SELECT stockid FROM stocks WHERE stocktextid = ?', [rec.symbol], res => {
              assert.ok(res[0]);
              assert.ok(res[0].stockid);
              
              return knownStockIDs[rec.symbol] = res[0].stockid;
            });
          });
      }
    });
  }).then(() => {
    debug('Updated record', rec.symbol);
    
    return this.emitGlobal('stock-update', {
      'stockid': rec.symbol,
      'lastvalue': rec.lastTradePrice * 10000,
      'ask': rec.ask * 10000,
      'bid': rec.bid * 10000,
      'name': rec.name,
      'leader': null,
      'leadername': null,
      'exchange': rec.exchange,
      'pieces': rec.pieces
    });
  });
};

/**
 * Search for a stock by name, ISIN, etc.
 * 
 * @param {string} query.name  A string to search for in the stock name or an ISIN/WAN/etc.
 * 
 * @return {object} Returns with <code>stock-search-success</code>,
 *                  <code>stock-search-too-short</code> or a common error code and,
 *                  in case of success, sets <code>.results</code> to a {module:stocks~StockRecord[]}.
 * 
 * @function c2s~stock-search
 */
Stocks.prototype.searchStocks = buscomponent.provideQT('client-stock-search', function(query, ctx) {
  let str = String(query.name);
  if (!str || str.length < 3) {
    throw new this.SoTradeClientError('stock-search-too-short');
  }
  
  str = str.trim();
  
  const leadertest = str.match(this.leaderStockTextIDFormat);
  let lid = -1;
  if (leadertest !== null) {
    lid = leadertest[1];
  }
  
  const xstr = '%' + str.replace(/%/g, '\\%') + '%';
  
  let localResults;
  return Promise.all([
    this.getServerConfig(),
    ctx.query('SELECT stocks.stockid AS stockid, stocks.lastvalue AS lastvalue, stocks.ask AS ask, stocks.bid AS bid, ' +
      'stocks.leader AS leader, users.name AS leadername, wprovision, lprovision '+
      'FROM users ' +
      'JOIN stocks ON stocks.leader = users.uid ' +
      'JOIN users_finance ON users.uid = users_finance.uid ' +
      'WHERE users.name LIKE ? OR users.uid = ?', [xstr, lid]),
    ctx.query('SELECT *, 0 AS wprovision, 0 AS lprovision ' +
      'FROM stocks ' +
      'WHERE (name LIKE ? OR stocktextid LIKE ?) AND leader IS NULL',
      [xstr, xstr])
  ]).then(spread((cfg, localResults_, externalStocks) => {
    localResults = localResults_;
    const externalStocksIDs = _.pluck(externalStocks, 'stocktextid');

    // ISIN or WKN
    if (validator.isISIN(str.toUpperCase()) || /^[0-9A-Za-z]{6}$/.test(str)) {
      externalStocksIDs.push(str.toUpperCase());
    }
    
    return this.quoteLoader.loadQuotesList(_.uniq(externalStocksIDs), rec => this.stocksFilter(cfg, rec));
  })).then(externalResults => {
    let results = _.union(localResults, externalResults.map(r => {
      return {
        'stockid': r.symbol, /* backwards compatibility */
        'stocktextid': r.symbol,
        'lastvalue': r.lastTradePrice * 10000,
        'ask': r.ask * 10000,
        'bid': r.bid * 10000,
        'name': r.name,
        'exchange': r.exchange,
        'leader': null,
        'leadername': null,
        'wprovision': 0,
        'lprovision': 0,
        'pieces': r.pieces
      };
    }));
    
    debug('Search for stock', str, localResults.length + ' local', externalResults.length + ' external', results.length + ' unique');
    
    results = _.uniq(results, false, r => r.stocktextid);
    let symbols = _.pluck(results, 'stocktextid');
    
    if (symbols.length > 0 && !ctx.getProperty('readonly')) {
      symbols = symbols.map(encodeURIComponent);
      ctx.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() ' +
        'WHERE stocktextid IN (' + symbols.map(() => '?').join(',') + ')', symbols);
    }
    
    return { code: 'stock-search-success', results: results };
  });
});

/**
 * Indicates whether a given stock exchange is currently open
 * 
 * @param {string} sxname  A unique identifier of the stock exchange where the stock is being traded.
 * @param {object} cfg  The main server config.
 * 
 * @return {object} Returns with <code>stock-search-success</code>,
 *                  <code>stock-search-too-short</code> or a common error code and,
 *                  in case of success, sets <code>.results</code> to a {module:stocks~StockRecord[]}.
 * 
 * @return Returns true iff <code>sxname</code> is currently open.
 * 
 * @function busreq~stockExchangeIsOpen
 */
Stocks.prototype.stockExchangeIsOpen = buscomponent.provide('stockExchangeIsOpen', ['sxname', 'cfg'], function(sxname, cfg) {
  assert.ok(sxname);
  assert.ok(cfg);
  
  const sxdata = cfg.stockExchanges[sxname];
  if (!sxdata) {
    this.emitError(new Error('Unknown SX: ' + sxname));
    return false;
  }

  const opentime = Date.parse(sxdata.open).getTime();
  const closetime = Date.parse(sxdata.close).getTime();
  const now = new Date();
  
  const res = now.getTime() >= opentime && now.getTime() < closetime && sxdata.days.indexOf(now.getUTCDay()) !== -1;
  
  return res;
});

/**
 * Sells all shares held by a given user.
 * 
 * @param {Query} query  This goes ignored
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @noreadonly
 * @function busreq~sellAll
 */
Stocks.prototype.sellAll = buscomponent.provideWQT('sellAll', function(query, ctx) {
  debug('Sell all stocks', ctx.user && ctx.user.uid);
  
  return ctx.query('SELECT s.*, ds.* ' +
    'FROM stocks AS s ' +
    'JOIN depot_stocks AS ds ON ds.stockid = s.stockid ' +
    'WHERE s.leader = ?', [ctx.user.uid]).then(depotEntries => {
    
    return Promise.all(depotEntries.map(depotentry => {
      const newCtx = new qctx.QContext({
        parentComponent: this,
        user: {uid: depotentry.uid},
        access: ctx.access
      });
      
      return this.buyStock({
        amount: -depotentry.amount,
        leader: ctx.user.uid,
      }, newCtx, {
        forceNow: true
      });
    }));
  });
});

/**
 * Indicates that a user has made a stock trade.
 * 
 * @typedef s2c~trade
 * @type {Event}
 * 
 * @property {int} delay  Indicates that the event publishing has been delayed
 *                        by a given amount of time
 * @property {int} traderid  The numerical identifier of the trading user
 * @property {string} tradername  The chosen name of the trading user
 * @property {string} stocktextid  An identifier (e.g. ISIN) for the traded stock
 * @property {?int} leader  If set, indicates the numerical user id of the leader
 *                          associated with the stock
 * @property {int} money  The amount of money paid for buying the stock shares
 *                        (negative in case of selling)
 * @property {int} amount  The number of bought shares (negative in case of selling)
 * @property {int} prevmoney  The value of the previously held shares
 * @property {int} prevamount  The previously held number of shares
 * @property {int} buytime  A unix timestamp indicating when the trade occurred
 * @property {int} fee  The fee paid for executing the trade
 * @property {string} stockname  A human-readable name of the traded stock
 */

/**
 * Buys or sells a given amount of a given stock.
 * 
 * Selling is indicated by buying negative amounts.
 * You can only specify amounts by integer numbers;
 * The value and price of these shares is deduced from this number,
 * and never the other way around.
 * 
 * Transaction fees are being handled here; Also, due provision
 * will be transferred according to these calculations.
 * 
 * If this fails because the stock exchange was not open,
 * the query will automatically be added to the
 * [delayed queries database]{@link module:dqueries}.
 * 
 * @param {?int} query.leader  The id of a leader to buy shares from.
 *                             Either leader or stocktextid must be given.
 * @param {?string} query.stocktextid  The id of a stock to buy shares from.
 *                                     Either leader or stocktextid must be given.
 *                                     (<code>query.stockid</code> is deprecated, but equivalent).
 * @param {?object} query.dquerydata  A generic data object to be used with
 *                                    delayed query support (for closed stock 
 *                                    exchanges or unmet preconditions).
 * @param {?boolean} query._isDelayed Flag to indicate that the query came from
 *                                    the delayed queries list; Prevents multiple
 *                                    listing in the delayed queries list.
 * @param {?boolean} query.forceNow  Flag to indicate (for administrators) that
 *                                   the query should be executed now, regardless of
 *                                   unmet preconditions.
 * @param {int} query.amount  The number of stocks to buy/sell.
 * 
 * @return {object} Returns with <ul>
 *                  <li><code>stock-buy-success</code> in case of success</li>
 *                  <li><code>stock-buy-stock-not-found</code> in case no stock according to
 *                  <code>.leader</code>/<code>.stocktextid</code> was found</li>
 *                  <li><code>stock-buy-email-not-verif</code> in case a leader stock was requested
 *                  and the buying user’s e-mail was not verified yet</li>
 *                  <li><code>stock-buy-autodelay-sxnotopen</code> in case the stock exchange was not open
 *                  and the query was added to the delayed queries list</li>
 *                  <li><code>stock-buy-sxnotopen</code> in case the stock exchange was not open
 *                  and the query was <em>not</em> added to the delayed queries list (e.g. due to
 *                  <code>_isDelayed</code> being set</li>
 *                  <li><code>stock-buy-not-enough-stocks</code> in case the user attempted to sell more
 *                  shares than they previously possessed</li>
 *                  <li><code>stock-buy-out-of-money</code> in case the user attempted to buy more shares
 *                  than their financial situation allows</li>
 *                  <li><code>stock-buy-over-pieces-limit</code> in case the user attempted to buy
 *                  more shares than there are available on the current day</li>
 *                  <li><code>stock-buy-single-paper-share-exceed</code> in case the trade would result in
 *                  more then the configured maximum share of the total user value being invested in
 *                  this specific stock, or a common error code</li>
 *                  </ul>
 *                  and, in case of success, sets <code>.tradeid</code> and <code>.fee</code> accordingly.
 * 
 * @noreadonly
 * @function c2s~stock-buy
 */
Stocks.prototype.buyStock = buscomponent.provide('client-stock-buy',
  ['query', 'ctx', 'opt'], function(query, ctx, opt) {
  if (ctx.getProperty('readonly')) {
    throw new this.SoTradeClientError('server-readonly');
  }
  
  let conn, cfg, r, hadDepotStocksEntry, amount, price, ta_value, ures, ohr;
  let fee, oh_res = null, tradeID = null, perffull = null, forceNow;
  
  /*
   * We try to check the conditions for performing the trade without using
   * a transaction first, since this takes a bit of time and we don’t want
   * parts of the table locked for the entire time.
   */
  
  opt = opt || {};
  opt.forceNow = opt.forceNow || false;
  opt.testOnly = opt.testOnly || false;
  opt.skipTest = opt.skipTest || false;
  
  debug('Buy stock', query.leader, query.stocktextid, opt);
  
  return this.getServerConfig().then(cfg_ => {
    cfg = cfg_;
    
    if (opt.skipTest || opt.testOnly) {
      return { code: 'stock-buy-success', skippedTest: true }; // [sic]
    }
    
    const modifiedOptions = _.clone(opt);
    modifiedOptions.testOnly = true;
    return this.buyStock(query, ctx, modifiedOptions); // may throw exception!
  }).then(result => {
    assert.strictEqual(result.code, 'stock-buy-success'); // everything else should have thrown
    assert.ok(ctx.user);
    assert.ok(ctx.access);
    
    if (query.leader !== null) {
      query.stocktextid = '__LEADER_' + query.leader + '__';
    } else if (query.stockid && typeof query.stocktextid === 'undefined') {
      query.stocktextid = String(query.stockid); // backwards compatibility
    }
    
    if (opt.testOnly) {
      return {
        query: ctx.query.bind(ctx),
        commit:   () => Promise.resolve(),
        rollback: () => Promise.resolve()
      };
    }
    
    return ctx.startTransaction();
  }).then(conn_ => {
    conn = conn_;
    return conn.query('SELECT stocks.*, ' +
      'depot_stocks.amount AS amount, ' +
      'depot_stocks.amount * stocks.lastvalue AS money, ' +
      'depot_stocks.provision_hwm, depot_stocks.provision_lwm, stocks.bid, ' +
      'stocks.bid - depot_stocks.provision_hwm AS hwmdiff, ' +
      'stocks.bid - depot_stocks.provision_lwm AS lwmdiff, ' +
      'l.uid AS lid, l.wprovision AS wprovision, l.lprovision AS lprovision ' +
      'FROM stocks ' +
      'LEFT JOIN depot_stocks ON depot_stocks.uid = ? AND depot_stocks.stockid = stocks.stockid ' +
      'LEFT JOIN users_finance AS l ON stocks.leader = l.uid AND depot_stocks.uid != l.uid ' +
      'WHERE stocks.stocktextid = ? FOR UPDATE', [ctx.user.uid, String(query.stocktextid)]);
  }).then(res => {
    if (res.length === 0 || res[0].lastvalue === 0) {
      throw new this.SoTradeClientError('stock-buy-stock-not-found');
    }
    
    assert.equal(res.length, 1);
    
    r = res[0];
    
    hadDepotStocksEntry = (r.amount !== null);
    
    if (r.money === null)  { r.money = 0; }
    if (r.amount === null) { r.amount = 0; }
    
    if (this.leaderStockTextIDFormat.test(query.stocktextid) && !ctx.access.has('email_verif') && !opt.forceNow) {
      throw new this.SoTradeClientError('stock-buy-email-not-verif');
    }
    
    forceNow = opt.forceNow || (ctx.access.has('stocks') && query.forceNow);
    
    if (!this.stockExchangeIsOpen(r.exchange, cfg) && !forceNow) {
      if (!query._isDelayed) {
        query.retainUntilCode = 'stock-buy-success';
        this.request({name: 'client-dquery', 
          ctx: ctx,
          query: { 
            condition: 'stock::' + r.stocktextid + '::exchange-open > 0',
            query: query,
          }
        });
        
        throw new this.SoTradeClientError('stock-buy-autodelay-sxnotopen');
      } else {
        throw new this.SoTradeClientError('stock-buy-sxnotopen');
      }
    }
    
    amount = parseInt(query.amount);
    if (amount < -r.amount || amount !== amount) {
      throw new this.SoTradeClientError('stock-buy-not-enough-stocks');
    }
    
    ta_value = amount > 0 ? r.ask : r.bid;
    
    assert.ok(r.ask >= 0);
    assert.ok(r.stocktextid);
    
    // re-fetch freemoney because the 'user' object might come from dquery
    return Promise.all([
      conn.query('SELECT freemoney, totalvalue FROM users_finance AS f WHERE uid = ? FOR UPDATE', [ctx.user.uid]),
      conn.query('SELECT ABS(SUM(amount)) AS amount FROM orderhistory ' +
        'WHERE stocktextid = ? AND uid = ? AND buytime > FLOOR(UNIX_TIMESTAMP()/86400)*86400 AND SIGN(amount) = SIGN(?)',
        [r.stocktextid, ctx.user.uid, r.amount])
    ]);
  }).then(spread((ures_, ohr_) => {
    ures = ures_;
    ohr = ohr_;
    
    assert.equal(ures.length, 1);
    assert.equal(ohr.length, 1);
    
    price = amount * ta_value;
    if (price > ures[0].freemoney && price >= 0) {
      throw new this.SoTradeClientError('stock-buy-out-of-money');
    }
    
    const tradedToday = ohr[0].amount || 0;
    
    if ((r.amount + amount) * r.bid >= ures[0].totalvalue * cfg['maxSingleStockShare'] && price >= 0 &&
        !ctx.access.has('stocks')) {
      throw new this.SoTradeClientError('stock-buy-single-paper-share-exceed');
    }
    
    if (Math.abs(amount) + tradedToday > r.pieces && !ctx.access.has('stocks') && !forceNow) {
      throw new this.SoTradeClientError('stock-buy-over-pieces-limit');
    }
    
    // point of no return
    if (opt.testOnly) {
      throw { code: 'stock-buy-success', testOnly: true };
    }
    
    fee = Math.max(Math.abs(cfg['transactionFeePerc'] * price), cfg['transactionFeeMin']);
    
    return conn.query('INSERT INTO orderhistory (uid, stocktextid, leader, money, buytime, amount, fee, stockname, prevmoney, prevamount) ' +
      'VALUES(?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?, ?, ?)',
      [ctx.user.uid, r.stocktextid, r.leader, price, amount, fee, r.name, r.money, r.amount]);
  })).then(oh_res_ => {
    oh_res = oh_res_;
    
    if (amount <= 0 && ((r.hwmdiff && r.hwmdiff > 0) || (r.lwmdiff && r.lwmdiff < 0))) {
      let wprovPay = r.hwmdiff * -amount * r.wprovision / 100.0;
      let lprovPay = r.lwmdiff * -amount * r.lprovision / 100.0;

      if (wprovPay < 0) { wprovPay = 0; }
      if (lprovPay > 0) { lprovPay = 0; }
      
      const totalprovPay = wprovPay + lprovPay;
      
      return conn.query('INSERT INTO transactionlog (orderid, type, stocktextid, a_user, p_user, amount, time, json) ' + 
        'VALUES (?, "provision", ?, ?, ?, ?, UNIX_TIMESTAMP(), ?)',
        [oh_res.insertId, r.stocktextid, ctx.user.uid, r.lid, totalprovPay, JSON.stringify({
          reason: 'trade',
          provision_hwm: r.provision_hwm,
          provision_lwm: r.provision_lwm,
          bid: r.bid,
          depot_amount: amount
        })]).then(() => {
          return conn.query('UPDATE users_finance AS f SET freemoney = freemoney - ?, ' +
            'totalvalue = totalvalue - ? ' +
            'WHERE uid = ?',
          [totalprovPay, totalprovPay, ctx.user.uid]);
        }).then(() => {
          return conn.query('UPDATE users_finance AS l SET freemoney = freemoney + ?, ' +
            'totalvalue = totalvalue + ?, wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? ' +
            'WHERE uid = ?',
          [totalprovPay, totalprovPay, wprovPay, lprovPay, r.lid]);
        });
    }
  }).then(() => {
    return ctx.feed({
      'type': 'trade',
      'targetid': oh_res.insertId,
      'srcuser': ctx.user.uid,
      'json': {
        delay: !!ures[0].delayorderhist ? cfg.delayOrderHistTime : 0,
        dquerydata: query.dquerydata || null,
        leader: r.leader
      },
      'feedusers': r.leader ? [r.leader] : [],
      'conn': conn
    });
  }).then(() => {
    tradeID = oh_res.insertId;
    
    const perfn = r.leader ? 'fperf' : 'operf';
    const perfv = amount >= 0 ? 'bought' : 'sold';
    perffull = perfn + '_' + perfv;
    
    return conn.query('INSERT INTO transactionlog (orderid, type, stocktextid, a_user, p_user, amount, time, json) VALUES ' + 
      '(?, "stockprice", ?, ?, NULL, ?, UNIX_TIMESTAMP(), ?), ' +
      '(?, "fee",        ?, ?, NULL, ?, UNIX_TIMESTAMP(), ?)',
      [oh_res.insertId, r.stocktextid, ctx.user.uid, price, JSON.stringify({reason: 'trade'}),
       oh_res.insertId, r.stocktextid, ctx.user.uid, fee,   JSON.stringify({reason: 'trade'})]);
  }).then(() => {
    return conn.query('UPDATE users AS fu SET tradecount = tradecount + 1 WHERE uid = ?', [ctx.user.uid]);
  }).then(() => {
    return conn.query('UPDATE users_finance AS f SET freemoney = freemoney - ?, totalvalue = totalvalue - ?, '+
      perffull + '=' + perffull + ' + ABS(?) ' +
      ' WHERE uid = ?', [price+fee, fee, price, ctx.user.uid]);
  }).then(() => {
    if (!hadDepotStocksEntry) {
      assert.ok(amount >= 0);
      
      return conn.query('INSERT INTO depot_stocks (uid, stockid, amount, buytime, buymoney, provision_hwm, provision_lwm) VALUES(?,?,?,UNIX_TIMESTAMP(),?,?,?)', 
        [ctx.user.uid, r.stockid, amount, price, ta_value, ta_value]);
    } else {
      return conn.query('UPDATE depot_stocks SET ' +
        'buytime = UNIX_TIMESTAMP(), buymoney = buymoney + ?, ' +
        'provision_hwm = (provision_hwm * amount + ?) / (amount + ?), ' +
        'provision_lwm = (provision_lwm * amount + ?) / (amount + ?), ' +
        'amount = amount + ? ' +
        'WHERE uid = ? AND stockid = ?', 
        [price, price, amount, price, amount, amount, ctx.user.uid, r.stockid]);
    }
  }).then(() => {
    return conn.commit();
  }).then(() => {
    return { code: 'stock-buy-success', fee: fee, tradeid: tradeID, extra: 'repush' };
  }).catch(err => {
    return (conn ? conn.rollback() : Promise.resolve()).then(() => {
      if (err.code === 'stock-buy-success') {
        return err; // for testOnly runs
      } else {
        throw err; // re-throw
      }
    });
  });
});

/**
 * Represents an entry in the depot of a user.
 * @typedef module:stocks~DepotEntry
 * @type object
 * @augments module:stocks~StockRecord
 * 
 * @property {int} amount  The number of shares currently being held.
 * @property {int} buytime  The unix timestamp of the least recent trade pertaining to this entry.
 * @property {number} buymoney  The (sum of the) money spent on buying/selling this stock (1/10000 units).
 * @property {number} wprov_sum  The total of gain provisions for this leader stock (otherwise 0).
 * @property {number} lprov_sum  The total of loss provisions for this leader stock (otherwise 0).
 * @property {number} lastvalue  The current value of a single share.
 * @property {number} ask  The current ask price of a single share.
 * @property {number} bid  The current bid price of a single share.
 * @property {number} total  The current bid value of this entry.
 * @property {number} weekstartvalue  The bid value at the start of the week.
 * @property {number} daystartvalue  The bid value at the start of the day.
 * @property {?int} leader  The user id of this stock’s leader.
 * @property {?string} leadername  The user name of this stock’s leader.
 * @property {string} exchange  The stock exchange id on which this stock is being traded.
 * @property {string} stockname  A human-redable name for this stock.
 */

/**
 * List all stocks of the requesting user.
 * 
 * @return {object} Returns with <code>list-own-depot-success</code> or a common error code and,
 *                  in case of success, sets <code>.results</code> as a {module:stocks~DepotEntry[]} accordingly.
 * 
 * @function c2s~list-own-depot
 */
Stocks.prototype.stocksForUser = buscomponent.provideQT('client-list-own-depot', function(query, ctx) {
  return ctx.query('SELECT ' +
    'amount, buytime, buymoney, ds.wprov_sum AS wprov_sum, ds.lprov_sum AS lprov_sum, ' +
    's.stocktextid AS stocktextid, lastvalue, ask, bid, bid * amount AS total, weekstartvalue, daystartvalue, ' +
    'users.uid AS leader, users.name AS leadername, exchange, s.name, ' +
    'IF(leader IS NULL, s.name, CONCAT("Leader: ", users.name)) AS stockname ' +
    'FROM depot_stocks AS ds ' +
    'JOIN stocks AS s ON s.stockid = ds.stockid ' +
    'LEFT JOIN users ON s.leader = users.uid ' +
    'WHERE ds.uid = ? AND amount != 0',
    [ctx.user.uid]).then(results => {
    /* backwards compatibility */
    for (let i = 0; i < results.length; ++i) {
      results[i].stockid = results[i].stocktextid;
    }
    
    return { code: 'list-own-depot-success', 'results': results };
  });
});

/**
 * Represents a generic payment.
 * Other properties than those given below depent on the transaction type.
 * @typedef module:stocks~TransactionLogEntry
 * @type object
 * 
 * @property {string} type  The kind of payment (<code>fee</code>, <code>stockprice</code>,
 *                          <code>provision</code>)
 * @property {?int} orderid  The order ID of the relevant trade.
 * @property {string} stocktextid  The stock identifier (ISIN/etc.) of the relevant stock.
 * @property {int}     a_user The active user of this transaction (buyer, follower, etc.).
 * @property {string}  aname  The active user’s name
 * @property {?int}    p_user The passive user of this transaction (leader etc.).
 * @property {?string} pname  The passive user’s name
 * @property {number} amount  The amount of money passed in this transaction.
 * @property {int} time  The unix timestamp of this transaction.
 */

/**
 * List all transactions involving the requesting user, i.e. all payments
 * between users (like provisions) or between the user and the game
 * (like trading prices and fees).
 * 
 * This enhances transparency of a user’s financial assets by giving
 * detailed information on time, amount and reason of payments.
 * 
 * @return {object} Returns with <code>list-transactions-success</code> or a common error code and,
 *                  in case of success, sets <code>.results</code> as a {module:stocks~TransactionLogEntry[]} accordingly.
 * 
 * @function c2s~list-transactions
 */
Stocks.prototype.listTransactions = buscomponent.provideQT('client-list-transactions', function(query, ctx) {
  return ctx.query('SELECT t.*, a.name AS aname, p.name AS pname, s.name AS stockname FROM transactionlog AS t ' +
    'LEFT JOIN users AS a ON a.uid = t.a_user ' +
    'LEFT JOIN users AS p ON p.uid = t.p_user ' +
    'LEFT JOIN stocks AS s ON s.stocktextid = t.stocktextid ' +
    'WHERE t.a_user = ? OR t.p_user = ? ', [ctx.user.uid, ctx.user.uid]).then(results => {
    for (let i = 0; i < results.length; ++i) {
      results[i].json = results[i].json ? JSON.parse(results[i].json) : {};
    }

    return { code: 'list-transactions-success',  results: results  };
  });
});

/**
 * Lists info for a specific trade.
 * 
 * @return {object} Returns with <code>get-trade-info-notfound</code>,
 *                  <code>get-trade-info-success</code> or a common error code and,
 *                  in case of success, sets <code>.trade</code> and <code>.comments</code>
 *                  accordingly.
 * 
 * @function c2s~get-trade-info
 */
Stocks.prototype.getTradeInfo = buscomponent.provideQT('client-get-trade-info', function(query, ctx) {
  const tradeid = parseInt(query.tradeid);
  if (tradeid !== tradeid) {
    throw new this.FormatError();
  }
  
  let r;
  return Promise.all([
    this.getServerConfig(),
    ctx.query('SELECT oh.* ,s.*, u.name, events.eventid AS eventid, trader.delayorderhist FROM orderhistory AS oh ' +
      'LEFT JOIN stocks AS s ON s.leader = oh.leader ' +
      'LEFT JOIN events ON events.type = "trade" AND events.targetid = oh.orderid ' +
      'LEFT JOIN users AS u ON u.uid = oh.leader ' +
      'LEFT JOIN users AS trader ON trader.uid = oh.uid WHERE oh.orderid = ?', [tradeid])
  ]).then(spread((cfg, oh_res) => {
    if (oh_res.length === 0) {
      throw new this.SoTradeClientError('get-trade-info-notfound');
    }
    
    r = oh_res[0];
    
    if (r.uid !== ctx.user.uid &&
        !!r.delayorderhist &&
        (Date.now()/1000 - r.buytime < cfg.delayOrderHistTime) &&
        !ctx.access.has('stocks')) {
      throw new this.SoTradeClientError('get-trade-delayed-history');
    }
    
    r.userid = r.uid; // backwards compatibility
    assert.equal(r.uid, parseInt(r.uid));
    
    return ctx.query('SELECT c.*,u.name AS username, u.uid AS uid, url AS profilepic, trustedhtml ' +
      'FROM ecomments AS c ' +
      'LEFT JOIN httpresources ON httpresources.uid = c.commenter AND httpresources.role = "profile.image" ' +
      'LEFT JOIN users AS u ON c.commenter = u.uid ' +
      'WHERE c.eventid = ?', [r.eventid]);
  })).then(comments => {
    return { code: 'get-trade-info-success', 'trade': r, 'comments': comments };
  });
});

/**
 * Lists the most popular stocks.
 * 
 * These are ordered according to a weighted average of the money amounts
 * involved in the relevant trades, specifically:
 * 
 * <ul>
 *     <li>No trades older than 3 weeks are taken into consideration</li>
 *     <li>Each trade’s value is added to its stock according to:
 *         <math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *             <mfrac>
 *                 <mrow>| money involved in trade |</mrow>
 *                 <mrow>| time difference now - trade time in seconds + 300 |</mrow>
 *             </mfrac>
 *         </math>
 *     </li>
 * </ul>
 * 
 * @param {?int} query.days  A number of days specifying how long into the past
 *                  the popular stocks list should reach.
 * 
 * @return {object} Returns with <code>list-popular-stocks-success</code>,
 *                  with <code>.results</code> being set to a list of stocks,
 *                  which carry the properties <code>stockid, stockname, moneysum, wsum</code>,
 *                  the latter being the sum of the above formula over all trades for that stock.
 * 
 * @function c2s~list-popular-stocks
 */
Stocks.prototype.listPopularStocks = buscomponent.provideQT('client-list-popular-stocks', function(query, ctx) {
  let days = parseInt(query.days);
  
  return this.getServerConfig().then(cfg => {
    if (days !== days || (days > cfg.popularStocksDays && !ctx.access.has('stocks'))) {
      days = cfg.popularStocksDays;
    }
    
    return ctx.query('SELECT oh.stocktextid, oh.stockname, ' +
      'SUM(ABS(money)) AS moneysum, ' +
      'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
      'FROM orderhistory AS oh ' +
      'WHERE buytime > UNIX_TIMESTAMP() - 86400 * ? ' +
      'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 20', [days]);
  }).then(popular => {
    /* backwards compatibility */
    for (let i = 0; i < popular.length; ++i) {
      popular[i].stockid = popular[i].stocktextid;
    }
    
    return { code: 'list-popular-stocks-success', 'results': popular };
  });
});

exports.Stocks = Stocks;
