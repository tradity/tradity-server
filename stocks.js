(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var lapack = require('lapack');
var assert = require('assert');
require('datejs');

function StocksDB (db, cfg, quoteLoader) {
	this.db = db;
	this.quoteLoader = quoteLoader;
	this.cfg = cfg;
	this.leaderMatrix = null;
	this.lastCallbackDay = null;
	this.dqueries = null; // filled in by dqueries object when activated
	this.regularCallbackActive = false;
	this.stockNeeders = [];
	
	this.regularCallback();
	this.quoteLoader.on('record', _.bind(function(rec) {
		this.updateRecord(rec);
	}, this));
}
util.inherits(StocksDB, require('./objects.js').DBSubsystemBase);

StocksDB.prototype.stocksFilter = function(rec) {
	return _.chain(this.cfg.stockExchanges).keys().contains(rec.exchange).value();
}

StocksDB.prototype.regularCallback = function(cb) {
	cb = cb || function() {};
	if (this.regularCallbackActive) {
		this.emit('error', 'Regular callback overlapping in StockDB – might be pretty serious (please restart server)!');
		return cb();
	}
		
	this.regularCallbackActive = true;
	
	this.cleanUpUnusedStocks(_.bind(function() {
	this.updateStockValues(_.bind(function() {
	this.updateLeaderMatrix(_.bind(function() {
	this.updateRanking(_.bind(function() {
		var d = new Date();
		if (d.getUTCDay() != this.lastCallbackDay && d.getUTCHours() >= this.cfg.dailyCallbackHour) {
			this.lastCallbackDay = d.getUTCDay();
			this.dailyCallback(_.bind(function() {
				cb();
				this.regularCallbackActive = false;
			}, this));
		} else {
			cb();
			this.regularCallbackActive = false;
		}
	}, this));
	}, this));
	}, this));
	}, this));
}

StocksDB.prototype.updateRanking = function(cb) {
	cb = cb || function() {};
	
	this.query('SET @rank := 0; REPLACE INTO ranking(`type`,uid,rank) SELECT "general", id, @rank := @rank + 1 FROM users ORDER BY totalvalue DESC', [], function() {
	this.query('DELETE va FROM valuehistory AS va JOIN valuehistory AS vb ON va.userid=vb.userid AND va.time > vb.time AND va.time < vb.time + 86400*2 AND FLOOR(va.time/86400)=FLOOR(vb.time/86400) WHERE va.time < UNIX_TIMESTAMP() - 3*86400', [], function() {
	this.query('INSERT INTO valuehistory(userid,value,time) SELECT id,totalvalue,UNIX_TIMESTAMP() FROM users WHERE deletiontime IS NULL', [], cb);
	});
	});
}

StocksDB.prototype.dailyCallback = function(cb) {
	cb = cb || function() {};
	
	this.query('UPDATE depot_stocks AS ds, stocks AS s SET ds.provision_hwm = s.lastvalue WHERE ds.stockid = s.id', [], function() {
	this.query('UPDATE stocks AS s SET s.daystartvalue = s.lastvalue', [], function() {
	if (new Date().getUTCDay() == this.cfg.weeklyCallbackDay)
		this.weeklyCallback(cb);
	else
		cb();
	});
	});
}

StocksDB.prototype.weeklyCallback = function(cb) {
	this.query('UPDATE stocks AS s SET s.weekstartvalue = s.lastvalue', [], cb);
}

StocksDB.prototype.cleanUpUnusedStocks = function(cb) {
	cb = cb || function() {};
	
	this.query('DELETE FROM depot_stocks WHERE amount = 0', [], function() {
		this.query('DELETE FROM recent_searches', [], function() {
		this.query('DELETE FROM stocks WHERE ' +
			'(SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.stockid = stocks.id) = 0 AND UNIX_TIMESTAMP()-stocks.lrutime > ? AND leader IS NULL', [this.cfg.lrutimeLimit],
			cb);
		});
	});
}

StocksDB.prototype.updateStockValues = function(cb) {
	this.query('SELECT * FROM stocks WHERE leader IS NULL AND UNIX_TIMESTAMP()-lastchecktime > ?', [this.cfg.refetchLimit], function(res) {
		var stocklist = _.pluck(res, 'stockid');
		
		_.each(this.stockNeeders, function(needer) {
			stocklist = _.union(stocklist, needer.getNeededStocks());
		});
		
		if (stocklist.length > 0)
			this.quoteLoader.loadQuotes(stocklist, _.bind(this.stocksFilter, this));
		cb();
	});
}

StocksDB.prototype.updateRecord = function(rec) {
	assert.notStrictEqual(rec.lastTradePrice, null);
	if (rec.lastTradePrice == 0) // happens with API sometimes.
		return;
	
	this.query('INSERT INTO stocks (stockid, lastvalue, ask, bid, lastchecktime, lrutime, leader, name, exchange) VALUES '+
		'(?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), NULL, ?, ?) ON DUPLICATE KEY ' +
		'UPDATE lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), name = IF(LENGTH(name) > LENGTH(?), name, ?), exchange = ?',
		[rec.symbol, rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.exchange,
		 rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.name, rec.exchange], function() {
			this.emit('push', {
				'type': 'stock-update',
				'stockid': rec.symbol,
				'lastvalue': rec.lastTradePrice * 10000,
				'ask': rec.ask * 10000,
				'bid': rec.bid * 10000,
				'name': rec.name,
				'leader': null,
				'leadername': null,
				'exchange': rec.exchange
			});
		}
	);
}

StocksDB.prototype.searchStocks = function(query, user, access, cb) {
	var str = query.name;
	
	var handleResults = _.bind(function(results) {
		results = _.uniq(results, false, function(r) { return r.stockid; });
		var symbols = _.pluck(results, 'stockid');
		symbols = _.map(symbols, escape);
		this.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE symbol IN ("' + _.map(symbols, _.bind(this.db.escape, this.db)).join('","') + '")');
		cb('stock-search-success', results);
	}, this);
	
	var leadertest = str.match(/__LEADER_(\d+)__/);
	var lid = -1;
	if (leadertest !== null)
		lid = leadertest[1];
	
	var xstr = '%' + str.replace(/%/, '\\%') + '%';
	this.query('SELECT stocks.stockid AS stockid,stocks.lastvalue AS lastvalue,stocks.ask AS ask,stocks.bid AS bid,stocks.leader AS leader,users.name AS leadername FROM stocks JOIN users ON stocks.leader = users.id WHERE users.name LIKE ? OR users.id = ?', [xstr, lid], function(res1) {
	this.query('SELECT * FROM stocks WHERE (name LIKE ? OR stockid LIKE ?) AND leader IS NULL', [xstr, xstr], function(res2) {
	this.query('SELECT * FROM recent_searches WHERE string = ?', [str], function(rs_res) {
	if (rs_res.length == 0) {
		this.quoteLoader.searchAndFindQuotes(str, _.bind(this.stocksFilter, this), _.bind(function(res3) {
			this.query('INSERT INTO recent_searches (string) VALUES(?)', [str], function() {
				var results = _.union(res1, res2, _.map(res3, function(r) {
					return {
						'stockid': r.symbol,
						'lastvalue': r.lastTradePrice * 10000,
						'ask': r.ask * 10000,
						'bid': r.bid * 10000,
						'name': r.name,
						'exchange': r.exchange,
						'leader': null,
						'leadername': null
					};
				}));
				handleResults(results);
			});
		}, this));
	} else {
		handleResults(_.union(res1, res2));
	}
	});
	});
	});
}

StocksDB.prototype.updateLeaderMatrix = function(cb) {
	cb = cb || function() {};
	
	this.query('SELECT users.id AS uid, users.name AS uname, COUNT(s.stockid) AS scount FROM users LEFT JOIN stocks AS s ON s.leader = users.id WHERE users.deletiontime IS NULL GROUP BY uid ORDER BY scount ASC', [], function(res) {
	var insvalues = [];
	for (var i = 0; i < res.length && res[i].scount == 0; ++i) 
		insvalues.push('("__LEADER_' + parseInt(res[i].uid) + '__", ' + parseInt(res[i].uid) + ', "leader:' + this.db.escape(res[i].uname) + '")');

	this.query(insvalues.length ? 'INSERT INTO stocks (stockid, leader, name) VALUES' + insvalues.join(',') : 'SELECT 709803442861291314641', [], function() {
	
	this.query('SELECT userid AS uid FROM depot_stocks UNION SELECT leader AS uid FROM stocks WHERE leader IS NOT NULL', [], function(users) {
	this.query(
		'SELECT ds.userid AS uid, SUM(ds.amount * s.lastvalue) AS valsum, freemoney FROM depot_stocks AS ds LEFT JOIN stocks AS s ' +
		'ON s.leader IS NULL AND s.id = ds.stockid LEFT JOIN users ON ds.userid = users.id GROUP BY uid ' +
		'UNION SELECT id AS uid, 0 AS valsum, freemoney AS freemoney FROM users WHERE deletiontime IS NULL AND (SELECT COUNT(*) FROM depot_stocks WHERE userid=users.id)=0', [], function(res_static) {
	this.query('SELECT s.leader AS luid, ds.userid AS fuid, ds.amount AS amount ' +
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.leader IS NOT NULL AND s.id = ds.stockid', [], function(res_leader) {
		users = _.uniq(_.pluck(users, 'uid'));
		var users_inv = [];
		for (var k = 0; k < users.length; ++k)
			users_inv[users[k]] = k;
				
		var n = users.length;
		if (n == 0)
			return cb();
		
		var A = _.map(_.range(n), function(i) {
			return _.map(_.range(n), function(j) { return i == j ? 1.0 : 0.0; });
		});
		
		var B = _.map(_.range(n), function() { return [0.0]; });
		
		for (var k = 0; k < res_static.length; ++k) {
			var uid = res_static[k].uid;
			if (typeof (users_inv[uid]) == 'undefined' || users_inv[uid] >= n) {
				this.emit('error', new Error('unknown user ID in res_static: ' + uid));
				return;
			}
			
			if (res_static[k].valsum === null) // happens when one invests only in leaders
				res_static[k].valsum = 0;
			
			B[users_inv[uid]] = [res_static[k].valsum + res_static[k].freemoney];
		}
		
		for (var k = 0; k < res_leader.length; ++k) {
			var l = users_inv[res_leader[k].luid]; // leader
			var f = users_inv[res_leader[k].fuid]; // follower
			var amount = res_leader[k].amount;
			
			A[f][l] -= amount / this.cfg.leaderValueShare;
		}
		
		/*console.log(A, B);*/
		var res = lapack.sgesv(A, B);
		if (!res) {
			this.emit('error', new Error('SLE solution not found for\nA = ' + A + '\nB = ' + B));
			return;
		}
		
		var X = _.pluck(res.X, 0);
		
		var complete = 0;
		for (var i = 0; i < n; ++i) {
			_.bind(_.partial(function(i) {
			assert.notStrictEqual(X[i], null);
			assert.equal(X[i], X[i]); // If you don't understand this, search the www for good JS books and buy one.
			this.query('UPDATE stocks SET lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?', [X[i] / 100, X[i] / 100, X[i] / 100, users[i]], function() {
			this.query('UPDATE users SET totalvalue = ? WHERE id = ?', [X[i], users[i]], function() {
				this.query('SELECT stockid, lastvalue, ask, bid, stocks.name AS name, leader, users.name AS leadername FROM stocks JOIN users ON leader = users.id WHERE leader = ?',
					[users[i]], function(res) {
					assert.equal(res.length, 1);
					res[0].type = 'stock-update';
					this.emit('push', res[0]);
					
					if (++complete == n) {
						var max = 'GREATEST(ds.provision_hwm, s.lastvalue)';
						var Δ = '(('+max+' - ds.provision_hwm) * ds.amount)';
						var fees = '(('+Δ+' * f.provision) / 100)';
						this.query('UPDATE stocks AS s,depot_stocks AS ds,users AS f, users AS l ' +
						'SET ds.provision_hwm = '+max+', f.freemoney = f.freemoney - '+fees+', l.freemoney = l.freemoney + '+fees+' '+
						'WHERE ds.userid = f.id AND ds.stockid = s.id AND s.leader = l.id AND f.id != l.id', [], cb);
					}
				});
			});
			});
			}, i), this)();
		}
	});
	});
	});
	});
	});
}

StocksDB.prototype.stockExchangeIsOpen = function(sxname) {
	var sxdata = this.cfg.stockExchanges[sxname];
	if (!sxdata) {
		this.emit('error', new Error('Unknown SX: ' + sxname));
		return false;
	}

	var opentime = Date.parse(sxdata.open).getTime();
	var closetime = Date.parse(sxdata.close).getTime();
	var now = new Date();
	return now.getTime() >= opentime && now.getTime() < closetime && _.indexOf(sxdata.days, now.getUTCDay()) != -1;
}

StocksDB.prototype.buyStock = function(query, user, access, cb) {
	if ((!query.stockid && query.leader == null) || (query.stockid && query.leader)) 
		return cb('format-error');
	
	if (query.leader != null)
		query.stockid = '__LEADER_' + query.leader + '__';
	
	this.query('SELECT s.*, SUM(ds.amount) AS amount FROM stocks AS s LEFT JOIN depot_stocks AS ds ON ds.userid = ? AND ds.stockid = s.id WHERE s.stockid = ? GROUP BY s.id', [user.id, query.stockid], function(res) {
		if (res.length == 0 || res[0].lastvalue == 0)
			return cb('stock-buy-stock-not-found');
		var r = res[0];
		if (!r.leader && !this.stockExchangeIsOpen(r.exchange) && !(access.indexOf('*') != -1 && query.forceNow)) {
			this.dqueries.addDelayedQuery({
				condition: 'stock::' + r.stockid + '::exchange-open > 0',
				query: query
			}, user, access);
			return cb('stock-buy-autodelay-sxnotopen');
		}
		
		var ta_value = query.amount > 0 ? r.ask : r.bid;
		
		var amount = parseInt(query.amount);
		if (amount < -r.amount)
			return cb('stock-buy-not-enough-stocks');
		// re-fetch freemoney because the 'user' object might come from dquery
		this.query('SELECT freemoney FROM users WHERE id = ?', [user.id], function(ures) {
		assert.equal(ures.length, 1);
		var price = amount * ta_value;
		if (price > ures[0].freemoney && price >= 0)
			return cb('stock-buy-out-of-money');
		var fee = Math.max(Math.abs(this.cfg['transaction-fee-perc'] * price), this.cfg['transaction-fee-min']);

		this.query('INSERT INTO orderhistory (userid, stocktextid, leader, money, comment, buytime, amount, fee) VALUES(?,?,?,?,?,UNIX_TIMESTAMP(),?,?)', [user.id, r.stockid, r.leader, price, query.comment, amount, fee], function(oh_res) {
		this.feed({'type': 'trade','targetid':oh_res.insertId,'srcuser':user.id});
		var tradeID = oh_res.insertId;
		this.query('UPDATE users SET freemoney = freemoney-(?),totalvalue = totalvalue-(?) WHERE id = ?', [price+fee, fee, user.id], function() {
		if (r.amount == null) {
			this.query('INSERT INTO depot_stocks (userid, stockid, amount, buytime, buymoney, provision_hwm, comment) VALUES(?,?,?,UNIX_TIMESTAMP(),?,?,?)', 
				[user.id, r.id, amount, price, ta_value, query.comment], function() {
				cb('stock-buy-success', fee, tradeID);
			});
		} else {
			this.query('UPDATE depot_stocks SET amount = amount + ?, buytime = UNIX_TIMESTAMP(), buymoney = buymoney + ?, comment = ? WHERE userid = ? AND stockid = ?', 
				[amount, price, query.comment, user.id, r.id], function() {
				cb('stock-buy-success', fee, tradeID);
			});
		}
		});
		});
		});
	});
}

StocksDB.prototype.commentTrade = function(query, user, access, cb) {
	this.query('SELECT COUNT(*) AS c FROM orderhistory WHERE orderid=?', [query.tradeid], function(res) {
		assert.equal(res.length, 0);
		if (res[0].c == 0)
			cb('trade-comment-notfound');
		else this.query('INSERT INTO tcomments (tradeid, commenter, comment, time) VALUES(?, ?, ?, UNIX_TIMESTAMP())', 
			[], function(res) {
			this.feed({'type': 'trade','targetid':res.insertId,'srcuser':user.id});
			cb('trade-comment-success');
		});
	});
}

StocksDB.prototype.stocksForUser = function(user, cb) {
	this.query('SELECT amount, buytime, buymoney, comment, s.stockid AS stockid, lastvalue, ask, bid, lastvalue * amount AS total, weekstartvalue, daystartvalue, users.id AS leader, users.name AS leadername, exchange, s.name, IF(leader IS NULL, s.name, CONCAT("Leader: ", users.name)) AS stockname '+
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.id = ds.stockid LEFT JOIN users ON s.leader = users.id WHERE userid = ? AND amount != 0',
		[user.id], cb);
}

StocksDB.prototype.getTradeInfo = function(query, user, access, cb) {
	this.query('SELECT oh.*,s.*,u.name FROM orderhistory AS oh '+
		'LEFT JOIN stocks AS s ON s.leader = oh.leader '+
		'LEFT JOIN users AS u ON u.id = oh.leader WHERE oh.id = ?', [query.tradeid], function(oh_res) {
		if (oh_res.length == 0)
			return cb('get-trade-info-notfound');
		this.query('SELECT c.*,u.name FROM tcomments AS c LEFT JOIN users AS u ON c.commenter = u.id WHERE c.tradeid = ?', [query.tradeid], function(comments) {
			cb('get-trade-info-succes', oh_res[0], comments);
		});
	});
}

exports.StocksDB = StocksDB;

})();
