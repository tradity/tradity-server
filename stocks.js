(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var lapack = require('lapack');

function StocksDB (db, quoteLoader) {
	this.db = db;
	this.quoteLoader = quoteLoader;
	this.lrutimeLimit = 200;
	this.refetchLimit = 260;
	this.leaderMatrix = null;
	this.valueShare = 100;
	
	this.updateLeaderMatrix();
	this.quoteLoader.on('record', _.bind(function(rec) {
		this.updateRecord(rec);
	}, this));
}
util.inherits(StocksDB, require('./objects.js').DBSubsystemBase);

StocksDB.prototype.regularCallback = function() {
	this.updateLeaderMatrix(_.bind(function() {
		this.cleanUpUnusedStocks(_.bind(function() {
			this.updateStockValues();
		}, this));
	}, this));
}

StocksDB.prototype.cleanUpUnusedStocks = function(cb) {
	cb = cb || function() {};
	
	this.db.query('DELETE FROM stocks WHERE' +
		'(SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.stockid = stocks.id) = 0 AND UNIX_TIMESTAMP()-stocks.lrutime > ? AND leader IS NULL', [this.lrutimeLimit],
		this.qcb(cb));
	this.db.query('DELETE FROM recent_searches');
}

StocksDB.prototype.updateStockValues = function() {
	this.db.query('SELECT * FROM stocks WHERE leader IS NULL AND UNIX_TIMESTAMP()-lastchecktime > ?', [this.refetchLimit], this.qcb(function(res) {
		this.quoteLoader.loadQuotes(_.map(res, function(entry) { return entry.stockid; }));
	}));
}

StocksDB.prototype.updateRecord = function(rec) {
	this.db.query('INSERT INTO stocks (stockid, lastvalue, lastchecktime, lrutime, leader, name) VALUES '+
		'(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), NULL, ?) ON DUPLICATE KEY ' +
		'UPDATE lastvalue = ?, lastchecktime = UNIX_TIMESTAMP(), name = ? WHERE stockid = ?',
		[rec.symbol, rec.lastTradePrice, rec.name, rec.lastTradePrice, rec.name, rec.symbol],
		this.qcb(_.bind(function() {
			this.emit('stock-update', {'stockid': rec.symbol, 'lastvalue': rec.lastTradePrice, 'name': rec.name});
		}, this))
	);
}

StocksDB.prototype.searchStocks = function(str, cb) {
	var handleResults = _.bind(function(results) {
		var symbols = _.map(results, function(r) { return r.stockid; });
		symbols = _.map(symbols, escape);
		this.db.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE symbol IN ("' + _.map(symbols.join('","')) + '")', [], this.qcb());
		cb('stock-search-success', results);
	}, this);
	
	var xstr = '%' + str.replace(/%/, '\\%') + '%';
	this.db.query('SELECT stocks.stockid AS stockid,stocks.lastvalue AS lastvalue,stocks.leader AS leader,users.name AS leadername FROM stocks JOIN users ON stocks.leader = users.id WHERE users.name LIKE ?', [xstr], this.qcb(function(res1) {
	this.db.query('SELECT * FROM recent_searches WHERE string = ?', [str], this.qcb(function(rs_res) {
	if (rs_res.length == 0) {
		this.quoteLoader.searchAndFindQuotes(str, _.bind(function(res2) {
			this.db.query('INSERT INTO recent_searches (string) VALUES(?)', [str], this.qcb(function() {
				var results = _.union(res1, _.map(res2, function(r) {
					return {'stockid': res2.symbol, 'lastvalue': rec.lastTradePrice, 'name': rec.name, 'leader': null};
				}));
				handleResults(results);
			}));
		}));
	} else {
		this.db.query('SELECT * FROM stocks WHERE name LIKE ? OR stockid LIKE ?', [xstr, xstr], this.qcb(function(res2) {
			handleResults(_.union(res1, res2));
		}));
	}
	}));
	}));
}

StocksDB.prototype.updateLeaderMatrix = function(cb) {
	this.db.query('SELECT userid AS uid FROM depot_stocks UNION SELECT leader AS uid FROM stocks WHERE leader IS NOT NULL', this.qcb(function(users) {
	this.db.query(
		'SELECT ds.userid AS uid, SUM(ds.amount * s.lastvalue) AS valsum FROM depot_stocks AS ds LEFT JOIN stocks AS s ' +
		'ON s.leader IS NULL AND s.id = ds.stockid GROUP BY uid', [], this.qcb(function(res_static) {
	this.db.query('SELECT s.leader AS luid, ds.userid AS fuid, ds.amount AS amount' +
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.leader IS NOT NULL AND s.id = ds.stockid', [], this.qcb(function(res_leader) {
		users = _.uniq(_.pluck(users, 'uid'));
		var users_inv = [];
		for (var k = 0; k < users.length; ++k)
			users_inv[users[k]] = k;
				
		var n = users.length;
		var A = _.map(_.range(n), function(i) {
			return _.map(_.range(n), function(j) { return i == j ? 1.0 : 0.0; });
		});
		
		var B = _.map(_.range(n), function() { return 0.0; });
		
		for (var k = 0; k < res_static.length; ++k) {
			var uid = res_static[k].uid;
			if (typeof (users_inv[uid]) == 'undefined' || users_inv[uid] >= n) {
				this.emit('error', 'unknown user ID in res_static: ' + uid);
				return;
			}
			
			B[users_inv[uid]] = [res_static[k].valsum];
		}
		
		for (var k = 0; k < res_leader.length; ++k) {
			var luid = res_leader[k].luid; // leader
			var fuid = res_leader[k].fuid; // follower
			var amount = res_leader[k].amount;
			
			A[fuid][luid] -= amount / this.valueShare;
		}
		
		var res = lapack.sgesv(A, B);
		if (!res) {
			this.emit('error', 'SLE solution not found for\nA = ' + A + '\nB = ' + B);
			return;
		}
		
		var X = _.pluck(res.X, 0);
		
		for (var i = 0; i < n; ++i) 
			db.query('UPDATE stocks SET lastvalue = ?, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?', [X[i], users[i]], this.qcb());
	}));
	}));
	}));
}

})();
