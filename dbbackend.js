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

const assert = require('assert');
const api = require('./api.js');
const deepupdate = require('./lib/deepupdate.js');
const debug = require('debug')('sotrade:db');
const debugSQL = require('debug')('sotrade:db:SQL');
const promiseUtil = require('./lib/promise-util.js');

/**
 * Database access module
 * 
 * @property {object} dbmod  The node.js module for database connection
 * @property {object} wConnectionPool  A connection pool for connections
 *                                     requiring write access.
 * @property {object} rConnectionPool  A connection pool for connections
 *                                     not requiring write access.
 * @property {int} openConnections  The current count of in-use connections
 */
class Database extends api.Component {
  constructor() {
    super({
      identifier: 'Database',
      description: 'Provides database access to other components.',
      depends: ['ReadonlyStore']
    });
    
    this.dbmod = null;
    this.wConnectionPool = null;
    this.rConnectionPool = null;
    this.openConnections = 0;
    this.deadlockCount = 0;
    this.queryCount= 0;
    this.isShuttingDown = false;
    this.writableNodes = new Set();
    this.id = 0;
  }
  
  init() {
    debug('Initializing database');
    
    const cfg = this.load('Config').config();
    
    this.dbmod = cfg.dbmod || require('mysql');
    
    this.wConnectionPool = this.dbmod.createPoolCluster(cfg.db.clusterOptions);
    this.rConnectionPool = this.dbmod.createPoolCluster(cfg.db.clusterOptions);
    this.writableNodes = new Set();
    
    for (let i = 0; i < cfg.db.clusterOptions.order.length; ++i) {
      const id = cfg.db.clusterOptions.order[i];
      assert.ok(cfg.db.cluster[id]);
      const opt = deepupdate({}, cfg.db.cluster[id], cfg.db);
      
      if (opt.ssl === 'default') {
        opt.ssl = cfg.ssl || {};
      }
      
      debug('Create pool node', opt.writable, opt.readable, id);
      
      if (opt.writable) {
        this.writableNodes.add(id);
        this.wConnectionPool.add(id, opt);
      }
      
      if (opt.readable) {
        this.rConnectionPool.add(id, opt);
      }
    }
    
    this.wConnectionPool.on('remove', nodeId => {
      debug('Connection removed from writing pool!');
      
      this.writableNodes.delete(nodeId);
      if (this.writableNodes.size === 0) {
        return this.load('ReadonlyStore').readonly = true;
      }
    });
    
    this.wConnectionPool.on('remove', () => this.load('PubSub').emit('error', new Error('DB lost write connection')));
    this.rConnectionPool.on('remove', () => this.load('PubSub').emit('error', new Error('DB lost read connection')));
    
    this.load('PubSub').on('shutdown', () => this.shutdown());
    
    this.inited = true;
    this.openConnections = 0;
  }

  shutdown() {
    this.isShuttingDown = true;
    
    debug('Database shutdown');
    
    if (this.openConnections === 0) {
      if (this.wConnectionPool) {
        this.wConnectionPool.end();
        this.wConnectionPool = null;
      }
      
      if (this.rConnectionPool) {
        this.rConnectionPool.end();
        this.rConnectionPool = null;
      }
      
      this.inited = false;
    }
  }
  
  usageStatistics() {
    return {
      deadlockCount: this.deadlockCount,
      queryCount: this.queryCount,
      writableNodes: this.writableNodes.size
    };
  }

  /**
   * Executes an SQL query on the database.
   * Your local {@link module:qctx~QContext}’s <code>query</code> method
   * invokes this – if available, consider using it in order to map all
   * actions to the current context.
   * 
   * @param {string} query  The SQL query
   * @param {Array} args  Parameters to escape and insert into the query
   * @param {boolean} readonly  Indicates whether this query can use the read-only pool
   */
  query(query, args, readonly) {
    const origArgs = [...arguments];
    
    if (typeof readonly !== 'boolean') {
      readonly = (query.trim().indexOf('SELECT') === 0);
    }
    
    return this._getConnection(true, /* restart */() => {
      return this.query(...origArgs);
    }, readonly).then(connection => {
      return connection.query(query, args || []);
    });
  }

  /**
   * Returns a database connection (for internal use).
   * Your local {@link module:qctx~QContext}’s <code>getConnection</code>
   * method invokes this – if available, consider using it in order to map
   * all actions to the current context.
   * 
   * @param {boolean} autorelease  Whether to release the connection after 1 query
   * @param {function} restart  Callback which will be invoked in case the query resulted in
   *                            a state in which the query/transaction needs to be restarted
   * @param {boolean} readonly  Indicates whether the connection can
   *                            be from the read-only pool
   */
  _getConnection(autorelease, restart, readonly) {
    const pool = readonly ? this.rConnectionPool : this.wConnectionPool;
    assert.ok(pool);
    
    return promiseUtil.ncall(pool.getConnection.bind(pool))().then(conn => {
      this.openConnections++;
    
      assert.ok(conn);
      const id = this.id++;
      
      const release = () => {
        this.openConnections--;
        
        if (this.openConnections === 0 && this.isShuttingDown) {
          this.shutdown();
        }
        
        return conn.release();
      };
      
      const query = (q, args) => {
        if (/^\s*(REPLACE|DELETE|UPDATE|INSERT)/i.test(q) && readonly) {
          debug('Refusing to execute query without write connection', q);
          return Promise.reject(new RangeError('Won’t execute this query on a readonly connection. ' +
            'This mission is too important for me to allow you to jeopardize it.'));
        }
        
        this.queryCount++;
        
        const rollback = () => {
          if (!readonly) {
            return conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1');
          }
        };

        return new Promise((resolve, reject) => {
          const startTime = Date.now();
          conn.query(q, args, (err, res) => {
            debugSQL(id + '\t' + (q.length > 100 ? q.substr(0, 100) + '…' : q) + ' -> ' + (err ? err.code :
              (res && typeof res.length !== 'undefined' ? res.length + ' results' :
               res && typeof res.affectedRows !== 'undefined' ? res.affectedRows + ' updates' : 'OK')) + 
               ' in ' + (Date.now() - startTime) + ' ms');
            
            if (err && (err.code === 'ER_LOCK_WAIT_TIMEOUT' || err.code === 'ER_LOCK_DEADLOCK')) {
              this.deadlockCount++;
              rollback();
              
              release();
              
              return resolve(Promise.resolve().then(restart));
            }
            
            let exception = null;
            
            if (!err) {
              try {
                resolve(res);
              } catch (e) {
                exception = e;
              }
            }
            
            if (err || exception) {
              rollback();
              
              // make sure that the error event is emitted -> release() will be called in next tick
              Promise.resolve().then(release).catch(e => { throw e; });
              autorelease = false;
              
              reject(err || exception);
              
              if (err) {
                // query-related error
                const datajson = JSON.stringify(args);
                const querydesc = '<<' + q + '>>' + (datajson.length <= 1024 ? ' with arguments [' + new Buffer(datajson).toString('base64') + ']' : '');
              
                this.load('PubSub').emit('error', q ? new Error(
                  err + '\nCaused by ' + querydesc
                ) : err);
              } else {
                // exception in callback
                this.load('PubSub').emit('error', exception);
              }
            }
            
            if (autorelease) {
              release();
            }
          });
        });
      };
      
      return {
        query: query, release: release
      };
    });
  }

  /**
   * Returns a database connection (for public use).
   * Your local {@link module:qctx~QContext}’s <code>getConnection</code>
   * method invokes this – if available, consider using it in order to map
   * all actions to the current context.
   * 
   * @param {boolean} readonly  Indicates whether the connection can
   *                            be from the read-only pool
   * @param {function} restart  Callback that will be invoked when the current transaction
   *                            needs to be restarted
   */
  getConnection(readonly, restart) { 
    assert.ok(readonly === true || readonly === false);
    
    return this._getConnection(false, restart, readonly).then(cn => {
      return {
        query: (q, data) => {
          data = data || [];
          
          return cn.query(q, data);
        },
        release: () => {
          return cn.release();
        }
      };
    });
  }
}

exports.components = [
  Database
];
