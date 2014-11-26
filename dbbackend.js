(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');
var serverUtil = require('./server-util.js');

/**
 * Provides access to a (MySQL) database for storing and fetching information
 * 
 * @public
 * @module dbbackend
 */

/**
 * Main object of the {@link module:dbbackend} module
 * 
 * @augments module:stbuscomponent~STBusComponent
 * 
 * @property {object} dbmod  The node.js module for database connection
 * @property {object} wConnectionPool  A connection pool for connections
 *                                     requiring write access.
 * @property {object} rConnectionPool  A connection pool for connections
 *                                     not requiring write access.
 * @property {int} openConnections  The current count of in-use connections
 * @property {boolean} isShuttingDown  Flag that indicates server shutdown
 * 
 * @public
 * @constructor module:dbbackend~Database
 */
function Database () {
	Database.super_.apply(this, arguments);
	
	this.dbmod = null;
	this.wConnectionPool = null;
	this.rConnectionPool = null;
	this.openConnections = 0;
	this.isShuttingDown = false;
}

util.inherits(Database, buscomponent.BusComponent);

Database.prototype._init = function(cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		self.dbmod = cfg.dbmod || require('mysql');
		
		self.wConnectionPool = self.dbmod.createPoolCluster(cfg.db.clusterOptions);
		self.rConnectionPool = self.dbmod.createPoolCluster(cfg.db.clusterOptions);
		self.writableNodes = [];
		
		for (var i = 0; i < cfg.db.clusterOptions.order.length; ++i) {
			var id = cfg.db.clusterOptions.order[i];
			var opt = serverUtil.deepupdate(cfg.db.cluster[id], cfg.db);
			
			if (opt.ssl === 'default')
				opt.ssl = cfg.ssl || {};
			
			if (opt.writable) {
				self.writableNodes.push(id);
				self.wConnectionPool.add(id, opt);
			}
			
			if (opt.readable)
				self.rConnectionPool.add(id, opt);
		}
		
		self.wConnectionPool.on('remove', function(nodeId) {
			self.writableNodes = _.without(self.writableNodes, nodeId);
			if (self.writableNodes.length == 0)
				self.emitImmediate('change-readability-mode', { readonly: true });
		});
		
		self.wConnectionPool.on('remove', function() { self.emitError(new Error('DB lost write connection')); });
		self.rConnectionPool.on('remove', function() { self.emitError(new Error('DB lost read connection')); });
		
		self.inited = true;
		self.openConnections = 0;
		
		/*
		 * Note: We don't set isShuttingDown = true here.
		 * This happens so we can actually resurrect the database connection
		 * during the shutdown process temporarily, so other components can complete
		 * any remaining work in progress.
		 */
		
		cb();
	});
};

Database.prototype.shutdown = buscomponent.listener('localMasterShutdown', function() {
	this.isShuttingDown = true;
	
	if (this.openConnections == 0) {
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
});

/**
 * Executes an SQL query on the database.
 * Your local {@link module:qctx~QContext}’s <code>query</code> method
 * invokes this – if available, consider using it in order to map all
 * actions to the current context.
 * 
 * @param {string} query  The SQL query
 * @param {Array} args  Parameters to escape and insert into the query
 * @param {boolean} readonly  Indicates whether this query can use the read-only pool
 * 
 * @function busreq~dbQuery
 */
Database.prototype._query = buscomponent.provide('dbQuery', ['query', 'args', 'readonly', 'reply'],
	buscomponent.needsInit(function(query, args, readonly, cb)
{
	var self = this, origArgs = arguments;
	
	if (readonly !== false && readonly !== true)
		readonly = (query.trim().indexOf('SELECT') == 0);
	
	self._getConnection(true, function /* restart */() {
		self._query.apply(self, origArgs);
	}, readonly, function(connection) {
		connection.query(query, args || [], function() {
			cb.apply(self, arguments);
		});
	});
}));

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
 * 
 * @function module:dbbackend~Database#_getConnection
 */
Database.prototype._getConnection = buscomponent.needsInit(function(autorelease, restart, readonly, cb) {
	var self = this;
	var pool = readonly ? self.rConnectionPool : self.wConnectionPool;
	assert.ok (pool);
	
	self.openConnections++;
	
	pool.getConnection(function(err, conn) {
		if (err)
			return self.emitError(err);
		
		assert.ok(conn);
		
		var release = function() {
			self.openConnections--;
			
			if (self.openConnections == 0 && self.isShuttingDown)
				self.shutdown();
			
			return conn.release();
		};
		
		var query = function(q, args, cb) {
			conn.query(q, args, function(err, res) {
				if (err && (err.code == 'ER_LOCK_WAIT_TIMEOUT' || err.code == 'ER_LOCK_DEADLOCK')) {
					release();
					
					return restart();
				}
				
				var exception = null;
				
				if (!err) {
					try {
						cb(res);
					} catch (e) {
						exception = e;
					}
				}
				
				if (err || exception) {
					if (!readonly)
						conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1');
					
					// make sure that the error event is emitted -> release() will be called in next tick
					process.nextTick(release);
					
					if (err) {
						// query-related error
						var datajson = JSON.stringify(args);
						var querydesc = '<<' + q + '>>' + (datajson.length <= 1024 ? ' with arguments [' + new Buffer(datajson).toString('base64') + ']' : '');
					
						self.emitError(q ? new Error(
							err + '\nCaused by ' + querydesc
						) : err);
					} else {
						// exception in callback
						self.emitError(exception);
					}
				}
				
				if (err || exception || autorelease) {
					release();
				}
			});
		};
		
		cb({
			query: query, release: release
		});
	});
});

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
 * 
 * @function busreq~dbGetConection
 */
Database.prototype.getConnection = buscomponent.provide('dbGetConnection',
	['readonly', 'restart', 'reply'], function(readonly, restart, conncb) 
{
	var self = this;
	
	assert.ok(readonly === true || readonly === false);
	
	self._getConnection(false, restart, readonly, function(cn) {
		conncb({
			query: function(q, data, cb) {
				data = data || [];
				
				// emitting self has the sole purpose of it showing up in the bus log
				self.emitImmediate('dbBoundQueryLog', [q, data]);
				cn.query(q, data, cb);
			},
			release: function() {
				cn.release();
			}
		});
	});
});

exports.Database = Database;

})();
