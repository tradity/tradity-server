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
	this.dqueries = null; // filled in by dqueries object when activated
	this.stockNeeders = [];
	
	var d = new Date();
	
	this.regularCallback({});
	this.quoteLoader.on('record', _.bind(function(rec) {
		this.updateRecord(rec);
	}, this));
}
util.inherits(StocksDB, require('./objects.js').DBSubsystemBase);

StocksDB.prototype.stocksFilter = function(rec) {
	return _.chain(this.cfg.stockExchanges).keys().contains(rec.exchange).value() && rec.currency_name == 'EUR';
}

StocksDB.prototype.regularCallback = function(query, cb) {
	cb = cb || function() {};
		
	var rcbST = new Date().getTime();
	
	var xcb = _.bind(function() { 		
		var rcbET = new Date().getTime();
		console.log('StocksDB rcb in ' + (rcbET - rcbST) + ' ms');
		cb();
	}, this);
	
	this.cleanUpUnusedStocks(_.bind(function() {
	this.updateStockValues(_.bind(function() {
	this.updateLeaderMatrix(_.bind(function() {
		var provcb = _.bind(function() {
			this.updateRanking();
			
			if (query.weekly) {
				this.weeklyCallback(_.bind(function() {
					this.dailyCallback(xcb);
				}, this));
			} if (query.daily) {
				this.dailyCallback(xcb);
			} else {
				xcb();
			}
		}, this);
		
		if (query.provisions)
			this.updateProvisions(provcb);
		else
			provcb();
	}, this));
	}, this));
	}, this));
}

StocksDB.prototype.updateRanking = function(cb_) {
	cb_ = cb_ || function() {};
	
	this.query('UPDATE users SET '+
		'dayfperfcur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id WHERE userid=users.id AND leader IS NOT NULL), ' +
		'dayoperfcur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id WHERE userid=users.id AND leader IS NULL)', [], function() {

	this.locked(['ranking'], _.bind(function() { this.updateValueHistory(cb_); }, this), function(cb) {
	this.query('TRUNCATE TABLE ranking', [], function() {
	this.query('SET @rank1 := 0; REPLACE INTO ranking(`type`,uid,rank) SELECT "general",   id, @rank1 := @rank1 + 1 FROM users WHERE deletiontime IS NULL AND email_verif != 0 ORDER BY tradecount > 0 DESC, totalvalue - wprov_sum - lprov_sum DESC', [], function() {
	this.query('SET @rank2 := 0; REPLACE INTO ranking(`type`,uid,rank) SELECT "following", id, @rank2 := @rank2 + 1 FROM users WHERE deletiontime IS NULL AND email_verif != 0 AND totalfperfbase != 0 ORDER BY tradecount > 0 DESC, (dayfperfcur+totalfperfsold-totalfperfbase)/GREATEST(700000000, totalvalue) DESC', [], function() {
	this.query('SET @rank3 := 0; REPLACE INTO ranking(`type`,uid,rank) SELECT "general-wprov", id, @rank3 := @rank3 + 1 FROM users WHERE deletiontime IS NULL AND email_verif != 0 ORDER BY tradecount > 0 DESC, totalvalue DESC', [], function() {
	this.query('SET @rank4 := 0; REPLACE INTO ranking(`type`,uid,rank) SELECT "general-week",   id, @rank4 := @rank4 + 1 FROM users WHERE deletiontime IS NULL AND email_verif != 0 ORDER BY tradecount > 0 DESC, (totalvalue - wprov_sum - lprov_sum) / (weekstarttotalvalue - weekstartprov_sum) DESC', [], function() {
	this.query('SET @rank5 := 0; REPLACE INTO ranking(`type`,uid,rank) SELECT "following-week", id, @rank5 := @rank5 + 1 FROM users WHERE deletiontime IS NULL AND email_verif != 0 AND totalfperfbase != 0 ORDER BY tradecount > 0 DESC, (dayfperfcur+weekfperfsold-weekfperfbase)/GREATEST(700000000, weekstarttotalvalue) DESC', [], cb);
	});});});});});
	});
	
	});	
}

StocksDB.prototype.updateValueHistory = function(cb) {
	this.query('INSERT INTO valuehistory(userid,value,time) SELECT id,totalvalue,UNIX_TIMESTAMP() FROM users WHERE deletiontime IS NULL', [], cb);
}

StocksDB.prototype.dailyCallback = function(cb) {
	cb = cb || function() {};

	this.query('DELETE va FROM valuehistory AS va JOIN valuehistory AS vb ON va.userid=vb.userid AND va.time > vb.time AND va.time < vb.time + 86400*2 AND FLOOR(va.time/86400)=FLOOR(vb.time/86400) WHERE va.time < UNIX_TIMESTAMP() - 14*86400', [], function() {
	this.query('DELETE va FROM valuehistory AS va JOIN valuehistory AS vb ON va.userid=vb.userid AND va.time > vb.time AND va.time < vb.time + 21600*2 AND FLOOR(va.time/21600)=FLOOR(vb.time/21600) WHERE va.time < UNIX_TIMESTAMP() -  6*86400', [], function() {
	this.query('DELETE va FROM valuehistory AS va JOIN valuehistory AS vb ON va.userid=vb.userid AND va.time > vb.time AND va.time < vb.time +  1200*2 AND FLOOR(va.time/ 1200)=FLOOR(vb.time/ 1200) WHERE va.time < UNIX_TIMESTAMP() -  1*86400', [], function() {
	this.query('UPDATE stocks SET daystartvalue = bid', [], function() {
	this.query('UPDATE users SET dayfperfbase = dayfperfcur, dayoperfbase = dayoperfcur, dayfperfsold = 0, dayoperfsold = 0, daystarttotalvalue = totalvalue', [], cb);
	});
	});});});
}

StocksDB.prototype.weeklyCallback = function(cb) {
	this.query('UPDATE users SET weekfperfbase = dayfperfbase, weekoperfbase = dayoperfbase, weekfperfsold = 0, weekoperfsold = 0, weekstarttotalvalue = totalvalue, weekstartprov_sum = wprov_sum + lprov_sum', [], function() {
	this.query('UPDATE stocks SET weekstartvalue = bid', [], cb);
	});
}

StocksDB.prototype.cleanUpUnusedStocks = function(cb) {
	cb = cb || function() {};
	
	this.query('DELETE FROM depot_stocks WHERE amount = 0', [], function() {
		this.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE ' +
			'(SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.stockid = stocks.id) != 0 OR ' +
			'(SELECT COUNT(*) FROM watchlists AS w WHERE w.watched = stocks.id) != 0 OR ' +
			'leader IS NOT NULL', [this.cfg.lrutimeLimit],
			cb);
	});
}

StocksDB.prototype.updateStockValues = function(cb) {
	this.query('SELECT * FROM stocks WHERE leader IS NULL AND UNIX_TIMESTAMP()-lastchecktime > ? AND UNIX_TIMESTAMP()-lrutime < ?',
		[this.cfg.lrutimeLimit, this.cfg.refetchLimit], function(res) {
		var stocklist = _.pluck(res, 'stockid');
		
		_.each(this.stockNeeders, function(needer) {
			stocklist = _.union(stocklist, needer.getNeededStocks());
		});
		stocklist = _.filter(stocklist, function(s) {
			return !/__LEADER_(\d+)__/.test(s);
		});
		
		if (stocklist.length > 0)
			this.quoteLoader.loadQuotes(stocklist, _.bind(this.stocksFilter, this));
		cb();
	});
}

StocksDB.prototype.updateRecord = function(rec) {
	if (rec.failure)
		return;
	
	assert.notEqual(rec.lastTradePrice, null);
	if (rec.lastTradePrice == 0) // happens with API sometimes.
		return;
	
	this.query('INSERT INTO stocks (stockid, lastvalue, ask, bid, lastchecktime, lrutime, leader, name, exchange, pieces) VALUES '+
		'(?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), NULL, ?, ?, ?) ON DUPLICATE KEY ' +
		'UPDATE lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), name = IF(LENGTH(name) > LENGTH(?), name, ?), exchange = ?, pieces = ?',
		[rec.symbol, rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.exchange, rec.pieces,
		 rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.name, rec.exchange, rec.pieces], function() {
			this.emit('push', {
				'type': 'stock-update',
				'stockid': rec.symbol,
				'lastvalue': rec.lastTradePrice * 10000,
				'ask': rec.ask * 10000,
				'bid': rec.bid * 10000,
				'name': rec.name,
				'leader': null,
				'leadername': null,
				'exchange': rec.exchange,
				'pieces': rec.pieces
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
	this.query('SELECT stocks.stockid AS stockid,stocks.lastvalue AS lastvalue,stocks.ask AS ask,stocks.bid AS bid,stocks.leader AS leader,users.name AS leadername,wprovision,lprovision FROM stocks JOIN users ON stocks.leader = users.id WHERE users.name LIKE ? OR users.id = ?', [xstr, lid], function(res1) {
	this.query('SELECT *, 0 AS wprovision, 0 AS lprovision FROM stocks WHERE (name LIKE ? OR stockid LIKE ?) AND leader IS NULL', [xstr, xstr], function(res2) {
		var externalSearchResultHandler = _.bind(function(res3) {
			var results = _.union(res1, _.map(res3, function(r) {
				return {
					'stockid': r.symbol,
					'lastvalue': r.lastTradePrice * 10000,
					'ask': r.ask * 10000,
					'bid': r.bid * 10000,
					'name': r.name,
					'exchange': r.exchange,
					'leader': null,
					'leadername': null,
					'wprovision': 0,
					'lprovision': 0,
					'pieces': r.pieces
				};
			}));
			handleResults(results);
		}, this);
		
		var externalStocks = _.pluck(res2, 'stockid');

		if ([12,6].indexOf(str.length) != -1)
			externalStocks.push(str.toUpperCase());
		
		if (externalStocks.length == 0)
			externalSearchResultHandler([]);
		else
			this.quoteLoader.loadQuotesList(externalStocks, _.bind(this.stocksFilter, this), externalSearchResultHandler);
	});
	});
}

var wprovMax = 'GREATEST(ds.provision_hwm, s.bid)';
var wprovΔ = '(('+wprovMax+' - ds.provision_hwm) * ds.amount)';
var wprovFees = '(('+wprovΔ+' * l.wprovision) / 100)';
var lprovMin = 'LEAST(ds.provision_lwm, s.bid)';
var lprovΔ = '(('+lprovMin+' - ds.provision_lwm) * ds.amount)';
var lprovFees = '(('+lprovΔ+' * l.lprovision) / 100)';

StocksDB.prototype.updateProvisions = function (cb_) {
	this.locked(['depotstocks'], cb_, function(cb) {
	
	this.getConnection(function (conn) {
	conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT', [], function() {
		
		conn.query('SELECT ' +
			'ds.depotentryid AS dsid, '+
			wprovFees+' AS wfees, '+wprovMax+' AS wmax, '+
			lprovFees+' AS lfees, '+lprovMin+' AS lmin, '+
			'f.id AS fid, l.id AS lid '+
			'FROM depot_stocks AS ds JOIN stocks AS s ON s.id = ds.stockid '+
			'JOIN users AS f ON ds.userid = f.id JOIN users AS l ON s.leader = l.id AND f.id != l.id', [],
		function(dsr) {
			if (!dsr.length) return cb();
			var complete = 0;
			for (var j = 0; j < dsr.length; ++j) {
				_.bind(_.partial(function(j) {
					assert.ok(dsr[j].wfees >= 0);
					assert.ok(dsr[j].lfees <= 0);
					
					var dsid = dsr[j].dsid;
					var totalfees = dsr[j].wfees + dsr[j].lfees;
					
					conn.query('UPDATE depot_stocks SET ' +
						'provision_hwm = ?, wprov_sum = wprov_sum + ? ' +
						'provision_lwm = ?, lprov_sum = lprov_sum + ? ' +
						'WHERE depotentryid = ?', [dsr[j].wmax, dsr[j].wfees, dsr[j].lmin, dsr[j].lfees, dsr[j].dsid], function() {
					conn.query('UPDATE users SET freemoney = freemoney - ?, totalvalue = totalvalue - ? WHERE id = ?', [totalfees, totalfees, dsr[j].fid], function() {
					conn.query('UPDATE users SET freemoney = freemoney + ?, totalvalue = totalvalue + ?, wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? WHERE id = ?',
						[totalfees, totalfees, dsr[j].wfees, dsr[j].lfees, dsr[j].lid], function() {
						if (++complete == dsr.length) 
							conn.query('COMMIT', [], function() {
								conn.release();
								cb();
							});
					});
					});
					});
				}, j), this)();
			}
		});
	});
	});
	});
}

StocksDB.prototype.updateLeaderMatrix = function(cb_) {
	this.locked(['depotstocks'], cb_, function(cb) {
	
	this.getConnection(function (conn) {
	conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT', [], function() {
	conn.query('SELECT userid AS uid FROM depot_stocks UNION SELECT leader AS uid FROM stocks WHERE leader IS NOT NULL', [], function(users) {
	conn.query(
		'SELECT ds.userid AS uid, SUM(ds.amount * s.bid) AS valsum, SUM(ds.amount * s.ask) AS askvalsum, freemoney, users.wprov_sum + users.lprov_sum AS prov_sum FROM depot_stocks AS ds LEFT JOIN stocks AS s ' +
		'ON s.leader IS NULL AND s.id = ds.stockid LEFT JOIN users ON ds.userid = users.id GROUP BY uid ' +
		'UNION SELECT id AS uid, 0 AS askvalsum, 0 AS valsum, freemoney, wprov_sum + lprov_sum AS prov_sum FROM users WHERE (SELECT COUNT(*) FROM depot_stocks WHERE userid=users.id)=0', [], function(res_static) {
	conn.query('SELECT s.leader AS luid, ds.userid AS fuid, ds.amount AS amount ' +
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
		
		var B = _.map(_.range(n), function() { return [0.0, 0.0]; });
		var prov_sum = _.map(_.range(n), function() { return [0.0]; });
		
		for (var k = 0; k < res_static.length; ++k) {
			var uid = res_static[k].uid;
			if (typeof (users_inv[uid]) == 'undefined' || users_inv[uid] >= n) {
				this.emit('error', new Error('unknown user ID in res_static: ' + uid));
				return;
			}
			
			if (res_static[k].valsum === null) // happens when one invests only in leaders
				res_static[k].valsum = 0;
			
			B[users_inv[uid]] = [
				res_static[k].valsum    + res_static[k].freemoney - res_static[k].prov_sum,
				res_static[k].askvalsum + res_static[k].freemoney - res_static[k].prov_sum
				];
			prov_sum[users_inv[uid]] = res_static[k].prov_sum;
		}
		
		for (var k = 0; k < res_leader.length; ++k) {
			var l = users_inv[res_leader[k].luid]; // leader
			var f = users_inv[res_leader[k].fuid]; // follower
			var amount = res_leader[k].amount;
			
			A[f][l] -= amount / this.cfg.leaderValueShare;
		}
		
		var sgesvST = new Date().getTime();
		var res = lapack.sgesv(A, B);
		if (!res) {
			this.emit('error', new Error('SLE solution not found for\nA = ' + A + '\nB = ' + B));
			return;
		}
		var sgesvET = new Date().getTime();
		console.log('sgesv in ' + (sgesvET - sgesvST) + ' ms');
		
		var X =  _.pluck(res.X, 0);
		var Xa = _.pluck(res.X, 1);
		//console.log(JSON.stringify(A),JSON.stringify(B),JSON.stringify(users_inv),JSON.stringify(X));

		var complete = 0;
		for (var i = 0; i < n; ++i) {
			_.bind(_.partial(function(i) {
			assert.notStrictEqual(X[i],  null);
			assert.notStrictEqual(Xa[i], null);
			assert.equal(X[i],  X[i]); // If you don't understand this, search the www for good JS books and buy one.
			assert.equal(Xa[i], Xa[i]);
			
			var lv  = X[i] / 100;
			var lva = Math.max(Xa[i] / 100, 10000);
			
			conn.query('UPDATE stocks SET lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), pieces = ? WHERE leader = ?',
				[(lv + lva)/2.0, lva, lv, lv < 10000 ? 0 : 100000000, users[i]], function() {
			conn.query('UPDATE users SET totalvalue = ? WHERE id = ?', [X[i] + prov_sum[i], users[i]], function() {
				conn.query('SELECT stockid, lastvalue, ask, bid, stocks.name AS name, leader, users.name AS leadername FROM stocks JOIN users ON leader = users.id WHERE leader = ?',
					[users[i]], function(res) {
					assert.equal(res.length, 1);
					res[0].type = 'stock-update';
					this.emit('push', res[0]);
					
					//console.log(complete + ' of ' + n);
					if (++complete == n) {
						conn.query('COMMIT', [], function() {
							conn.release();
							cb();
						});
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

StocksDB.prototype.sellAll = function(query, user, access, cb) {
	/* assume lock already present */
	this.query('SELECT s.*, ds.* FROM stocks AS s JOIN depot_stocks AS ds ON ds.stockid = s.id WHERE s.leader = ?', [user.id], function(res) {
		if (res.length == 0)
			return cb();
		
		var complete = 0;
		for (var i = 0; i < res.length; ++i) {
			var depotentry = res[i];
			this.buyStock({
				__override_unlocked__: true,
				amount: -depotentry.amount,
				leader: user.id
			}, {id: depotentry.userid}, access, function() {
				if (++complete == res.length) 
					cb();
			});
		}
	});
};

StocksDB.prototype.buyStock = function(query, user, access, cb_) {
	assert.ok(user);
	assert.ok(access);
	this.locked(query.__override_unlocked__ ? [] : ['depotstocks'], cb_, function(cb) {	
	if (query.leader != null)
		query.stockid = '__LEADER_' + query.leader + '__';
	
	this.query('SELECT s.*, '+
		'SUM(ds.amount) AS amount, '+
		'AVG(s.bid - ds.provision_hwm) AS hwmdiff, '+
		'AVG(s.bid - ds.provision_lwm) AS lwmdiff, '+
		'l.id AS lid, l.wprovision AS wprovision, l.lprovision AS lprovision '+
		'FROM stocks AS s '+
		'LEFT JOIN depot_stocks AS ds ON ds.userid = ? AND ds.stockid = s.id '+
		'LEFT JOIN users AS l ON s.leader = l.id AND ds.userid != l.id '+
		'WHERE s.stockid = ? GROUP BY s.id', [user.id, query.stockid], function(res) {
		if (res.length == 0 || res[0].lastvalue == 0)
			return cb('stock-buy-stock-not-found');
		var r = res[0];
		if (!this.stockExchangeIsOpen(r.exchange) && !(access.has('stocks') && query.forceNow)) {
			query.retainUntilCode = 'stock-buy-success';
			this.dqueries.addDelayedQuery({
				condition: 'stock::' + r.stockid + '::exchange-open > 0',
				query: query,
			}, user, access);
			return cb('stock-buy-autodelay-sxnotopen');
		}
		
		if (r.lid && user.email_verif == 0)
			return cb('stock-buy-email-not-verif');
		
		var amount = parseInt(query.amount);
		if (amount < -r.amount || amount != amount)
			return cb('stock-buy-not-enough-stocks');
		
		var ta_value = amount > 0 ? r.ask : r.bid;
		
		assert.ok(r.ask >= 0);
		
		// re-fetch freemoney because the 'user' object might come from dquery
		this.query('SELECT freemoney, totalvalue FROM users WHERE id = ?', [user.id], function(ures) {
		assert.equal(ures.length, 1);
		var price = amount * ta_value;
		if (price > ures[0].freemoney && price >= 0)
			return cb('stock-buy-out-of-money');
		this.query('SELECT ABS(SUM(amount)) AS amount FROM orderhistory WHERE stocktextid = ? AND userid = ? AND buytime > FLOOR(UNIX_TIMESTAMP()/86400)*86400 AND SIGN(amount) = SIGN(?)',
			[r.name, user.id, r.amount], function(ohr) {
		var tradedToday = ohr[0].amount || 0;
		
		if ((r.amount + amount) * r.bid >= ures[0].totalvalue * this.cfg['maxSinglePaperShare'] && price >= 0)
			return cb('stock-buy-single-paper-share-exceed');
		if (Math.abs(amount) + tradedToday > r.pieces)
			return cb('stock-buy-over-pieces-limit');
		
		if (amount <= 0 && ((r.hwmdiff && r.hwmdiff > 0) || (r.lwmdiff && r.lwmdiff < 0))) {
			var wprovPay = r.hwmdiff * -amount * r.wprovision / 100.0;
			var lprovPay = r.lwmdiff * -amount * r.lprovision / 100.0;
			assert.ok(r.lid != null);
			assert.ok(wprovPay >= 0);
			assert.ok(lprovPay <= 0);
			
			var totalprovPay = wprovPay + lprovPay;
			
			this.query('UPDATE users SET freemoney = freemoney - ?, totalvalue = totalvalue - ? WHERE id = ?', [totalprovPay, totalprovPay, user.id], function() {
				this.query('UPDATE users SET freemoney = freemoney + ?, totalvalue = totalvalue + ?, wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? WHERE id = ?',
					[totalprovPay, totalprovPay, wprovPay, lprovPay, r.lid]);
			});
		}
		
		var fee = Math.max(Math.abs(this.cfg['transaction-fee-perc'] * price), this.cfg['transaction-fee-min']);
		
		this.query('INSERT INTO orderhistory (userid, stocktextid, leader, money, buytime, amount, fee, stockname) VALUES(?,?,?,?,UNIX_TIMESTAMP(),?,?,?)',
			[user.id, r.stockid, r.leader, price, amount, fee, r.name], function(oh_res) {
		this.feed({
			'type': 'trade',
			'targetid':oh_res.insertId,
			'srcuser':user.id,
			'json':{'__delay__': !!ures[0].delayorderhist ? this.cfg.delayOrderHistTime : 0, dquerydata: query.dquerydata || null},
			'feedusers': r.leader ? [r.leader] : []
		});
		var tradeID = oh_res.insertId;
		
		var perfn = r.leader ? 'fperf' : 'operf';
		var perfv = amount >= 0 ? 'base' : 'sold';
		var perfdf = 'day' + perfn + perfv;
		var perfwf = 'week' + perfn + perfv;
		var perftf = 'total' + perfn + perfv;
		
		this.query('UPDATE users SET tradecount = tradecount+1, freemoney = freemoney-(?),totalvalue = totalvalue-(?), '+
			perfdf + '=' + perfdf + ' + ABS(?), ' +
			perfwf + '=' + perfwf + ' + ABS(?), ' +
			perftf + '=' + perftf + ' + ABS(?) ' +
			' WHERE id = ?', [price+fee, fee, price, price, price, user.id], function() {
		if (r.amount == null) {
			this.query('INSERT INTO depot_stocks (userid, stockid, amount, buytime, buymoney, provision_hwm) VALUES(?,?,?,UNIX_TIMESTAMP(),?,?)', 
				[user.id, r.id, amount, price, ta_value], function() {
				cb('stock-buy-success', fee, tradeID);
			});
		} else {
			this.query('UPDATE depot_stocks SET ' +
				'amount = amount + ?, buytime = UNIX_TIMESTAMP(), buymoney = buymoney + ?, ' +
				'provision_hwm = (provision_hwm * amount + ?) / (amount + ?), ' +
				'provision_lwm = (provision_lwm * amount + ?) / (amount + ?) ' +
				'WHERE userid = ? AND stockid = ?', 
				[amount, price, price, amount, price, amount, user.id, r.id], function() {
				cb('stock-buy-success', fee, tradeID);
			});
		}
		});
		});
		});
		});
	});
	});
}

StocksDB.prototype.stocksForUser = function(user, cb) {
	this.query('SELECT '+
		'amount, buytime, buymoney, ds.wprov_sum AS wprov_sum, ds.lprov_sum AS lprov_sum, '+
		's.stockid AS stockid, lastvalue, ask, bid, bid * amount AS total, weekstartvalue, daystartvalue, '+
		'users.id AS leader, users.name AS leadername, exchange, s.name, IF(leader IS NULL, s.name, CONCAT("Leader: ", users.name)) AS stockname '+
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.id = ds.stockid LEFT JOIN users ON s.leader = users.id WHERE userid = ? AND amount != 0',
		[user.id], cb);
}

StocksDB.prototype.getTradeInfo = function(query, user, access, cb) {
	this.query('SELECT oh.*,s.*,u.name,events.eventid AS eventid,trader.delayorderhist FROM orderhistory AS oh '+
		'LEFT JOIN stocks AS s ON s.leader = oh.leader '+
		'LEFT JOIN events ON events.type = "trade" AND events.targetid = oh.orderid '+
		'LEFT JOIN users AS u ON u.id = oh.leader '+
		'LEFT JOIN users AS trader ON trader.id = oh.userid WHERE oh.orderid = ?', [query.tradeid], function(oh_res) {
		if (oh_res.length == 0)
			return cb('get-trade-info-notfound');
		var r = oh_res[0];
		if (r.uid != user.id && !!r.delayorderhist && (new Date().getTime()/1000 - r.buytime < this.cfg.delayOrderHistTime))
			return cb('get-trade-delayed-history');
		this.query('SELECT c.*,u.name AS username,u.id AS uid FROM ecomments AS c LEFT JOIN users AS u ON c.commenter = u.id WHERE c.eventid = ?', [r.eventid], function(comments) {
			cb('get-trade-info-succes', r, comments);
		});
	});
}

exports.StocksDB = StocksDB;

})();
