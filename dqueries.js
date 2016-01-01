"use strict";

const _ = require('lodash');
const assert = require('assert');
const qctx = require('./qctx.js');
const Access = require('./access.js').Access;
const buscomponent = require('./stbuscomponent.js');
const debug = require('debug')('sotrade:dqueries');

/**
 * Provides infrastructure for delaying queries until certain conditions are met.
 * @public
 * @module dqueries
 */

/**
 * Main object of the {@link module:dqueries} module
 * 
 * @property {object} queries  A local copy of the delayed queries table.
 * @property {object} neededStocks  A stock id -> list of delayed queries map; The latter
 *                                  will be informed about updates on the stock data.
 * @property {string[]} queryTypes  A list of {@link c2s} query types which may be delayed.
 * 
 * @public
 * @constructor module:dqueries~DelayedQueries
 * @augments module:stbuscomponent~STBusComponent
 */
class DelayedQueries extends buscomponent.BusComponent {
  constructor() {
    super();
    
    this.queries = {};
    
    this.neededStocks = {};
    this.queryTypes = ['stock-buy', 'dquery-remove', 'ping'];
  }
}

DelayedQueries.prototype.onBusConnect = function() {
  const ctx = new qctx.QContext({parentComponent: this});
  
  this.on('stock-update', ev => {
    if (this.neededStocks['s-'+ev.stockid]) {
      _.each(this.neededStocks['s-'+ev.stockid], entryid => {
        return this.checkAndExecute(ctx, this.queries[entryid]);
      });
    }
  });
  
  return this.loadDelayedQueries();
};

/**
 * Return all stocks which the delayed queries database needs as a string array.
 * 
 * @function busreq~neededStocksDQ
 */
DelayedQueries.prototype.getNeededStocks = buscomponent.provide('neededStocksDQ', [], function() {
  return Object.keys(this.neededStocks).map(stocktextid => {
    return stocktextid.substr(2); // strip s- prefix
  });
});

/**
 * Checks the preconditions for a singled delayed query and,
 * if they are met, executes it.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {Query} query  The delayed query to be checked.
 * 
 * @function module:dqueries~DelayedQueries#checkAndExecute
 */
DelayedQueries.prototype.checkAndExecute = function(ctx, query) {
  if (ctx.getProperty('readonly')) {
    return;
  }
  
  return query.check(ctx).then(condmatch => {
    if (condmatch) {
      return this.executeQuery(query);
    }
  });
};

/**
 * Load all delayed queries from the database and populate the
 * local structures with the data.
 * 
 * @function module:dqueries~DelayedQueries#loadDelayedQueries
 */
DelayedQueries.prototype.loadDelayedQueries = function() {
  debug('Load delayed queries');
  
  const ctx = new qctx.QContext({parentComponent: this});
  
  return ctx.query('SELECT * FROM dqueries').then(r => {
    return Promise.all(r.map(res => {
      res.query = JSON.parse(res.query);
      res.userinfo = JSON.parse(res.userinfo);
      res.accessinfo = Access.fromJSON(res.accessinfo);
      
      return this.addQuery(ctx, res);
    }));
  });
};

/**
 * List all delayed queries for the current user.
 * 
 * @return {object}  Returns with <code>dquery-list-success</code> and sets
 *                   <code>.results</code> accordingly to a list of delayed queries.
 * 
 * @function c2s~dquery-list
 */
DelayedQueries.prototype.listDelayQueries = buscomponent.provideQT('client-dquery-list', function(query, ctx) {
  return { code: 'dquery-list-success', 
    results: _.chain(this.queries).values()
      .filter(q => (q.userinfo.uid === ctx.user.uid))
      .map(q => _.omit(q, 'userinfo', 'accessinfo'))
      .value()
  };
});

/**
 * Delete a delayed request of the current user.
 * 
 * @param {int} query.queryid  The delayed query’s numerical id.
 * 
 * @return {object}  Returns with <code>dquery-remove-success</code> or
 *                   <code>dquery-remove-notfound</code>.
 * 
 * @function c2s~dquery-remove
 */
DelayedQueries.prototype.removeQueryUser = buscomponent.provideWQT('client-dquery-remove', function(query, ctx) {
  const queryid = query.queryid;
  
  debug('Remove dquery', queryid);
  
  if (this.queries[queryid] && this.queries[queryid].userinfo.uid === ctx.user.uid) {
    return this.removeQuery(this.queries[queryid], ctx).then(() => {
      return { code: 'dquery-remove-success' };
    });
  } else {
    throw new this.SoTradeClientError('dquery-remove-notfound');
  }
});

/**
 * Add a delayed request by the current user.
 * 
 * @param {int} query.query  The query which is to be delayed
 * @param {string} query.query.retainUntilCode  If set, retain the query in the delayed 
 *                                              queries database until the return code
 *                                              matches this string.
 * @param {string} query.condition  The conditions under which the query
 *                                  will be executed. See
 *                                  {@link module:dqueries~DelayedQueries#parseCondition}.
 * 
 * @return {object}  Returns with <code>dquery-success</code> or a common error code.
 * 
 * @function c2s~dquery
 */
DelayedQueries.prototype.addDelayedQuery = buscomponent.provideWQT('client-dquery', function(query, ctx) {
  debug('Add dquery', query.condition);
  
  let qstr = null;
  this.parseCondition(query.condition);
  
  try {
    qstr = JSON.stringify(query.query);
  } catch (e) {
    this.emitError(e);
    throw new this.FormatError();
  }
  
  if (this.queryTypes.indexOf(query.query.type) === -1) {
    throw new this.SoTradeClientError('unknown-query-type');
  }
  
  const userinfo = _.clone(ctx.user);
  assert.ok(!userinfo.pwsalt);
  assert.ok(!userinfo.pwhash);
  delete userinfo.clientopt;
  delete userinfo.clientstorage;
  
  return ctx.query('INSERT INTO dqueries (`condition`, query, userinfo, accessinfo) VALUES(?,?,?,?)',
    [String(query.condition), qstr, JSON.stringify(userinfo), ctx.access.toJSON()]).then(r => {
    query.queryid = r.insertId;
    query.userinfo = ctx.user;
    query.accessinfo = ctx.access;
    
    return this.addQuery(ctx, query);
  }).then(() => {
    return { code: 'dquery-success', 'queryid': query.queryid };
  });
});

/**
 * Check all delayed queries for being executable.
 * 
 * @return  Returns with <code>dquery-checkall-success</code> or
 *          <code>permission-denied</code>.
 * @function c2s~dquery-checkall
 */
DelayedQueries.prototype.checkAllDQueries = buscomponent.provideWQT('client-dquery-checkall', function(query, ctx) {
  debug('Check all dqueries');
  
  if (!ctx.access.has('dqueries')) {
    throw new this.PermissionDenied();
  }
  
  return Promise.all(_.chain(this.queries).values().map(q => {
    return this.checkAndExecute(ctx, q);
  }).value()).then(() => {
    return { code: 'dquery-checkall-success' };
  });
});

/**
 * Load a delayed query into the local delayed queries list.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {object} query  The delayed query database entry.
 * 
 * @function module:dqueries~DelayedQueries#addQuery
 */
DelayedQueries.prototype.addQuery = function(ctx, query) {
  assert.ok(query);

  const cond = this.parseCondition(query.condition);
  
  query.check = cond.check;
  query.neededStocks = cond.neededStocks;
  
  const entryid = String(query.queryid);
  assert.ok(!this.queries[entryid]);
  this.queries[entryid] = query;
  query.neededStocks.forEach(stocktextid => this.addNeededStock(query.queryid, stocktextid));
  return this.checkAndExecute(ctx, query);
};

/**
 * Indicate that a delayed query requires information on a certain stock.
 * 
 * @param {int} queryid  The numerical delayed query id.
 * @param {string} stocktextid  The stock’s id (ISIN/etc.).
 * 
 * @function module:dqueries~DelayedQueries#addQuery
 */
DelayedQueries.prototype.addNeededStock = function(queryid, stocktextid) {
  if (this.neededStocks['s-'+stocktextid]) {
    assert.equal(this.neededStocks['s-'+stocktextid].indexOf(queryid), -1);
    this.neededStocks['s-'+stocktextid].push(queryid);
  } else {
    this.neededStocks['s-'+stocktextid] = [queryid];
  }
};

/**
 * Parse a delayed query condition string.
 * 
 * Currently, such a string can consist of various clauses
 * joined by <code>'∧'</code> (logical and), each of which
 * are comparisons using &lt; or &gt; of certain variables.
 * 
 * @example
 * stock::US90184L1026::exchange-open > 0 ∧ stock::US90184L1026::bid > 331000
 * @example
 * stock::US90184L1026::exchange-open > 0
 * @example
 * time > 1416085723 ∧ time < 1416095723
 * 
 * @param {string} str  The condition string to be checked
 * 
 * @return {object}  Returns an object where <code>.check(ctx)</code>
 *                   is a callback for checking whether the condition is currently met
 *                   (returning a Promise)
 *                   and where <code>.neededStocks</code> is a list of stock ids
 *                   required to have accurate database information for checking.
 * 
 * @function module:dqueries~DelayedQueries#parseCondition
 */
DelayedQueries.prototype.parseCondition = function(str) {
  const clauses = str.split('∧');
  const cchecks = [];
  const stocks = [];
  clauses.forEach(cl => {
    cl = cl.trim();
    const terms = cl.split(/[<>]/);
    if (terms.length !== 2) {
      throw new this.FormatError('condition clause must contain exactly one < or > expression');
    }
    
    const lt = cl.indexOf('<') !== -1;
    const lhs = terms[0].trim();
    const rhs = terms[1].trim();
    const variable = lhs.split(/::/);
    const value = parseFloat(rhs);
    switch (variable[0]) {
      case 'time':
        cchecks.push(() => {
          const t = Date.now()/1000;
          return lt ? t < value : t > value;
        });
        break;
      case 'stock':
        if (variable.length !== 3) {
          throw new this.FormatError('expecting level 3 nesting for stock variable');
        }
        
        const stocktextid = String(variable[1]);
        const fieldname = variable[2];
        if (stocks.indexOf(stocktextid) === -1) {
          stocks.push(stocktextid);
        }
        
        switch(fieldname) {
          case 'exchange-open':
            cchecks.push(ctx => {
              return ctx.query('SELECT exchange FROM stocks WHERE stocktextid = ?', [stocktextid]).then(r => {
                if (r.length === 0) {
                  return false;
                }
                
                return this.getServerConfig().then(cfg => {
                  assert.ok(cfg);
                  
                  return this.request({name: 'stockExchangeIsOpen', sxname: r[0].exchange, cfg: cfg});
                }).then(isOpen => {
                  return lt ? isOpen < value : isOpen > value;
                });
              });
            });
            break;
          default:
            if (!/^[A-Za-z0-9_]+$/.test(fieldname)) {
              throw new this.FormatError('bad fieldname');
            }
            
            cchecks.push(ctx => {
              return ctx.query('SELECT ' + fieldname + ' FROM stocks WHERE stocktextid = ?',
                [String(stocktextid)]).then(r => {
                return r.length > 0 && (lt ? r[0][fieldname] < value : r[0][fieldname] > value);
              });
            });
            break;
        }
        break;
      default:
        throw new this.FormatError('unknown variable type');
    }
  });
  
  return {
    check: ctx => {
      return Promise.all(cchecks.map(check => check(ctx)))
        .then(allCheckResults => allCheckResults.reduce((a, b) => a && b));
    },
    neededStocks: stocks
  };
};

/**
 * Informs users of delayed queries having been executed.
 * 
 * This event incorporates all fields from the delayed queries
 * info set by the originating user.
 * 
 * @typedef s2c~dquery~exec
 * @type {Event}
 */

/**
 * Execute a delayed query and, if appropiate, removes it from the list.
 * 
 * @param {object} query  The delayed query.
 * 
 * @function module:dqueries~DelayedQueries#executeQuery
 */
DelayedQueries.prototype.executeQuery = function(query) {
  debug('Execute dquery', query.queryid);
  
  const ctx = new qctx.QContext({user: query.userinfo, access: query.accessinfo, parentComponent: this});
  query.query._isDelayed = true;
  
  if (query.executionPromise) {
    return query.executionPromise;
  }
  
  assert.strictEqual(this.queries[query.queryid], query);
  
  return query.executionPromise = this.request({
    name: 'client-' + query.query.type,
    query: query.query,
    ctx: ctx
  }).catch(e => {
    if (typeof e.toJSON !== 'function') {
      throw e;
    }
    
    return e.toJSON();
  }).then(result => {
    debug('Executed dquery', query.queryid, result.code);
    const json = query.query.dquerydata || {};
    json.result = result.code;
    
    if (!query.query.retainUntilCode || query.query.retainUntilCode === result.code) {
      return ctx.feed({
        'type': 'dquery-exec',
        'targetid': null,
        'srcuser': query.userinfo.uid,
        'json': json,
        'noFollowers': true
      }).then(() => this.removeQuery(query, ctx));
    } else {
      delete query.executionPromise;
    }
  });
};

/**
 * Removes a delayed query from the local structures and the database.
 * 
 * @param {object} query  The delayed query.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function module:dqueries~DelayedQueries#removeQuery
 */
DelayedQueries.prototype.removeQuery = function(query, ctx) {
  return ctx.query('DELETE FROM dqueries WHERE queryid = ?', [parseInt(query.queryid)]).then(() => {
    delete this.queries[query.queryid];
    query.neededStocks.forEach(stock => {
      this.neededStocks['s-'+stock] = _.without(this.neededStocks['s-'+stock], query.queryid);
      
      if (this.neededStocks['s-'+stock].length === 0) {
        delete this.neededStocks['s-'+stock];
      }
    });
  });
};

/**
 * Removes a delayed query from the local structures and the database.
 * 
 * @param {object} query  The delayed query.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function module:dqueries~DelayedQueries#removeQuery
 */
DelayedQueries.prototype.resetUser = buscomponent.provide('dqueriesResetUser', ['ctx'], function(ctx) {
  const toBeDeleted = [];
  for (let queryid in this.queries) {
    const q = this.queries[queryid];
    
    if (q.userinfo.uid === ctx.user.uid || (q.query.leader === ctx.user.uid)) {
      toBeDeleted.push(q);
    }
  }
  
  for (let i = 0; i < toBeDeleted.length; ++i) {
    this.removeQuery(toBeDeleted[i], ctx);
  }
});

exports.DelayedQueries = DelayedQueries;
