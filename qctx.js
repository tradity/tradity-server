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

const Access = require('./access.js').Access;
const assert = require('assert');
const weak = require('weak');
const api = require('./api.js');
const _ = require('lodash');
const debug = require('debug')('sotrade:qctx');

/**
 * Provides the {@link module:qctx~QContext} object.
 * 
 * @public
 * @module qctx
 */

/**
 * Represents the context in which server code gets executed.
 * 
 * @property {?object} user  The current user’s object
 * @property {module:access~Access} access  The current privilege level
 * @property {object} properties  Various high-level properties
 * @property {function[]} debugHandlers  Debug functions to be called when debugging is enabled
 * @property {function[]} errorHandlers  Handlers in case of failures during code execution
 *                                       under this context.
 * @property {module:qctx~QContext[]} childContexts  A list of weak references to child QContexts
 *                                                   (e.g. for debugging resource usage)
 * @property {object[]} openConnections  A list of open database connections.
 * @property {object[]} tableLocks  A list of held table locks.
 * @property {int} queryCount  The number of executed single database queries.
 * @property {int} incompleteQueryCount  The number of not-yet-completed single database queries.
 * @property {string} creationStack  A stack trace of this query context’s construction call
 * @property {int} creationTime  Millisecond unix timestmap of this query context’s construc
 * 
 * @property {?object} startTransactionOnQuery  Indicates whether to start a transaction when a query
 *                                              is encountered (<code>null</code> if not, otherwise
 *                                              <code>{tables: …, options: …}</code>)
 * @property {?object} contextTransaction  A promise for a transaction to which all queries within
 *                                         this context will be appended
 * 
 * @public
 */
class QContext extends api.Component {
  constructor(obj) {
    super({
      anonymous: true,
      depends: ['FeedInserter']
    });
    
    obj = obj || {};
    this.user = obj.user || null;
    this.access = obj.access || new Access();
    this.properties = new Map();
    this.debugHandlers = [];
    this.errorHandlers = [];
    
    this.isQContext = true;
    this.childContexts = [];
    this.tableLocks = [];
    this.openConnections = [];
    this.queryCount = 0;
    this.incompleteQueryCount = 0;
    this.creationStack = getStack();
    this.creationTime = Date.now();
    this.startTransactionOnQuery = null;
    this.contextTransaction = null;
    
    if (obj.parentComponent) {
      this.initRegistryFromParent(obj.parentComponent);
    }
    
    const ondestroy = _ctx => {
      if (_ctx.tableLocks.length > 0 || _ctx.openConnections.length > 0) {
        console.warn('QUERY CONTEXT DESTROYED WITH OPEN CONNECTIONS/TABLE LOCKS');
        console.warn(JSON.stringify(_ctx));
        
        try {
          _ctx.emitError(new Error('Query context cannot be destroyed with held resources'));
        } catch (e) { console.log(e); }
        
        setTimeout(() => {
          process.exit(122);
        }, 1500);
      }
    };
  }

  /**
   * Call context-specific error handlers and pass on to
   * {@link module:buscomponent~BusComponent#emitError}.
   */
  emitError(e) {
    this.debug('Caught error', e);
    
    for (let i = 0; i < this.errorHandlers.length; ++i) {
      this.errorHandlers[i](e);
    }
    
    super.emitError(this, e);
  }

  /**
   * Return a copy of this QContext.
   * 
   * @return {module:qctx~QContext}  A shallow copy of this QContext.
   */
  clone() {
    const c = new QContext({
      user: this.user,
      access: this.access.clone(),
      parentComponent: this
    });
    
    c.properties = _.clone(this.properties);
    c.debugHandlers = this.debugHandlers.slice();
    c.errorHandlers = this.errorHandlers.slice();
    
    return c;
  }

  /**
   * Serialize this QContext into a raw JS object.
   * 
   * @return {object}  An object to be passed to {@link module:qctx~fromJSON}
   */
  toJSON() {
    return { user: this.user, access: this.access.toJSON(), properties: this.properties };
  };

  /**
   * Shorthand method for pushing feed entries.
   * See {@link busreq~feed}.
   * 
   * @return {object}  A Promise corresponding to successful completion
   */
  feed(data) {
    let conn = data.conn || this.contextTransaction || null;
    const onEventId = data.onEventId || (() => {});
    delete data.conn;
    delete data.onEventId;
    
    let release = null;
    
    // keep in mind that self.contextTransaction may be a promise or null
    // use Promise.resolve(…) to clarify that before all else
    return Promise.resolve(conn).then(conn_ => {
      // connection is there? -> set conn to the resolved promise
      if (conn_) {
        return conn = conn_;
      }
      
      return this.startTransaction().then(conn_ => {
        return conn = release = conn_;
      });
    }).then(() => {
      return this.load('FeedInserter').insert(data, this, conn, onEventId);
    }).then(retval => {
      // release is never a promise
      if (release) {
        return release.commit().then(() => retval);
      }
    }).catch(e => {
      if (release) {
        return release.rollbackAndThrow(e);
      }
      throw e;
    });
  }

  txwrap(fn) {
    const self = this;
    
    assert.ok(self.startTransactionOnQuery);
    assert.ok(!self.contextTransaction);
    
    return function() {
      return Promise.resolve(fn.apply(this, arguments)).then(v => {
        return self.commit().then(() => {
          self.contextTransaction = null;
          return v;
        });
      }).catch(err => {
        return self.rollback().then(() => {
          self.contextTransaction = null;
          throw err;
        });
      });
    };
  }

  enterTransactionOnQuery(tables, options) {
    assert.ok(!this.startTransactionOnQuery);
    assert.ok(!this.contextTransaction);
    
    this.startTransactionOnQuery = {tables: tables, options: options};
    
    return this;
  }

  commit() {
    const args = arguments;
    
    if (!this.contextTransaction) {
      return Promise.resolve();
    }
    
    return Promise.resolve(this.contextTransaction).then(conn => {
      return conn.commit.apply(this, args);
    });
  }

  rollback() {
    const args = arguments;
    
    if (!this.contextTransaction) {
      return Promise.resolve();
    }
    
    return Promise.resolve(this.contextTransaction).then(conn => {
      return conn.rollback.apply(this, args);
    });
  }

  rollbackAndThrow(e) {
    return this.rollback().then(() => {
      throw e;
    });
  }

  /**
   * Shorthand method for executing database queries.
   * See {@link busreq~dbQuery}.
   * 
   * @return {object}  A Promise corresponding to successful completion
   */
  query(query, args, readonly) {
    const queryArgs = arguments;
    const sToQ = this.startTransactionOnQuery;
    
    if (this.contextTransaction) {
      assert.ok(sToQ);
      
      return Promise.resolve(this.contextTransaction).then(function(conn) {
        return conn.query.apply(this, queryArgs);
      });
    }
    
    if (sToQ) {
      assert.ok(!this.contextTransaction);
      
      this.contextTransaction = this.startTransaction(sToQ.tables, sToQ.options);
      
      // equivalent to goto to the above case
      return this.query.apply(this, queryArgs);
    }
    
    this.debug('Executing query [unbound]', query, args);
    this.incompleteQueryCount++;
    
    return this.load('Database').query(query, args, readonly).then(data => {
      this.incompleteQueryCount--;
      this.queryCount++;
      
      return data;
    });
  }

  /**
   * Shorthand method for fetching a single connection for database queries.
   * Mostly, see {@link busreq~dbGetConnection}.
   * 
   * @param {boolean} readonly  Whether the connection requires no write access.
   * @param {function} restart  Callback that will be invoked when the current transaction
   *                            needs restarting.
   * 
   * @return {object}  A Promise corresponding to successful completion
   *          (with an Object with `conn`, `commit` and `rollback` entries)
   */
  getConnection(readonly, restart) {
    const oci = this.openConnections.push([{readonly: readonly, time: Date.now(), stack: getStack()}]) - 1;
    let conn;
    
    const postTransaction = doRelease => {
      delete this.openConnections[oci];
      if (_.compact(this.openConnections).length === 0) {
        this.openConnections = [];
      }
      
      if (typeof doRelease === 'undefined') {
        doRelease = true;
      }
      
      if (doRelease) {
        return conn.release();
      }
    };
    
    const oldrestart = restart;
    restart = () => {
      return Promise.resolve(postTransaction()).then(oldrestart);
    };
    
    return this.load('Database').getConnection(readonly, restart).then(conn_ => {
      conn = conn_;
      assert.ok(conn);
      
      /* return wrapper object for better debugging, no semantic change */
      conn_ = {
        release: () => conn.release(),
        query: (query, args) => {
          this.debug('Executing query [bound]', query, args);
          return conn.query(query, args);
        },
        
        /* convenience functions for rollback and commit with implicit release */
        commit: doRelease => {
          return conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;').then(() => {
            return postTransaction(doRelease);
          });
        },
        rollback: doRelease => {
          return conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1;').then(() => {
            return postTransaction(doRelease);
          });
        }
      };
      
      return conn_;
    }); 
  }

  /**
   * Fetch a single connection and prepare a transaction on it,
   * optionally locking tables.
   * 
   * @param {object} [tablelocks={}]  An map of <code>table-name -> 'r' or 'w'</code> indicating 
   *                                  which tables to lock. The dictionary values can also be
   *                                  objects with the properties <code>mode, alias</code>,
   *                                  or you can use an array with a <code>name</code> property.
   * @param {object} [options={}]  Options for this transaction:
   * @param {boolean} [options.readonly=false]  Whether the transaction requires no write access.
   * @param {function} [options.restart=true]  A callback that will be invoked when the transaction needs
   *                                           restarting, e.g. in case of database deadlocks. Use
   *                                           <code>true</code> to just rollback and call the
   *                                           startTransaction callback again.
   * @param {string} [options.isolationLevel='READ COMMITTED']  The transaction isolation level for
   *                                                            this transaction.
   * 
   * @return {object}  A Promise corresponding to successful completion, including
   *          .commit() and .rollback() shortcuts (both releasing the connection).
   */
  startTransaction(tablelocks, options) {
    const args = arguments;
    
    options = options || {};
    tablelocks = tablelocks || {};
    
    const readonly = !!options.readonly;
    
    let tli = null;
    let notifyTimer = null;
    
    if (tablelocks) {
      tli = this.tableLocks.push([{locks: tablelocks, time: Date.now(), stack: getStack()}]) - 1;
    }
    
    debug('Starting transaction', tli);
    const cleanTLEntry = () => {
      debug('Ended transaction', tli);
      
      if (tli === null) {
        return;
      }
      
      if (notifyTimer) {
        clearTimeout(notifyTimer);
      }
      
      notifyTimer = null;
      delete this.tableLocks[tli];
      if (_.compact(this.tableLocks).length === 0) {
        this.tableLocks = [];
      }
      
      tli = null;
    };
    
    let conn;
    const oldrestart = options.restart || (() => {
      (conn ? conn.rollback() : Promise.resolve()).then(() => {
        this.startTransaction.apply(this, args);
      });
    });
    
    const restart = () => {
      cleanTLEntry();
      return oldrestart.apply(this, arguments);
    };
    
    return this.getConnection(readonly, restart).then(conn_ => {
      conn = conn_;
      
      const oldCommit = conn.commit, oldRollback = conn.rollback;
      conn.commit = v => {
        cleanTLEntry();
        return Promise.resolve(oldCommit.call(conn, true)).then(() => v);
      };
      
      conn.commitWithoutRelease = v => {
        cleanTLEntry();
        return Promise.resolve(oldCommit.call(conn, false)).then(() => v);
      };
      
      conn.rollback = () => {
        cleanTLEntry();
        return oldRollback.apply(conn, arguments);
      };
      
      conn.rollbackAndThrow = e => {
        return conn.rollback().then(() => {
          throw e;
        });
      };
      
      const tables = Object.keys(tablelocks);
      let init = 'SET autocommit = 0; ';
      
      init += 'SET TRANSACTION ISOLATION LEVEL ' + ({
        'RU': 'READ UNCOMMITTED',
        'RC': 'READ COMMITTED',
        'RR': 'REPEATABLE READ',
        'S': 'SERIALIZABLE'
      }[(options.isolationLevel || 'RC').toUpperCase()] || options.isolationLevel).toUpperCase() + '; ';
      
      if (tables.length === 0) {
        init += 'START TRANSACTION ';
      } else {
        init += 'LOCK TABLES ';
      }
      
      for (let i = 0; i < tables.length; ++i) {
        const name = tables[i];
        const mode = tablelocks[name].mode || tablelocks[name];
        const alias = tablelocks[name].alias;
        const tablename = tablelocks[name].name || name;
        
        const modeString = {'r': 'READ', 'w': 'WRITE'}[mode];
        assert.ok(mode);
        
        init += tablename + (alias ? ' AS ' + alias : '') + ' ' + modeString;
        
        if (i < tables.length - 1) {
          init +=  ', ';
        }
      }
      
      init += ';';
      
      return conn.query(init);
    }).then(() => {
      // install timer to notify in case that the transaction gets 'lost'
      notifyTimer = setTimeout(() => {
        if (tli === null) {
          return;
        }
        
        this.emitError(new Error('Transaction did not close within timeout: ' + JSON.stringify(this.tableLocks[tli])));
      }, 90000);
      
      return conn;
    });
  };

  /**
   * Return some statistical information on this QContext,
   * including its properties.
   */
  getStatistics(recurse) {
    assert.ok(recurse === true || recurse === false);
    
    const rv = {};
    
    for (let i in this.properties) {
      rv[i] = this.properties[i].value;
    }
    
    rv.tableLocks = _.compact(this.tableLocks);
    rv.openConnections = _.compact(this.openConnections);
    rv.queryCount = this.queryCount;
    rv.incompleteQueryCount = this.incompleteQueryCount;
    
    rv.creationTime = this.creationTime;
    rv.creationStack = this.creationStack;
    
    return rv;
  }
}

exports.QContext = QContext;

function getStack() {
  let oldSTL, stack;
  
  oldSTL = Error.stackTraceLimit;
  Error.stackTraceLimit = Math.max(40, oldSTL); // at least 40
  stack = new Error().stack;
  Error.stackTraceLimit = oldSTL;
  
  return stack;
}
