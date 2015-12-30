"use strict";

const Access = require('./access.js').Access;
const util = require('util');
const assert = require('assert');
const weak = require('weak');
const buscomponent = require('./stbuscomponent.js');
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
 * @constructor module:qctx~QContext
 * @augments module:stbuscomponent~STBusComponent
 */
class QContext extends buscomponent.BusComponent {
  constructor(obj) {
    super();
    
    obj = obj || {};
    this.user = obj.user || null;
    this.access = obj.access || new Access();
    this.properties = {};
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
    
    let parentQCtx = null;
    
    if (obj.parentComponent) {
      if (obj.isQContext)
        parentQCtx = obj.parentComponent;
      
      this.setBusFromParent(obj.parentComponent);
    }
    
    if (!parentQCtx && !obj.isMasterQCTX)
      parentQCtx = QContext.getMasterQueryContext();
    
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
    
    if (parentQCtx)
      parentQCtx.childContexts.push(weak(this, ondestroy));
    
    this.addProperty({name: 'debugEnabled', value: false, access: 'server'});
  }
}

QContext.masterQueryContext = null;

QContext.getMasterQueryContext = function() {
  if (QContext.masterQueryContext)
    return QContext.masterQueryContext;
  
  QContext.masterQueryContext = new QContext({isMasterQCTX: true});
};

/**
 * Return a copy of this QContext.
 * 
 * @return {module:qctx~QContext}  A shallow copy of this QContext.
 * @function module:qctx~QContext#clone
 */
QContext.prototype.clone = function() {
  const c = new QContext({
    user: this.user,
    access: this.access.clone(),
    parentComponent: this
  });
  
  c.properties = _.clone(this.properties);
  c.debugHandlers = this.debugHandlers.slice();
  c.errorHandlers = this.errorHandlers.slice();
  
  return c;
};

/**
 * List all child QContexts of this query context.
 * Garbage collected QContexts are automatically excluded.
 * 
 * @return {module:qctx~QContext[]}  A list of QContexts.
 * @function module:qctx~QContext#getChildContexts
 */
QContext.prototype.getChildContexts = function() {
  const rv = [];
  
  for (let i = 0; i < this.childContexts.length; ++i) {
    if (weak.isDead(this.childContexts[i]))
      delete this.childContexts[i];
    else
      rv.push(this.childContexts[i]);
  }
  
  // remove deleted indices
  this.childContexts = _.compact(this.childContexts);
  
  return rv;
};

QContext.prototype.onBusConnect = function() {
  return this.request({name: 'get-readability-mode'}).then(reply => {
    assert.ok(reply.readonly === true || reply.readonly === false);
    
    if (!this.hasProperty('readonly')) {
      return this.addProperty({
        name: 'readonly',
        value: reply.readonly
      });
    }
  });
};

QContext.prototype.changeReadabilityMode = buscomponent.listener('change-readability-mode', function(event) {
  if (this.hasProperty('readonly'))
    return this.setProperty('readonly', event.readonly);
});

/**
 * Serialize this QContext into a raw JS object.
 * 
 * @return {object}  An object to be passed to {@link module:qctx~fromJSON}
 * @function module:qctx~QContext#toJSON
 */
QContext.prototype.toJSON = function() {
  return { user: this.user, access: this.access.toJSON(), properties: this.properties };
};

/**
 * Deserialize this JS object into a new QContext.
 * 
 * @param {object} j  A serialized version as returned by {@link module:qctx~QContext#toJSON}.
 * @param {module:buscomponent~BusComponent} parentComponent  A parent component whose bus 
 *                                                            should be connected to.
 * 
 * @return {object}  A freshly created {@link module:qctx~QContext}.
 * @function module:qctx~QContext.fromJSON
 */
exports.fromJSON =
QContext.fromJSON = function(j, parentComponent) {
  const ctx = new QContext({parentComponent: parentComponent});
  if (!j)
    return ctx;
  
  ctx.user = j.user || null;
  ctx.access = Access.fromJSON(j.access);
  ctx.properties = j.properties || {};
  
  return ctx;
};

/**
 * Adds a new property to the list of context properties.
 * 
 * @param {object} propInfo
 * @param {string} propInfo.name  The name of this property
 * @param {module:access~Access} propInfo.access  Access restrictions for
 *                                                changing this property
 * @param propInfo.value  The default/initial value for this property
 * 
 * @function module:qctx~QContext#addProperty
 */
QContext.prototype.addProperty = function(propInfo) {
  this.properties[propInfo.name] = propInfo;
};

/**
 * Fetches a property value.
 * 
 * @param {string} name  The property name.
 * @return  The property value.
 * 
 * @function module:qctx~QContext#getProperty
 */
QContext.prototype.getProperty = function(name) {
  if (!this.hasProperty(name))
    return undefined;
  
  return this.properties[name].value;
};

/**
 * Returns whether a given property value exists.
 * 
 * @param {string} name  The property name.
 * @return  True iff such a property exists.
 * 
 * @function module:qctx~QContext#hasProperty
 */
QContext.prototype.hasProperty = function(name) {
  return this.properties[name] ? true : false;
};

/**
 * Sets a property value.
 * 
 * @param {string} name  The property name.
 * @param value  The new property value.
 * @param {?boolean} hasAccess  If true, pass all access checks.
 * 
 * @function module:qctx~QContext#setProperty
 */
QContext.prototype.setProperty = function(name, value, hasAccess) {
  if (!this.hasProperty(name))
    throw new Error('Property ' + name + ' not defined yet');
  
  const requiredAccess = this.properties[name].access;
  if (!requiredAccess) {
    hasAccess = true;
  } else if (typeof requiredAccess == 'string') {
    hasAccess = hasAccess || this.access.has(requiredAccess);
  } else if (typeof requiredAccess == 'function') {
    hasAccess = hasAccess || requiredAccess(this);
  } else {
    throw new Error('Unknown access restriction ' + JSON.stringify(requiredAccess));
  }
  
  if (hasAccess)
    this.properties[name].value = value;
  else
    throw new Error('Access for changing property ' + name + ' not granted ' + requiredAccess);
};

/**
 * Shorthand method for pushing feed entries.
 * See {@link busreq~feed}.
 * 
 * @return {object}  A Promise corresponding to successful completion
 * @function module:qctx~QContext#feed
 */
QContext.prototype.feed = function(data) {
  let conn = data.conn || this.contextTransaction || null;
  const onEventId = data.onEventId || (() => {});
  delete data.conn;
  delete data.onEventId;
  
  var release = null;
  
  // keep in mind that self.contextTransaction may be a promise or null
  // use Promise.resolve(…) to clarify that before all else
  return Promise.resolve(conn).then(conn_ => {
    // connection is there? -> set conn to the resolved promise
    if (conn_)
      return conn = conn_;
    
    return this.startTransaction().then(conn_ => {
      return conn = release = conn_;
    });
  }).then(() => {
    return this.request({name: 'feed', data: data, ctx: this, onEventId: onEventId, conn: conn});
  }).then(retval => {
    // release is never a promise
    if (release)
      return release.commit().then(() => retval);
  }).catch(e => {
    if (release)
      return release.rollbackAndThrow(e);
    throw e;
  });
};

QContext.prototype.txwrap = function(fn) {
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
};

QContext.prototype.enterTransactionOnQuery = function(tables, options) {
  assert.ok(!this.startTransactionOnQuery);
  assert.ok(!this.contextTransaction);
  
  this.startTransactionOnQuery = {tables: tables, options: options};
  
  return this;
};

QContext.prototype.commit = function() {
  const args = arguments;
  
  if (!this.contextTransaction)
    return Promise.resolve();
  
  return Promise.resolve(this.contextTransaction).then(conn => {
    return conn.commit.apply(this, args);
  });
};

QContext.prototype.rollback = function() {
  const args = arguments;
  
  if (!this.contextTransaction)
    return Promise.resolve();
  
  return Promise.resolve(this.contextTransaction).then(conn => {
    return conn.rollback.apply(this, args);
  });
};

QContext.prototype.rollbackAndThrow = function(e) {
  return this.rollback().then(() => {
    throw e;
  });
};

/**
 * Shorthand method for executing database queries.
 * See {@link busreq~dbQuery}.
 * 
 * @return {object}  A Promise corresponding to successful completion
 * @function module:qctx~QContext#query
 */
QContext.prototype.query = function(query, args, readonly) {
  var queryArgs = arguments;
  var sToQ = this.startTransactionOnQuery;
  
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
  
  return this.request({name: 'dbQuery', query: query, args: args, readonly: readonly}).then(data => {
    this.incompleteQueryCount--;
    this.queryCount++;
    
    return data;
  });
};

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
 * @function module:qctx~QContext#getConnection
 */
QContext.prototype.getConnection = function(readonly, restart) {
  var oci = this.openConnections.push([{readonly: readonly, time: Date.now(), stack: getStack()}]) - 1;
  var conn;
  
  var postTransaction = doRelease => {
    delete this.openConnections[oci];
    if (_.compact(this.openConnections) == [])
      this.openConnections = [];
    
    if (typeof doRelease == 'undefined')
      doRelease = true;
    
    if (doRelease)
      return conn.release();
  };
  
  var oldrestart = restart;
  restart = () => {
    return Promise.resolve(postTransaction()).then(oldrestart);
  };
  
  return this.request({readonly: readonly, restart: restart, name: 'dbGetConnection'}).then(conn_ => {
    conn = conn_;
    assert.ok(conn);
    
    /* return wrapper object for better debugging, no semantic change */
    var conn_ = {
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
};

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
 * @function module:qctx~QContext#startTransaction
 */
QContext.prototype.startTransaction = function(tablelocks, options) {
  var args = arguments;
  
  options = options || {};
  tablelocks = tablelocks || {};
  
  var readonly = !!options.readonly;
  
  var tli = null;
  var notifyTimer = null;
  
  if (tablelocks)
    tli = this.tableLocks.push([{locks: tablelocks, time: Date.now(), stack: getStack()}]) - 1;
  
  debug('Starting transaction', tli);
  var cleanTLEntry = () => {
    debug('Ended transaction', tli);
    
    if (tli === null)
      return;
    
    if (notifyTimer)
      clearTimeout(notifyTimer);
    
    notifyTimer = null;
    delete this.tableLocks[tli];
    if (_.compact(this.tableLocks) == [])
      this.tableLocks = [];
    
    tli = null;
  };
  
  var conn;
  var oldrestart = options.restart || (() => {
    (conn ? conn.rollback() : Promise.resolve()).then(() => {
      this.startTransaction.apply(this, args);
    });
  });
  
  var restart = () => {
    cleanTLEntry();
    return oldrestart.apply(this, arguments);
  };
  
  return this.getConnection(readonly, restart).then(conn_ => {
    conn = conn_;
    
    var oldCommit = conn.commit, oldRollback = conn.rollback;
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
    
    var tables = Object.keys(tablelocks);
    var init = 'SET autocommit = 0; ';
    
    init += 'SET TRANSACTION ISOLATION LEVEL ' + ({
      'RU': 'READ UNCOMMITTED',
      'RC': 'READ COMMITTED',
      'RR': 'REPEATABLE READ',
      'S': 'SERIALIZABLE'
    }[(options.isolationLevel || 'RC').toUpperCase()] || options.isolationLevel).toUpperCase() + '; ';
    
    if (tables.length == 0)
      init += 'START TRANSACTION ';
    else
      init += 'LOCK TABLES ';
    
    for (let i = 0; i < tables.length; ++i) {
      var name = tables[i];
      var mode = tablelocks[name].mode || tablelocks[name];
      var alias = tablelocks[name].alias;
      var tablename = tablelocks[name].name || name;
      
      mode = {'r': 'READ', 'w': 'WRITE'}[mode];
      assert.ok(mode);
      
      init += tablename + (alias ? ' AS ' + alias : '') + ' ' + mode;
      
      if (i < tables.length - 1)
        init +=  ', ';
    }
    
    init += ';';
    
    return conn.query(init);
  }).then(() => {
    // install timer to notify in case that the transaction gets 'lost'
    notifyTimer = setTimeout(() => {
      if (tli === null)
        return;
      
      this.emitError(new Error('Transaction did not close within timeout: ' + JSON.stringify(this.tableLocks[tli])));
    }, 90000);
    
    return conn;
  });
};

/**
 * If debugging is enabled, pass the arguments of this method to the debug handlers.
 * 
 * @function module:qctx~QContext#debug
 */
QContext.prototype.debug = function() {
  if (!this.hasProperty('debugEnabled') || !this.getProperty('debugEnabled'))
    return;
  
  for (let i = 0; i < this.debugHandlers.length; ++i)
    this.debugHandlers[i](Array.prototype.slice.call(arguments));
};

/**
 * Call context-specific error handlers and pass on to
 * {@link module:buscomponent~BusComponent#emitError}.
 * 
 * @function module:qctx~QContext#emitError
 */
QContext.prototype.emitError = function(e) {
  this.debug('Caught error', e);
  
  for (let i = 0; i < this.errorHandlers.length; ++i)
    this.errorHandlers[i](e);
  
  QContext.super_.prototype.emitError.call(this, e);
};

/**
 * Return some statistical information on this QContext,
 * including its properties.
 * 
 * @param {boolean} recurse  If true, include all <code>.childContexts</code>’ statistics.
 * 
 * @function module:qctx~QContext#getStatistics
 */
QContext.prototype.getStatistics = function(recurse) {
  assert.ok(recurse === true || recurse === false);
  
  var rv = {};
  
  for (let i in this.properties)
    rv[i] = this.properties[i].value;
  
  rv.tableLocks = _.compact(this.tableLocks);
  rv.openConnections = _.compact(this.openConnections);
  rv.queryCount = this.queryCount;
  rv.incompleteQueryCount = this.incompleteQueryCount;
  
  rv.creationTime = this.creationTime;
  rv.creationStack = this.creationStack;
  
  if (recurse)
    rv.childContexts = this.childContexts.map(c => c.getStatistics(true));
  
  return rv;
};

exports.QContext = QContext;

function getStack() {
  var oldSTL, stack;
  
  oldSTL = Error.stackTraceLimit;
  Error.stackTraceLimit = Math.max(40, oldSTL); // at least 40
  stack = new Error().stack;
  Error.stackTraceLimit = oldSTL;
  
  return stack;
}
