// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const _ = require('lodash');
const assert = require('assert');
const validator = require('validator');
const debug = require('debug')('sotrade:stocks');
const qctx = require('./qctx.js');
const api = require('./api.js');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;
require('datejs'); // XXX

const leaderStockTextIDFormat = /^__LEADER_(\d+)__$/;

class StockIDCache extends api.Component {
  constructor() {
    super({
      local: true
    });
    
    this.knownStockIDs = null; // ISIN list for more efficient stock updating
  }
  
  init() {
    const ctx = new qctx.QContext({parentComponent: this});
    
    return this.updateStockIDCache(ctx);
  }
  
  updateStockIDCache(ctx) {
    return this.knownStockIDs = ctx.query('SELECT stockid, stocktextid FROM stocks').then(stockidlist => {
      debug('Generating ISIN |-> id map', stockidlist.length + ' entries');
      
      this.knownStockIDs = {};
      
      for (let entry of stockidlist) {
        assert.equal(typeof entry.stockid, 'number');
        assert.ok(leaderStockTextIDFormat.test(entry.stocktextid) || validator.isISIN(entry.stocktextid));
        this.knownStockIDs[entry.stocktextid] = entry.stockid;
      }
    });
  }
}

class StocksFilter extends api.Component {
  constructor() {
    super({
      local: true
    });
  }
  
  /**
   * Indicates whether a [stock record]{@link StockRecord} is admissible for this game instance.
   * This checks the stock exchange and the currency of the record against the game config.
   * 
   * @param {object} cfg   The server main config.
   * @param {StockRecord}  rec The record to test.
   * 
   * @return {boolean} Whether the record is admissible for this game instance.
   */
  test(cfg, rec) {
    return Object.keys(cfg.stockExchanges).indexOf(rec.exchange) !== -1 &&
        rec.currency_name === cfg.requireCurrency &&
        rec.ask * 10000 >= cfg.minAskPrice &&
        rec.lastTradePrice > 0;
  }
}

class StockQuoteLoaderInterface extends api.Component {
  constructor() {
    super({
      depends: [StocksFilter, 'StockQuoteLoaderProvider', 'ReadonlyStore'],
      local: true
    });
    
    this.quoteLoader = null;
  }
  
  init() {
    const ctx = new qctx.QContext({parentComponent: this});
    
    this.quoteLoader = this.load('StockQuoteLoaderProvider').resolve();
    assert.ok(this.quoteLoader);
    
    this.quoteLoader.on('record', rec => {
      return Promise.resolve().then(() => {
        return this.updateRecord(ctx, rec);
      });
    });
  }
  
  /**
   * Updates the stock tables.
   * Fetches all stocks currently in use and updates the corresponding database values.
   * Also, for each record, emit a <code>stock-update</code> event on the bus.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * @param {module:stocks~StockRecord} rec  A stock record to process
   */
  updateRecord(ctx, rec) {
    if (rec.failure) {
      return;
    }
    
    const cfg = this.load('Config').config();
    assert.notEqual(rec.lastTradePrice, null);
    if (rec.lastTradePrice === 0 || rec.ask < cfg.minAskPrice) { // happens with API sometimes.
      return;
    }
    
    assert.notStrictEqual(rec.pieces, null);
    
    if (this.load('ReadonlyStore').readonly) {
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
          rec.name, rec.exchange, rec.pieces].concat(updateParams)).then(res => {
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
    }).then(() => {
      debug('Updated record', rec.symbol);
      
      return this.load('PubSub').publish('stock-update', {
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
  }
  
  loadQuotesList(stockIDs) {
    const filter = this.load(StocksFilter);
    const cfg = this.load('Config').config();
    
    return this.quoteLoader.loadQuotesList(_.uniq(stockIDs), rec => filter.test(cfg, rec));
  }
}

class StockValueUpdater extends api.Component {
  constructor() {
    super({
      description: 'Updates the stock tables.',
      depends: [StockQuoteLoaderInterface],
      local: true
    });
  }
  
  updateStockValues(ctx, cfg) {
    debug('Update stock values');
    
    let stocklist = [];
    
    return ctx.query('SELECT * FROM stocks ' +
      'WHERE leader IS NULL AND UNIX_TIMESTAMP()-lastchecktime > ? AND UNIX_TIMESTAMP()-lrutime < ?',
    [cfg.lrutimeLimit, cfg.refetchLimit]).then(res => {
      stocklist = _.map(res, 'stocktextid');
      
      const dqNeededStocks = this.load('DelayedQueries').getNeededStocks();
      
      stocklist = _.union(stocklist, dqNeededStocks);
      
      stocklist = stocklist.filter(s => !leaderStockTextIDFormat.test(s));
      
      if (stocklist.length > 0) {
        return this.load(StockQuoteLoaderInterface).loadQuotesList(stocklist);
      }
    });
  }
}

class StocksRegularTasks extends api.Component {
  constructor() {
    super({
      identifier: 'StocksRegularTasks',
      description: 'Regularly called function to perform various cleanup and update tasks.',
      schema: {
        type: 'object',
        properties: {
          weekly: { type: 'boolean' },
          daily: { type: 'boolean' },
          provisions: { type: 'boolean' }
        }
      },
      depends: ['UpdateProvisions', 'UpdateLeaderMatrix', StockIDCache, StockValueUpdater, 'ReadonlyStore']
    });
  }
  
  handle(query, ctx) {
    const cfg = this.load('Config').config();
    
    if (this.load('ReadonlyStore').readonly) {
      return;
    }
      
    let rcbST, rcbET, cddET, cuusET, usvET, ulmET, uriET, uvhET, upET, wcbET, usicST;
    rcbST = Date.now();
    
    return this.cleanUpDepotDuplicates(ctx).then(() => {
      cddET = Date.now();
      return this.cleanUpUnusedStocks(ctx);
    }).then(() => {
      cuusET = Date.now();
      return this.load(StockValueUpdater).updateStockValues(ctx, cfg);
    }).then(() => {
      usvET = Date.now();
      return this.load('UpdateLeaderMatrix').handle(ctx, cfg);
    }).then(() => {
      ulmET = Date.now();
      
      if (query.provisions) {
        return this.load('UpdateProvisions').handle(ctx, cfg);
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
      return this.load(StockIDCache).updateStockIDCache(ctx);
    }).then(() => {
      rcbET = Date.now();
      console.log('cleanUpDepotDuplicates:   ' + (cddET   - rcbST)  + ' ms');
      console.log('cleanUpUnusedStocks:      ' + (cuusET  - cddET)  + ' ms');
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
  }
  
  /**
   * Updates follower finance data, specifically the <code>fperf_cur</code> and
   * <code>operf_cur</code> values.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * 
   * @return {object}  A Promise indicating task completion
   */
  updateRankingInformation(ctx) {
    debug('Update ranking information');
    
    return ctx.query('UPDATE users_finance SET ' +
      'fperf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.stockid ' +
        'WHERE uid = users_finance.uid AND leader IS NOT NULL), ' +
      'operf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.stockid ' +
        'WHERE uid = users_finance.uid AND leader IS NULL)');
  }

  /**
   * Adds new entries to the global user finance history.
   * These values can later be retrieved and used for charting and ranking.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * 
   * @return {object}  A Promise indicating task completion
   */
  updateValueHistory(ctx) {
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
  }

  /**
   * This function is intended to be called on each day start.
   * The day start value property of all stocks is set to the current “bid” price.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * 
   * @return {object}  A Promise indicating task completion
   */
  dailyCallback(ctx) {
    debug('Daily callback');
    
    return ctx.query('UPDATE stocks SET daystartvalue = bid');
  }

  /**
   * This function is intended to be called on each week start.
   * The week start value property of all stocks is set to the current “bid” price.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * 
   * @return {object}  A Promise indicating task completion
   * @function module:stocks~Stocks#weeklyCallback
   */
  weeklyCallback(ctx) {
    debug('Weekly callback');
    
    return ctx.query('UPDATE stocks SET weekstartvalue = bid');
  }

  /**
   * Cleans up the stock tables.
   * Deletes depot entries with 0 shares and sets the <code>lrutime</code> 
   * (least recent use time) flag on all stocks.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   *
   * @return {object}  A Promise indicating task completion
   */
  cleanUpUnusedStocks(ctx) {
    debug('Clean up unused stocks');
    
    return ctx.query('DELETE FROM depot_stocks WHERE amount = 0')
    .then(() => {
      return ctx.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE ' +
        '(SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.stockid = stocks.stockid) != 0 ' +
        'OR (SELECT COUNT(*) FROM watchlists AS w WHERE w.watched  = stocks.stockid) != 0 ' +
        'OR leader IS NOT NULL');
    });
  }

  /**
   * Cleans up the depot tables.
   * Unifies duplicate depot entries.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   *
   * @return {object}  A Promise indicating task completion
   * @function module:stocks~Stocks#cleanUpDepotDuplicates
   */
  cleanUpDepotDuplicates(ctx) {
    debug('Clean up duplicate depot entries');
    
    return ctx.startTransaction().then(conn => {
      return conn.query('SELECT ' +
        'MIN(depotentryid) AS idx, ' +
        'SUM(amount) AS amount, SUM(buymoney) AS buymoney, ' +
        'SUM(wprov_sum) AS wprov_sum, SUM(lprov_sum) AS lprov_sum, ' +
        'uid, stockid, COUNT(1) AS n_ent ' +
        'FROM depot_stocks ' +
        'GROUP BY uid, stockid ' +
        'HAVING n_ent > 1 FOR UPDATE').then(res => {
        // res is likely to be small
        
        debug('Deduplicating depot entries', res.length);
        return Promise.all(res.map(r => {
          assert.ok(!isNaN(parseInt(r.idx)));
          assert.ok(!isNaN(parseInt(r.amount)));
          assert.ok(!isNaN(parseInt(r.buymoney)));
          assert.ok(!isNaN(parseInt(r.wprov_sum)));
          assert.ok(!isNaN(parseInt(r.lprov_sum)));
          
          return Promise.all([
            conn.query('UPDATE depot_stocks ' +
              'SET amount = ?, buymoney = ?, wprov_sum = ?, lprov_sum = ? ' +
              'WHERE depotentryid = ?',
              [r.amount, r.buymoney, r.wprov_sum, r.lprov_sum, r.idx]),
            conn.query('DELETE FROM depot_stocks ' +
              'WHERE uid = ? AND stockid = ? AND depotentryid != ?',
              [r.uid, r.stockid, r.idx])
          ]);
        }));
      }).then(conn.commit, conn.rollbackAndThrow);
    });
  }
}

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

/** */
class StockSearch extends api.Requestable {
  constructor() {
    super({
      url: '/stocks/search/:name',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 403, identifier: 'name-too-short' }
      ],
      description: 'Search for a stock by name, ISIN, etc.',
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A string to search for in the stock name or an ISIN'
          }
        },
        required: ['name']
      },
      depends: [StockQuoteLoaderInterface]
    });
  }
  
  handle(query, ctx, cfg) {
    let str = String(query.name);
    if (!str || str.length < 3) {
      throw new this.ClientError('name-too-short');
    }
    
    str = str.trim();
    
    const leadertest = str.match(leaderStockTextIDFormat);
    let lid = -1;
    if (leadertest !== null) {
      lid = leadertest[1];
    }
    
    const xstr = '%' + str.replace(/%/g, '\\%') + '%';
    
    let localResults;
    return Promise.all([
      ctx.query('SELECT stocks.stockid, stocks.stocktextid, stocks.lastvalue, stocks.ask, stocks.bid, ' +
        'stocks.leader, users.name AS leadername, wprovision, lprovision '+
        'FROM users ' +
        'JOIN stocks ON stocks.leader = users.uid ' +
        'JOIN users_finance ON users.uid = users_finance.uid ' +
        'WHERE users.name LIKE ? OR users.uid = ?', [xstr, lid]),
      ctx.query('SELECT *, 0 AS wprovision, 0 AS lprovision ' +
        'FROM stocks ' +
        'WHERE (name LIKE ? OR stocktextid LIKE ?) AND leader IS NULL',
        [xstr, xstr])
    ]).then(spread((localResults_, externalStocks) => {
      localResults = cfg.forbidLeaderTrades ? [] : localResults_;
      const externalStocksIDs = _.map(externalStocks, 'stocktextid');

      if (validator.isISIN(str.toUpperCase())) {
        externalStocksIDs.push(str.toUpperCase());
      }
      
      return this.load(StockQuoteLoaderInterface).loadQuotesList(externalStocksIDs);
    })).then(externalResults => {
      let results = _.union(localResults, externalResults.map(r => {
        return {
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
      let symbols = _.map(results, 'stocktextid');
      
      if (symbols.length > 0 && !this.load('ReadonlyStore').readonly) {
        symbols = symbols.map(encodeURIComponent);
        ctx.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() ' +
          'WHERE stocktextid IN (' + symbols.map(() => '?').join(',') + ')', symbols);
      }
      
      return { code: 200, data: results };
    });
  }
}

class StockExchangeIsOpen extends api.Component {
  constructor() {
    super({
      identifier: 'StockExchangeIsOpen'
    });
  }
  
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
   */
  test(sxname, cfg) {
    assert.ok(sxname);
    assert.ok(cfg);
    
    const sxdata = cfg.stockExchanges[sxname];
    if (!sxdata) {
      this.load('PubSub').emit('error', new Error('Unknown SX: ' + sxname));
      return false;
    }

    const opentime = Date.parse(sxdata.open).getTime();
    const closetime = Date.parse(sxdata.close).getTime();
    const now = new Date();
    
    const res = now.getTime() >= opentime && now.getTime() < closetime && sxdata.days.indexOf(now.getUTCDay()) !== -1;
    
    return res;
  }
}

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

/** */
class StockTrade extends api.Requestable {
  constructor() {
    super({
      identifier: 'StockTrade',
      description: 'Buys or sells a given amount of a given stock.',
      notes: 'Selling is indicated by buying negative amounts.\n' +
        'You can only specify amounts by integer numbers; ' +
        'The value and price of these shares is deduced from this number, ' +
        'and never the other way around.\n' +
        '\n' +
        'Transaction fees are being handled here; Also, due provision ' +
        'will be transferred according to these calculations.\n' +
        '\n' +
        'If this fails because the stock exchange was not open, ' +
        'the query will automatically be added to the ' +
        '[delayed queries database]{@link module:dqueries}.',
      url: '/trade',
      methods: ['POST'],
      writing: true,
      schema: {
        type: 'object',
        properties: {
          leader: {
            type: 'integer',
            description: 'The id of a leader to buy shares from',
            notes: 'Either leader or stocktextid must be given.'
          },
          stocktextid: {
            type: 'string',
            description: 'The id of a stock to buy shares from',
            notes: 'Either leader or stocktextid must be given.'
          },
          dquerydata: {
            type: 'object',
            description: 'A generic data object to be used with delayed ' +
              'query support (for closed stock exchanges or unmet preconditions)',
            properties: { _dummyProperty: { type: 'null' } }
          },
          _isDelayed: {
            type: 'boolean',
            description: 'Flag to indicate that the query came from the delayed queries list'
          },
          forceNow: {
            type: 'boolean',
            description: 'Flag to indicate (for administrators) that the query should be ' +
              'executed now, regardless of unmet preconditions.'
          },
          amount: {
            type: 'integer',
            description: 'The number of stocks to buy/sell.'
          }
        },
        required: ['amount']
      },
      returns: [
        { code: 200, identifier: 'success' },
        { code: 404, identifier: 'stock-not-found' },
        { code: 403, identifier: 'email-not-verif' },
        { code: 503, identifier: 'sxnotopen' },
        { code: 200, identifier: 'autodelay-sxnotopen' },
        { code: 403, identifier: 'not-enough-stocks' },
        { code: 403, identifier: 'ouf-of-money' },
        { code: 403, identifier: 'over-pieces-limit' },
        { code: 403, identifier: 'single-paper-share-exceeded' }
      ],
      depends: [
        StockExchangeIsOpen
      ]
    });
  }
  
  handle(query, ctx, cfg, opt) {
    let conn, r, hadDepotStocksEntry, amount, price, ta_value, ures, ohr;
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
    let stocktextid;
    
    return Promise.resolve().then(() => {
      if (opt.skipTest || opt.testOnly) {
        return { code: 200, skippedTest: true }; // [sic]
      }
      
      const modifiedOptions = _.clone(opt);
      modifiedOptions.testOnly = true;
      return this.handle(query, ctx, cfg, modifiedOptions); // may throw exception!
    }).then(result => {
      assert.strictEqual(result.code, 200); // everything else should have thrown
      assert.ok(ctx.user);
      assert.ok(ctx.access);
      
      stocktextid = query.leader === null ? query.stocktextid : 
        '__LEADER_' + query.leader + '__';
      
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
        'WHERE stocks.stocktextid = ? FOR UPDATE', [ctx.user.uid, stocktextid]);
    }).then(res => {
      if (res.length === 0 || res[0].lastvalue === 0 || res[0].ask < cfg.minAskPrice) {
        throw new this.ClientError('stock-not-found');
      }
      
      assert.equal(res.length, 1);
      
      r = res[0];
      
      if (r.lid !== null && cfg.forbidLeaderTrades) {
        throw new this.ClientError('no-leader-trades');
      }
      
      hadDepotStocksEntry = (r.amount !== null);
      
      if (r.money === null)  { r.money = 0; }
      if (r.amount === null) { r.amount = 0; }
      
      if (leaderStockTextIDFormat.test(stocktextid) && !ctx.access.has('email_verif') && !opt.forceNow) {
        throw new this.ClientError('email-not-verif');
      }
      
      forceNow = opt.forceNow || (ctx.access.has('stocks') && query.forceNow);
      
      if (!this.load(StockExchangeIsOpen).test(r.exchange, cfg) && !forceNow) {
        if (!query._isDelayed) {
          const dquery = Object.assign({
            retainUntilCode: 200
          }, query);
          
          this.load('PubSub').publish('dquery-should-be-added', { 
            condition: 'stock::' + r.stocktextid + '::exchange-open > 0',
            query: dquery
          });
          
          throw new this.ClientError('autodelay-sxnotopen');
        } else {
          throw new this.ClientError('sxnotopen');
        }
      }
      
      amount = parseInt(query.amount);
      if (amount < -r.amount || amount !== amount) {
        throw new this.ClientError('not-enough-stocks');
      }
      
      ta_value = amount > 0 ? r.ask : r.bid;
      
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
        debug('Trying to buy stocks with too few money', price, ures[0].freemoney, ctx.user.uid);
        throw new this.ClientError('out-of-money');
      }
      
      const tradedToday = ohr[0].amount || 0;
      
      if ((r.amount + amount) * r.bid >= ures[0].totalvalue * cfg['maxSingleStockShare'] && price >= 0 &&
          !ctx.access.has('stocks')) {
        throw new this.ClientError('single-paper-share-exceed');
      }
      
      if (Math.abs(amount) + tradedToday > r.pieces && !ctx.access.has('stocks') && !forceNow) {
        throw new this.ClientError('over-pieces-limit');
      }
      
      // point of no return
      if (opt.testOnly) {
        // XXX
        throw { code: 200, testOnly: true };
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
      return { code: 200, data: { fee: fee, tradeid: tradeID }, repush: true };
    }).catch(err => {
      return (conn ? conn.rollback() : Promise.resolve()).then(() => {
        // XXX i don’t know why exactly but this can’t possibly work
        if (err.code === 200) {
          return err; // for testOnly runs
        } else {
          throw err; // re-throw
        }
      });
    });
  }
}

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

/** */
class ListOwnDepot extends api.Requestable {
  constructor() {
    super({
      url: '/depot',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      description: 'List all stocks of the requesting user.',
    });
  }
  
  handle(query, ctx) {
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
      return { code: 200, data: results };
    });
  }
}

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

class ListTransactions extends api.Requestable {
  constructor() {
    super({
      url: '/transactions',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      description: 'List all transactions involving the requesting user (all payments)',
      notes: 'This enhances transparency of a user’s financial assets by giving ' +
        'detailed information on time, amount and reason of payments.'
    });
  }
  
  handle(query, ctx) {
    return ctx.query('SELECT t.*, a.name AS aname, p.name AS pname, s.name AS stockname FROM transactionlog AS t ' +
      'LEFT JOIN users AS a ON a.uid = t.a_user ' +
      'LEFT JOIN users AS p ON p.uid = t.p_user ' +
      'LEFT JOIN stocks AS s ON s.stocktextid = t.stocktextid ' +
      'WHERE t.a_user = ? OR t.p_user = ? ', [ctx.user.uid, ctx.user.uid]).then(results => {
      for (let i = 0; i < results.length; ++i) {
        results[i].json = results[i].json ? JSON.parse(results[i].json) : {};
      }

      return { code: 200, data: results  };
    });
  }
}

class TradeInfo extends api.Requestable {
  constructor() {
    super({
      url: '/trade/:tradeid',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'not-found' },
        { code: 403, identifier: 'delayed-history' }
      ],
      schema: {
        type: 'object',
        properties: {
          tradeid: {
            type: 'integer'
          }
        },
        required: ['tradeid']
      },
      description: 'Lists info for a specific trade.'
    });
  }
  
  handle(query, ctx, cfg) {
    const tradeid = query.tradeid;
    
    let r;
    return ctx.query('SELECT oh.* ,s.*, u.name, events.eventid AS eventid, trader.delayorderhist FROM orderhistory AS oh ' +
        'LEFT JOIN stocks AS s ON s.leader = oh.leader ' +
        'LEFT JOIN events ON events.type = "trade" AND events.targetid = oh.orderid ' +
        'LEFT JOIN users AS u ON u.uid = oh.leader ' +
        'LEFT JOIN users AS trader ON trader.uid = oh.uid WHERE oh.orderid = ?', [tradeid])
        .then(oh_res => {
      if (oh_res.length === 0) {
        throw new this.ClientError('info-notfound');
      }
      
      r = oh_res[0];
      
      if (r.uid !== ctx.user.uid &&
          !!r.delayorderhist &&
          (Date.now()/1000 - r.buytime < cfg.delayOrderHistTime) &&
          !ctx.access.has('stocks')) {
        throw new this.ClientError('delayed-history');
      }
      
      assert.equal(r.uid, parseInt(r.uid));
      
      return { code: 200, data: r };
    });
  }
}

class PopularStocks extends api.Requestable {
  constructor() {
    super({
      url: '/stocks/popular',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      schema: {
        type: 'object',
        properties: {
          days: {
            type: 'integer',
            description: 'A number of days specifying how long into the past ' +
              'the popular stocks list should reach.'
          }
        }
      },    
      description: 'Lists the most popular stocks.',
      notes: 'These are ordered according to a weighted average of the money amounts ' +
        'involved in the relevant trades, specifically:\n' +
        '\n' +
        ' * No trades older than 3 weeks are taken into consideration\n' +
        ' * Each trade’s value is added to its stock according to:' +
        '   <math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">' +
        '     <mfrac>' +
        '       <mrow>| money involved in trade |</mrow>' +
        '       <mrow>| time difference now - trade time in seconds + 300 |</mrow>' +
        '     </mfrac>' +
        '   </math>'
    });
  }
  
  handle(query, ctx, cfg) {
    let days = parseInt(query.days);
    
    if (days !== days || (days > cfg.popularStocksDays && !ctx.access.has('stocks'))) {
      days = cfg.popularStocksDays;
    }
    
    return ctx.query('SELECT oh.stocktextid, oh.stockname, ' +
      'SUM(ABS(money)) AS moneysum, ' +
      'SUM(ABS(money) / (UNIX_TIMESTAMP() - buytime + 300)) AS wsum ' +
      'FROM orderhistory AS oh ' +
      'WHERE buytime > UNIX_TIMESTAMP() - 86400 * ? ' +
      'GROUP BY stocktextid ORDER BY wsum DESC LIMIT 20', [days])
    .then(popular => {
      return { code: 200, data: popular };
    });
  }
}

class SellAllStocks extends api.Component {
  constructor() {
    super({
      identifier: 'SellAllStocks',
      description: 'Sells all shares held by a given user.',
      depends: [StockTrade]
    });
  }
  
  handle(query, ctx) {
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
        
        return this.load(StockTrade).handle({
          amount: -depotentry.amount,
          leader: ctx.user.uid,
        }, newCtx, {
          forceNow: true
        });
      }));
    });
  }
}

exports.components = [
  StocksRegularTasks,
  StockSearch,
  SellAllStocks,
  StockTrade,
  ListOwnDepot,
  ListTransactions,
  TradeInfo,
  PopularStocks
];
