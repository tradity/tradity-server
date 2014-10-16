(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./bus/buscomponent.js');

function Database () {
	this.dbmod = null;
	this.connectionPool = null;
	this.openConnections = 0;
	this.isShuttingDown = false;
}

util.inherits(Database, buscomponent.BusComponent);

Database.prototype._init = function(cb) {
	this.getServerConfig(function(cfg) {
		this.dbmod = cfg['dbmod'] || require('mysql');
		this.connectionPool = this.dbmod.createPool(cfg['db']);
		this.inited = true;
		this.openConnections = 0;
		
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
	
	if (this.connectionPool && this.openConnections == 0) {
		this.connectionPool.end();
		this.connectionPool = null;
		this.inited = false;
	}
});

Database.prototype._query = buscomponent.provide('dbQuery', ['query', 'args', 'reply'],
	buscomponent.needsInit(function(query, args, cb)
{
	this._getConnection(true, function(connection) {
		connection.query(query, args || [], function() {
			cb.apply(this, arguments);
		});
	});
}));

Database.prototype._getConnection = buscomponent.needsInit(function(autorelease, cb) {
	assert.ok (this.connectionPool);
	
	this.openConnections++;
	
	var db = this;
	this.connectionPool.getConnection(function(err, conn) {
		if (err)
			this.emitError(err);
		
		assert.ok(conn);
		
		var release = function() {
			db.openConnections--;
			
			if (db.openConnections == 0 && db.isShuttingDown)
				db.shutdown();
			
			return conn.release();
		};
		
		cb({
			query: function(q, args, cb) {
				conn.query(q, args, function(err, res) {
					var exception = null;
					
					if (!err) {
						try {
							cb(res);
						} catch (e) {
							exception = e;
						}
					}
					
					if (err || exception) {
						conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1');
						
						// make sure that the error event is emitted -> release() will be called in next tick
						process.nextTick(release);
						
						if (err) {
							// query-related error
							var datajson = JSON.stringify(args);
							var querydesc = '<<' + query + '>>' + (datajson.length <= 1024 ? ' with arguments [' + new Buffer(datajson).toString('base64') + ']' : '');
						
							this.emitError(query ? new Error(
								err + '\nCaused by ' + querydesc
							) : err);
						} else {
							// exception in callback
							this.emitError(exception);
						}
					} else if (autorelease) {
						release();
					}
				});
			}, release: release
		});
	});
});

Database.prototype.escape = buscomponent.needsInit(function(str) {
	return this.dbmod.escape(str);
});

Database.prototype.getConnection = buscomponent.provide('dbGetConnection', ['reply'], function(conncb) {
	this._getConnection(false, _.bind(function(cn) {
		if (!this.dbconnid)
			this.dbconnid = 0;
		var connid = ++this.dbconnid;
		
		conncb({
			query: _.bind(function(q, data, cb) {
				data = data || [];
				
				// emitting this has the sole purpose of it showing up in the bus log
				this.emitImmediate('dbBoundQueryLog', [q, data]);
				cn.query(q, data, cb);
			}, this),
			release: _.bind(function() {
				cn.release();
			}, this)
		});
	}, this));
});

exports.Database = Database;

})();
