(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var lapack = require('lapack');
var assert = require('assert');

function StocksDB (db, quoteLoader) {
	this.db = db;
	this.quoteLoader = quoteLoader;
	this.lrutimeLimit = 240;
	this.refetchLimit = 260;
	this.leaderMatrix = null;
	this.valueShare = 100;
	
	this.regularCallback();
	this.quoteLoader.on('record', _.bind(function(rec) {
		this.updateRecord(rec);
	}, this));
}
util.inherits(StocksDB, require('./objects.js').DBSubsystemBase);

StocksDB.prototype.regularCallback = function() {;
	this.cleanUpUnusedStocks(_.bind(function() {
		this.updateStockValues(_.bind(function() {
			this.updateLeaderMatrix();
		}, this));
	}, this));
}

StocksDB.prototype.cleanUpUnusedStocks = function(cb) {
	cb = cb || function() {};
	
	this.db.query('DELETE FROM depot_stocks WHERE amount = 0', [], this.qcb(function() {
		this.db.query('DELETE FROM recent_searches', [], this.qcb(function() {
		this.db.query('DELETE FROM stocks WHERE' +
			'(SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.stockid = stocks.id) = 0 AND UNIX_TIMESTAMP()-stocks.lrutime > ? AND leader IS NULL', [this.lrutimeLimit],
			this.qcb(cb));
		}));
	}));
}

StocksDB.prototype.updateStockValues = function(cb) {
	this.db.query('SELECT * FROM stocks WHERE leader IS NULL AND UNIX_TIMESTAMP()-lastchecktime > ?', [this.refetchLimit], this.qcb(function(res) {
		var stocklist = _.pluck(res, 'stockid');
		if (stocklist.length > 0)
			this.quoteLoader.loadQuotes(stocklist);	
		cb();
	}));
}

StocksDB.prototype.updateRecord = function(rec) {
	assert.notStrictEqual(rec.lastTradePrice, null);
	this.db.query('INSERT INTO stocks (stockid, lastvalue, lastchecktime, lrutime, leader, name) VALUES '+
		'(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), NULL, ?) ON DUPLICATE KEY ' +
		'UPDATE lastvalue = ?, lastchecktime = UNIX_TIMESTAMP(), name = IF(LENGTH(name) > LENGTH(?), name, ?)',
		[rec.symbol, rec.lastTradePrice * 10000, rec.name, rec.lastTradePrice * 10000, rec.name, rec.name],
		this.qcb(_.bind(function() {
			this.emit('stock-update', {'stockid': rec.symbol, 'lastvalue': rec.lastTradePrice * 10000, 'name': rec.name, 'leader': null, 'leadername': null});
		}, this))
	);
}

StocksDB.prototype.searchStocks = function(query, user, access, cb) {
	var str = query.name;
	
	var handleResults = _.bind(function(results) {
		var symbols = _.map(results, function(r) { return r.stockid; });
		symbols = _.map(symbols, escape);
		this.db.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE symbol IN ("' + _.map(symbols, _.bind(this.db.escape, this.db)).join('","') + '")', [], this.qcb());
		cb('stock-search-success', results);
	}, this);
	
	var xstr = '%' + str.replace(/%/, '\\%') + '%';
	this.db.query('SELECT stocks.stockid AS stockid,stocks.lastvalue AS lastvalue,stocks.leader AS leader,users.name AS leadername FROM stocks JOIN users ON stocks.leader = users.id WHERE users.name LIKE ?', [xstr], this.qcb(function(res1) {
	this.db.query('SELECT * FROM recent_searches WHERE string = ?', [str], this.qcb(function(rs_res) {
	if (rs_res.length == 0) {
		this.quoteLoader.searchAndFindQuotes(str, _.bind(function(res2) {
			this.db.query('INSERT INTO recent_searches (string) VALUES(?)', [str], this.qcb(function() {
				var results = _.union(res1, _.map(res2, function(r) {
					return {'stockid': r.symbol, 'lastvalue': r.lastTradePrice * 10000, 'name': r.name, 'leader': null, 'leadername': null};
				}));
				handleResults(results);
			}));
		}, this));
	} else {
		this.db.query('SELECT * FROM stocks WHERE name LIKE ? OR stockid LIKE ?', [xstr, xstr], this.qcb(function(res2) {
			handleResults(_.union(res1, res2));
		}));
	}
	}));
	}));
}

StocksDB.prototype.updateLeaderMatrix = function(cb) {
	cb = cb || function() {};
	
	this.db.query('SELECT userid AS uid FROM depot_stocks UNION SELECT leader AS uid FROM stocks WHERE leader IS NOT NULL', this.qcb(function(users) {
	this.db.query(
		'SELECT ds.userid AS uid, SUM(ds.amount * s.lastvalue) + freemoney AS valsum FROM depot_stocks AS ds LEFT JOIN stocks AS s ' +
		'ON s.leader IS NULL AND s.id = ds.stockid LEFT JOIN users ON ds.userid = users.id GROUP BY uid', [], this.qcb(function(res_static) {
	this.db.query('SELECT s.leader AS luid, ds.userid AS fuid, ds.amount AS amount ' +
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.leader IS NOT NULL AND s.id = ds.stockid', [], this.qcb(function(res_leader) {
		users = _.uniq(_.pluck(users, 'uid'));
		var users_inv = [];
		for (var k = 0; k < users.length; ++k)
			users_inv[users[k]] = k;
				
		var n = users.length;
		if (n == 0)
			return;
		
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
			var l = users_inv[res_leader[k].luid]; // leader
			var f = users_inv[res_leader[k].fuid]; // follower
			var amount = res_leader[k].amount;
			
			A[f][l] -= amount / this.valueShare;
		}
		
		console.log(A, B);
		var res = lapack.sgesv(A, B);
		if (!res) {
			this.emit('error', 'SLE solution not found for\nA = ' + A + '\nB = ' + B);
			return;
		}
		
		var X = _.pluck(res.X, 0);
		
		this.transaction(function() {
			for (var i = 0; i < n; ++i) {
				_.bind(_.partial(function(i) {
				assert.notStrictEqual(X[i], null);
				this.db.query('UPDATE stocks SET lastvalue = ?, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?', [X[i] / 100, users[i]], this.qcb(function() {
					this.db.query('SELECT stockid, lastvalue, stocks.name AS name, leader, users.name AS leadername FROM stocks JOIN users ON leader = users.id WHERE leader = ?',
						[users[i]], this.qcb(function(res) {
						console.log(res, n, i, users[i], X[i]);
						assert.equal(res.length, 1);
						this.emit('stock-update', res[0]);
					}));
				}));
				}, i), this)();
			}
		});
	}));
	}));
	}));
}

StocksDB.prototype.buyStock = function(query, user, access, cb) {
	if ((!query.stockid && query.leader == null) || (query.stockid && query.leader)) 
		return cb('format-error');
	
	if (query.leader != null)
		query.stocks = '__LEADER_' + query.leader + '__';
	
	this.transaction(function() {
		this.db.query('SELECT s.*, SUM(ds.amount) AS amount FROM stocks AS s LEFT JOIN depot_stocks AS ds ON ds.userid = ? AND ds.stockid = s.id WHERE s.stockid = ? GROUP BY s.id', [user.id, query.stockid], this.qcb(function(res) {
			if (res.length == 0)
				return cb('stock-buy-stock-not-found');
			var r = res[0];
			
			var amount = parseInt(query.amount == null ? query.value / r.lastvalue : query.amount);
			if (amount == 0) 
				return cb('stock-buy-round-result-zero');
			var price = amount * r.lastvalue;
			if (price > user.freemoney)
				return cb('stock-buy-out-of-money');
			if (amount < -c.amount)
				return cb('stock-buy-not-enough-stocks');
				
			this.db.query('UPDATE users SET freemoney = freemoney-(?) WHERE id = ?', [price, user.id], this.qcb());
			
			if (r.amount == null) {
				this.db.query('INSERT INTO depot_stocks (userid, stockid, amount, buytime, comment) VALUES(?,?,?,UNIX_TIMESTAMP(),?)', 
					[user.id, r.id, amount, query.comment], this.qcb(function() {
					cb('stock-buy-success');
				}));
			} else {
				this.db.query('UPDATE depot_stocks SET amount = amount + ?, buytime = UNIX_TIMESTAMP(), comment = ? WHERE userid = ? AND stockid = ?', 
					[amount, query.comment, user.id, r.id], this.qcb(function() {
					cb('stock-buy-success');
				}));
			}
		}));
	});
}

exports.StocksDB = StocksDB;

})();
