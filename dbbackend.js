(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var buscomponent = require('./buscomponent.js');

function Database () {
	this.dbmod = null;
	this.connectionPool = null;
	this.openQueries = 0;
	this.isShuttingDown = false;
}

util.inherits(Database, buscomponent.BusComponent);

Database.prototype._init = function(cb) {
	this.getServerConfig(function(cfg) {
		this.dbmod = cfg['dbmod'] || require('mysql');
		this.connectionPool = this.dbmod.createPool(cfg['db']);
		this.inited = true;
		this.openQueries = 0;
		
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
	
	if (this.connectionPool && this.openQueries == 0) {
		this.connectionPool.end();
		this.connectionPool = null;
		this.inited = false;
	}
});

Database.prototype._query = buscomponent.needsInit(function(query, args, cb) {
	this._getConnection(function(err, connection) {
		if (err)
			return cb(err, null);
		connection.query(query, args, function() {
			connection.release();
			cb.apply(this, arguments);
		});
	});
});

Database.prototype._getConnection = buscomponent.needsInit(function(cb) {
	assert.ok (this.connectionPool);
	
	this.openQueries++;
	
	var db = this;
	this.connectionPool.getConnection(function(err, conn) {
		if (conn == null)
			return cb(err, null);
		
		var release = function() {
			db.openQueries--;
			
			if (db.openQueries == 0 && db.isShuttingDown)
				db.shutdown();
			
			return conn.release();
		};
		
		cb(err, {
			query: function(q, args, cb) {
				conn.query(q, args, function(err, res) {
					var exception = null;
					try {
						cb(err, res);
					} catch (e) {
						exception = e;
					}
					
					if (err || exception) {
						conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1');
						release();
						if (exception)
							this.emit('error', exception);
					}
				});
			}, release: release
		});
	});
});

Database.prototype.escape = buscomponent.needsInit(function(str) {
	return this.dbmod.escape(str);
});

Database.prototype.query = buscomponent.provide('dbQuery', ['query', 'args', 'reply'], function(query, data, cb) {
	data = data || [];
	
	this._query(query, data, this.queryCallback(cb, query, data));
});

Database.prototype.getConnection = buscomponent.provide('dbGetConnection', ['reply'], function(conncb) {
	this._getConnection(_.bind(function(err, cn) {
		if (err)
			this.emit('error', err);
			
		if (!this.dbconnid)
			this.dbconnid = 0;
		var connid = ++this.dbconnid;
		
		conncb({
			query: _.bind(function(q, data, cb) {
				data = data || [];
				
				this.emit('dbBoundQueryLog', [q, data]);
				cn.query(q, data, this.queryCallback(cb, q, data));
			}, this),
			release: _.bind(function() {
				cn.release();
			}, this)
		});
	}, this));
});

Database.prototype.queryCallback = function(cb, query, data) {
	return _.bind(function(err, res) {
		var datajson = JSON.stringify(data);
		
		if (err) {
			var querydesc = '<<' + query + '>>' + (datajson.length <= 1024 ? ' with arguments [' + new Buffer(datajson).toString('base64') + ']' : '');
			
			this.emit('error', query ? new Error(
				err + '\nCaused by ' + querydesc
			) : err);
		} else if (cb) {
			_.bind(cb, this)(res);
		}
	}, this);
};

exports.Database = Database;

})();
