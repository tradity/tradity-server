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
const qctx = require('./qctx.js');
const Access = require('./access.js').Access;
const api = require('./api.js');
const sha256 = require('./lib/sha256.js');
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
 * @property {string[]} allowedQueryTypes  A list of query types which may be delayed.
 * 
 * @public
 */
class DelayedQueries extends api.Component {
  constructor() {
    const allowedQueryTypes = ['StockTrade', 'Ping'];
    
    super({
      identifier: 'DelayedQueries',
      depends: ['StockExchangeIsOpen', 'ReadonlyStore'].concat(allowedQueryTypes)
    });
    
    this.queries = {}; // XXX make this a map
    
    this.neededStocks = {}; // XXX make this a map
    this.allowedQueryTypes = allowedQueryTypes;
    this.enabled = false;
  }
  
  init() {
    const ctx = new qctx.QContext({parentComponent: this});
    
    return Promise.all([
      this.load('PubSub').on('stock-update', ev => {
        if (this.enabled && this.neededStocks['s-'+ev.stockid]) {
          _.each(this.neededStocks['s-'+ev.stockid], entryid => {
            return this.checkAndExecute(ctx, this.queries[entryid]);
          });
        }
      }),
      this.load('PubSub').on('DelayedQueryAdd:resetUser', query => {
        if (this.enabled) {
          return this.resetUser(query.uid, ctx);
        }
      })
    ]);
  }
  
  enable() {
    this.enabled = true;
    return this.loadDelayedQueries();
  }

  /**
   * Return all stocks which the delayed queries database needs as a string array.
   */
  getNeededStocks() {
    return Object.keys(this.neededStocks).map(stocktextid => {
      return stocktextid.substr(2); // strip s- prefix
    });
  }

  /**
   * Checks the preconditions for a singled delayed query and,
   * if they are met, executes it.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * @param {Query} query  The delayed query to be checked.
   */
  checkAndExecute(ctx, query) {
    if (this.load('ReadonlyStore').readonly) {
      return;
    }
    
    return query.check(ctx).then(condmatch => {
      assert.equal(typeof condmatch, 'boolean');
      
      if (condmatch) {
        return this.executeQuery(query);
      }
    });
  }

  /**
   * Load all delayed queries from the database and populate the
   * local structures with the data.
   */
  loadDelayedQueries() {
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
  }

  /**
   * Load a delayed query into the local delayed queries list.
   * 
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * @param {object} query  The delayed query database entry.
   */
  addQuery(ctx, query) {
    assert.ok(query);
    
    // create writable copy for us
    query.query = Object.assign({}, query.query);
    
    // XXX backwards compatibility
    // can be removed after next reset
    if (query.query.type === 'stock-buy') {
      query.query.type = 'StockTrade';
      query.retainUntilCode = 'success';
    } else if (query.query.type === 'ping') {
      query.query.type = 'Ping';
      query.retainUntilCode = 'success';
    }

    const cond = this.parseCondition(query.condition);
    
    query.check = cond.check;
    query.neededStocks = cond.neededStocks;
    
    const entryid = String(query.queryid);
    assert.ok(!this.queries[entryid]);
    this.queries[entryid] = query;
    query.neededStocks.forEach(stocktextid => this.addNeededStock(query.queryid, stocktextid));
    return this.checkAndExecute(ctx, query);
  }

  /**
   * Indicate that a delayed query requires information on a certain stock.
   * 
   * @param {int} queryid  The numerical delayed query id.
   * @param {string} stocktextid  The stock’s id (ISIN/etc.).
   */
  addNeededStock(queryid, stocktextid) {
    if (this.neededStocks['s-'+stocktextid]) {
      assert.equal(this.neededStocks['s-'+stocktextid].indexOf(queryid), -1);
      this.neededStocks['s-'+stocktextid].push(queryid);
    } else {
      this.neededStocks['s-'+stocktextid] = [queryid];
    }
  }

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
   */
  parseCondition(str) {
    const clauses = str.split('∧');
    const cchecks = [];
    const stocks = [];
    clauses.forEach(cl => {
      cl = cl.trim();
      const terms = cl.split(/[<>]/);
      if (terms.length !== 2) {
        throw new RangeError('condition clause must contain exactly one < or > expression');
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
            throw new RangeError('expecting level 3 nesting for stock variable');
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
                  
                  const cfg = this.load('Config').config();
                  const isOpen = this.load('StockExchangeIsOpen').test(r[0].exchange, cfg);
                  
                  return lt ? isOpen < value : isOpen > value;
                });
              });
              break;
            default:
              if (!/^[A-Za-z0-9_]+$/.test(fieldname)) {
                throw new RangeError('bad fieldname');
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
          throw new RangeError('unknown variable type');
      }
    });
    
    return {
      check: ctx => {
        return Promise.all(cchecks.map(check => check(ctx)))
          .then(allCheckResults => allCheckResults.reduce((a, b) => a && b));
      },
      neededStocks: stocks
    };
  }

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
   */
  executeQuery(query) {
    debug('Execute dquery', query.queryid);
    
    const ctx = new qctx.QContext({user: query.userinfo, access: query.accessinfo, parentComponent: this});
    query.query._isDelayed = true;
    
    if (query.executionPromise) {
      return query.executionPromise;
    }
    
    assert.strictEqual(this.queries[query.queryid], query);
    
    const cfg = this.load('Config').config();
    
    return query.executionPromise = Promise.resolve().then(() => {
      return this.load(query.query.type).handle(query.query, ctx, cfg);
    }).catch(err => {
      // this duplicates some logic from api.Requestable
      // XXX should be considered when refactoring over there
      if (typeof err.code === 'number') {
        return err;
      }
      
      throw err;
    }).then(result => {
      debug('Executed dquery', query.queryid, result.code);
      const json = query.query.dquerydata || {};
      json.result = result.code;
      
      if (!query.query.retainUntilCode ||
          query.query.retainUntilCode === result.code ||
          (query.query.retainUntilCode === 'success' &&
            result.code >= 200 && result.code <= 299))
      {
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
  }

  /**
   * Removes a delayed query from the local structures and the database.
   * 
   * @param {object} query  The delayed query.
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * 
   * @function module:dqueries~DelayedQueries#removeQuery
   */
  removeQuery(query, ctx) {
    return ctx.query('DELETE FROM dqueries WHERE queryid = ?', [parseInt(query.queryid)]).then(() => {
      delete this.queries[query.queryid];
      query.neededStocks.forEach(stock => {
        this.neededStocks['s-'+stock] = _.without(this.neededStocks['s-'+stock], query.queryid);
        
        if (this.neededStocks['s-'+stock].length === 0) {
          delete this.neededStocks['s-'+stock];
        }
      });
    });
  }

  /**
   * Removes a delayed query from the local structures and the database.
   * 
   * @param {object} query  The delayed query.
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   */
  resetUser(uid, ctx) {
    const toBeDeleted = [];
    for (let queryid in this.queries) {
      const q = this.queries[queryid];
      
      if (q.userinfo.uid === uid || (q.query.leader === uid)) {
        toBeDeleted.push(q);
      }
    }
    
    for (let i = 0; i < toBeDeleted.length; ++i) {
      this.removeQuery(toBeDeleted[i], ctx);
    }
  }
}

class DelayedQueryRemoteRequestable extends api.Requestable {
  constructor(options) {
    super(options);
    
    const os = require('os');
    this._internalID = sha256(JSON.stringify([options.url, options.methods]));
    this._localNodeID = sha256(JSON.stringify([
      os.hostname(), os.networkInterfaces(),
      Math.random(), Date.now(),
      this._internalID
    ]));
    this._queryCounter = 0;
  }
  
  init() {
    const ctx = new qctx.QContext({parentComponent: this});
    const pubsub = this.load('PubSub');
    
    pubsub.on(this._internalID + ':handle:DQ', data => {
      if (!this.load(DelayedQueries).enabled) {
        return;
      }
        
      const ctx = new qctx.QContext({
        parentComponent: this,
        user: data.user,
        access: Access.fromJSON(data.access)
      });
      
      const query = data.query;
      return this.handle(query, ctx).then(result => {
        pubsub.publish(data.queryid, { result: result });
      }, err => {
        pubsub.publish(data.queryid, { error: err });
      });
    });
  }
  
  handle(query, ctx) {
    const db = this.load(DelayedQueries);
    if (db.enabled) {
      return this.handleDQ(query, ctx);
    } else {
      const pubsub = this.load('PubSub');
      const id = this._localNodeID + '@' + (this._queryCounter++);
      
      return new Promise((resolve, reject) => {
        pubsub.publish(this._internalID + ':handle:DQ', {
          query: query,
          user: JSON.parse(JSON.stringify(ctx.user)),
          access: ctx.access.toJSON(),
          queryid: id
        });
        
        resolve(pubsub.once(id).then(resultWrap => {
          if (resultWrap.error) {
            throw resultWrap.error;
          } else {
            return resultWrap.result;
          }
        }));
      });
    }
  }
}

class DelayedQueryList extends DelayedQueryRemoteRequestable {
  constructor() {
    super({
      url: '/dqueries',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      description: 'List all delayed queries for the current user.',
      depends: [DelayedQueries]
    });
  }
  
  handleDQ(query, ctx) {
    return {
      code: 200, 
      data: _.chain(this.load(DelayedQueries).queries).values()
        .filter(q => (q.userinfo.uid === ctx.user.uid))
        .map(q => _.omit(q, 'userinfo', 'accessinfo'))
        .value()
    };
  }
}

class DelayedQueryDelete extends DelayedQueryRemoteRequestable {
  constructor() {
    super({
      url: '/dqueries/:queryid',
      identifier: 'DelayedQueryDelete',
      methods: ['DELETE'],
      returns: [
        { code: 204 },
        { code: 404, identifier: 'not-found' }
      ],
      writing: true,
      schema: {
        type: 'object',
        properties: {
          queryid: {
            type: 'integer',
            description: 'The delayed query’s numerical id.'
          }
        },
        required: ['queryid']
      },
      description: 'Delete a delayed request of the current user.',
      depends: [DelayedQueries]
    });
  }
  
  handleDQ(query, ctx) {
    const db = this.load(DelayedQueries);
    const queryid = query.queryid;
    
    debug('Remove dquery', queryid);
    
    if (db.queries[queryid] && db.queries[queryid].userinfo.uid === ctx.user.uid) {
      return db.removeQuery(db.queries[queryid], ctx).then(() => {
        return { code: 204 };
      });
    } else {
      throw new this.ClientError('not-found');
    }
  }
}

class DelayedQueryAdd extends DelayedQueryRemoteRequestable {
  constructor() {
    super({
      identifier: 'DelayedQueryAdd',
      url: '/dqueries',
      methods: ['POST'],
      writing: true,
      returns: [
        { code: 200 },
        { code: 403, identifier: 'unknown-query-type' }
      ],
      schema: {
        type: 'object',
        properties: {
          query: {
            type: 'object',
            description: 'The query which is to be delayed',
            properties: {
              type: {
                type: 'string'
              }
            }
          },
          condition: {
            type: 'string',
            description: 'The conditions under which the query will be executed'
          }
        },
        required: ['query', 'condition']
      },
      description: 'Add a delayed request by the current user.',
      depends: [DelayedQueries]
    });
  }
  
  init() {
    return Promise.resolve(super.init()).then(() => {
      const ctx = new qctx.QContext({parentComponent: this});
      
      return this.load('PubSub').on('DelayedQueryAdd:handle', query => {
        if (this.load(DelayedQueries).enabled) {
          return this.handle(query, ctx);
        }
      });
    });
  }
  
  handleDQ(query, ctx) {
    debug('Add dquery', query.condition);
    const db = this.load(DelayedQueries);
    
    let qstr = null;
    db.parseCondition(query.condition);
    
    try {
      qstr = JSON.stringify(query.query);
    } catch (e) {
      throw new this.BadRequest(e);
    }
    
    if (db.allowedQueryTypes.indexOf(query.query.type) === -1) {
      throw new this.ClientError('unknown-query-type');
    }
    
    const userinfo = _.clone(ctx.user);
    assert.ok(!userinfo.pwsalt);
    assert.ok(!userinfo.pwhash);
    delete userinfo.clientopt;
    delete userinfo.clientstorage;
    
    return ctx.query('INSERT INTO dqueries (`condition`, query, userinfo, accessinfo) VALUES(?,?,?,?)',
      [String(query.condition), qstr, JSON.stringify(userinfo), ctx.access.toJSON()]).then(r => {
      const newQuery = Object.assign({
        queryid: r.insertId,
        userinfo: ctx.user,
        accessinfo: ctx.access
      }, query);
      
      return db.addQuery(ctx, newQuery).then(() => newQuery.queryid);
    }).then(queryid => {
      return { code: 200, queryid: queryid };
    });
  }
}

class DelayedQueryCheckAll extends DelayedQueryRemoteRequestable {
  constructor() {
    super({
      url: '/dqueries/check-all',
      methods: ['POST'],
      writing: true,
      returns: [
        { code: 204 },
      ],
      requiredAccess: 'dqueries',
      description: 'Check all delayed queries for being executable.',
      depends: [DelayedQueries]
    });
  }
  
  handleDQ(query, ctx) {
    debug('Check all dqueries');
    
    if (!ctx.access.has('dqueries')) {
      throw new this.Forbidden();
    }
    
    const db = this.load(DelayedQueries);
    
    return Promise.all(_.chain(db.queries).values().map(q => {
      return db.checkAndExecute(ctx, q);
    }).value()).then(() => {
      return { code: 204 };
    });
  }
}

exports.components = [
  DelayedQueries,
  DelayedQueryAdd,
  DelayedQueryCheckAll,
  DelayedQueryDelete,
  DelayedQueryList
];
