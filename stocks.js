(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var lapack = require('lapack');
var assert = require('assert');
var UnionFind = require('unionfind');
require('datejs');
var qctx = require('./qctx.js');
var buscomponent = require('./buscomponent.js');

function StocksDB () {
	this.quoteLoader = null;
}
util.inherits(StocksDB, buscomponent.BusComponent);

StocksDB.prototype.onBusConnect = function() {
	var self = this;
	
	this.request({name: 'getStockQuoteLoader'}, function(ql) {
		assert.ok(ql);
		
		self.quoteLoader = ql;
		
		var ctx = new qctx.QContext({parentComponent: self});
		self.quoteLoader.on('record', function(rec) {
			self.updateRecord(ctx, rec);
		});
	});
};

StocksDB.prototype.stocksFilter = function(cfg, rec) {
	return _.chain(cfg.stockExchanges).keys().contains(rec.exchange).value() && rec.currency_name == cfg.requireCurrency;
};

StocksDB.prototype.regularCallback = buscomponent.provide('regularCallbackStocks', ['query', 'ctx', 'reply'], function(query, ctx, cb) {
	var self = this;
	
	cb = cb || function() {};
		
	var rcbST = new Date().getTime();
	
	var xcb = function() {
		var rcbET = new Date().getTime();
		console.log('StocksDB rcb in ' + (rcbET - rcbST) + ' ms');
		cb();
	};
	
	self.cleanUpUnusedStocks(ctx, function() {
	self.updateStockValues(ctx, function() {
	self.updateLeaderMatrix(ctx, function() {
		var provcb = function() {
			self.updateRankingInformation(ctx, function() {
				if (query.weekly) {
					self.weeklyCallback(ctx, function() {
						self.dailyCallback(xcb);
					});
				} if (query.daily) {
					self.dailyCallback(ctx, xcb);
				} else {
					xcb();
				}
			});
		};
		
		if (query.provisions)
			self.updateProvisions(provcb);
		else
			provcb();
	});
	});
	});
});

StocksDB.prototype.updateRankingInformation = function(ctx, cb) {
	var self = this;
	
	cb = cb || function() {};
	
	ctx.query('UPDATE users SET ' +
		'fperf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id WHERE userid=users.id AND leader IS NOT NULL), ' +
		'operf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id WHERE userid=users.id AND leader IS NULL)', [], function() {
		self.updateValueHistory(cb);
	});	
}

StocksDB.prototype.updateValueHistory = function(ctx, cb) {
	var copyFields = 'totalvalue, wprov_sum, lprov_sum, fperf_bought, fperf_cur, fperf_sold, operf_bought, operf_cur, operf_sold';
	ctx.query('INSERT INTO tickshistory (userid, ticks, time) SELECT id, ticks, UNIX_TIMESTAMP() FROM users', [], function() {
		ctx.query('INSERT INTO valuehistory (userid, ' + copyFields + ', time) SELECT id, ' + copyFields + ', UNIX_TIMESTAMP() FROM users WHERE deletiontime IS NULL', [], cb);
	});
}

StocksDB.prototype.dailyCallback = function(ctx, cb) {
	cb = cb || function() {};
	
	ctx.query('UPDATE stocks SET daystartvalue = bid', [], cb);
}

StocksDB.prototype.weeklyCallback = function(ctx, cb) {
	ctx.query('UPDATE stocks SET weekstartvalue = bid', [], cb);
}

StocksDB.prototype.cleanUpUnusedStocks = function(ctx, cb) {
	this.getServerConfig(function(cfg) {
		cb = cb || function() {};
		
		ctx.query('DELETE FROM depot_stocks WHERE amount = 0', [], function() {
			ctx.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE ' +
				'(SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.stockid = stocks.id) != 0 ' +
				'OR (SELECT COUNT(*) FROM watchlists AS w WHERE w.watched = stocks.id) != 0 ' +
				'OR leader IS NOT NULL', [cfg.lrutimeLimit],
				cb);
		});
	});
}

StocksDB.prototype.updateStockValues = function(ctx, cb) {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		ctx.query('SELECT * FROM stocks WHERE leader IS NULL AND UNIX_TIMESTAMP()-lastchecktime > ? AND UNIX_TIMESTAMP()-lrutime < ?',
		[cfg.lrutimeLimit, cfg.refetchLimit], function(res) {
			var stocklist = _.pluck(res, 'stockid');
			
			self.request({name: 'neededStocksDQ'}, function(dqNeededStocks) {
				stocklist = _.union(stocklist, dqNeededStocks);
				
				stocklist = _.filter(stocklist, function(s) {
					return !/^__LEADER_(\d+)__$/.test(s);
				});
				
				if (stocklist.length > 0)
					self.quoteLoader.loadQuotes(stocklist, _.bind(self.stocksFilter, self, cfg));
				cb();
			});
		});
	});
};

var wprovMax = 'GREATEST(ds.provision_hwm, s.bid)';
var wprovΔ = '(('+wprovMax+' - ds.provision_hwm) * ds.amount)';
var wprovFees = '(('+wprovΔ+' * l.wprovision) / 100)';
var lprovMin = 'LEAST(ds.provision_lwm, s.bid)';
var lprovΔ = '(('+lprovMin+' - ds.provision_lwm) * ds.amount)';
var lprovFees = '(('+lprovΔ+' * l.lprovision) / 100)';

StocksDB.prototype.updateProvisions = function (ctx, cb) {
	ctx.getConnection(function (conn) {
	conn.query('SET autocommit = 0; ' +
	'LOCK TABLES depot_stocks AS ds WRITE, users AS l WRITE, users AS f WRITE, stocks AS s READ;', [], function() {
		conn.query('SELECT ' +
			'ds.depotentryid AS dsid, '+
			wprovFees+' AS wfees, '+wprovMax+' AS wmax, '+
			lprovFees+' AS lfees, '+lprovMin+' AS lmin, '+
			'f.id AS fid, l.id AS lid '+
			'FROM depot_stocks AS ds JOIN stocks AS s ON s.id = ds.stockid '+
			'JOIN users AS f ON ds.userid = f.id JOIN users AS l ON s.leader = l.id AND f.id != l.id', [],
		function(dsr) {
			if (!dsr.length) {
				conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;', [], function() { conn.release(); });
				return cb();
			}
			
			var complete = 0;
			for (var j = 0; j < dsr.length; ++j) {
				_.partial(function(j) {
					assert.ok(dsr[j].wfees >= 0);
					assert.ok(dsr[j].lfees <= 0);
					
					var dsid = dsr[j].dsid;
					var totalfees = dsr[j].wfees + dsr[j].lfees;
					
					conn.query('UPDATE depot_stocks AS ds SET ' +
						'provision_hwm = ?, wprov_sum = wprov_sum + ?, ' +
						'provision_lwm = ?, lprov_sum = lprov_sum + ? ' +
						'WHERE depotentryid = ?', [dsr[j].wmax, dsr[j].wfees, dsr[j].lmin, dsr[j].lfees, dsr[j].dsid], function() {
					conn.query('UPDATE users AS f SET freemoney = freemoney - ?, totalvalue = totalvalue - ? WHERE id = ?', [totalfees, totalfees, dsr[j].fid], function() {
					conn.query('UPDATE users AS l SET freemoney = freemoney + ?, totalvalue = totalvalue + ?, wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? WHERE id = ?',
						[totalfees, totalfees, dsr[j].wfees, dsr[j].lfees, dsr[j].lid], function() {
						if (++complete == dsr.length) 
							conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;', [], function() {
								conn.release();
								cb();
							});
					});
					});
					});
				}, j)();
			}
		});
	});
	});
};

StocksDB.prototype.updateLeaderMatrix = function(ctx, cb) {
	var self = this;
	
	var lmuStart = new Date().getTime();
	
	self.getServerConfig(function(cfg) {
	
	ctx.getConnection(function (conn) {
	conn.query('SET autocommit = 0; ' +
		'LOCK TABLES depot_stocks AS ds READ, users WRITE, stocks AS s WRITE;', [], function() {
	conn.query('SELECT ds.userid AS uid FROM depot_stocks AS ds ' +
		'UNION SELECT s.leader AS uid FROM stocks AS s WHERE s.leader IS NOT NULL', [], function(users) {
	conn.query(
		'SELECT ds.userid AS uid, SUM(ds.amount * s.bid) AS valsum, SUM(ds.amount * s.ask) AS askvalsum, ' +
		'freemoney, users.wprov_sum + users.lprov_sum AS prov_sum ' +
		'FROM depot_stocks AS ds ' +
		'LEFT JOIN stocks AS s ON s.leader IS NULL AND s.id = ds.stockid ' +
		'LEFT JOIN users ON ds.userid = users.id ' +
		'GROUP BY uid ', [], function(res_static) {
	conn.query('SELECT id AS uid, 0 AS askvalsum, 0 AS valsum, freemoney, wprov_sum + lprov_sum AS prov_sum ' +
		'FROM users WHERE (SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.userid = users.id) = 0', [], function(res_static2) {
		res_static = res_static.concat(res_static2);
	conn.query('SELECT s.leader AS luid, ds.userid AS fuid, ds.amount AS amount ' +
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.leader IS NOT NULL AND s.id = ds.stockid', [], function(res_leader) {
		users = _.uniq(_.pluck(users, 'uid'));
		
		var users_inv = [];
		for (var k = 0; k < users.length; ++k)
			users_inv[users[k]] = k;
		
		if (users.length == 0)
			return cb();
		
		var complete = 0;
		
		// find connected components
		var uf = new UnionFind(users.length);
		for (var i = 0; i < res_leader.length; ++i)
			uf.union(users_inv[res_leader[i].luid], users_inv[res_leader[i].fuid]);
		
		var components = {};
		for (var i = 0; i < users.length; ++i) {
			if (!components[uf.find(i)])
				components[uf.find(i)] = [users[i]];
			else
				components[uf.find(i)].push(users[i]);
		}
		
		var sgesvTotalTime = 0;
		var updateQuery = '';
		var updateParams = [];
		
		for (var ci_ in components) { (function() {
			var ci = ci_;
			var cusers = components[ci];
			var n = cusers.length;
			
			var cusers_inv = [];
			for (var k = 0; k < cusers.length; ++k)
				cusers_inv[cusers[k]] = k;
			
			var A = _.map(_.range(n), function(i) {
				return _.map(_.range(n), function(j) { return i == j ? 1.0 : 0.0; });
			});
			
			var B = _.map(_.range(n), function() { return [0.0, 0.0]; });
			var prov_sum = _.map(_.range(n), function() { return [0.0]; });
			
			for (var k = 0; k < res_static.length; ++k) {
				var uid = res_static[k].uid;
				if (typeof (cusers_inv[uid]) == 'undefined')
					continue; // not our group
				
				assert.ok(cusers_inv[uid] < n);
				
				if (res_static[k].valsum === null) // happens when one invests only in leaders
					res_static[k].valsum = 0;
				
				B[cusers_inv[uid]] = [
					res_static[k].valsum    + res_static[k].freemoney - res_static[k].prov_sum,
					res_static[k].askvalsum + res_static[k].freemoney - res_static[k].prov_sum
					];
				prov_sum[cusers_inv[uid]] = res_static[k].prov_sum;
			}
			
			for (var k = 0; k < res_leader.length; ++k) {
				var l = cusers_inv[res_leader[k].luid]; // leader
				var f = cusers_inv[res_leader[k].fuid]; // follower
				var amount = res_leader[k].amount;
				
				if (typeof l == 'undefined' || typeof f == 'undefined')
					continue;
				
				A[f][l] -= amount / cfg.leaderValueShare;
			}
			
			var sgesvST = new Date().getTime();
			var res = lapack.sgesv(A, B);
			if (!res) {
				self.emit('error', new Error('SLE solution not found for\nA = ' + A + '\nB = ' + B));
				return;
			}
			var sgesvET = new Date().getTime();
			sgesvTotalTime += sgesvET - sgesvST;
			
			var X =  _.pluck(res.X, 0);
			var Xa = _.pluck(res.X, 1);
			//console.log(JSON.stringify(A),JSON.stringify(B),JSON.stringify(users_inv),JSON.stringify(X));

			for (var i = 0; i < n; ++i) {
				_.bind(function(i) {
				assert.notStrictEqual(X[i],  null);
				assert.notStrictEqual(Xa[i], null);
				assert.equal(X[i],  X[i]);
				assert.equal(Xa[i], Xa[i]);
				assert.ok(cusers[i]);
				
				var lv  = X[i] / 100;
				var lva = Math.max(Xa[i] / 100, 10000);
				
				updateQuery += 'UPDATE stocks AS s SET lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), pieces = ? WHERE leader = ?;';
				updateParams = updateParams.concat([(lv + lva)/2.0, lva, lv, lv < 10000 ? 0 : 100000000, cusers[i]]);
				updateQuery += 'UPDATE users SET totalvalue = ? WHERE id = ?;';
				updateParams = updateParams.concat([X[i] + prov_sum[i], cusers[i]]);
				
				if (++complete == users.length) {
					conn.query(updateQuery + 'COMMIT; UNLOCK TABLES; SET autocommit = 1;', updateParams, function() {
						conn.query('SELECT stockid, lastvalue, ask, bid, stocks.name AS name, leader, users.name AS leadername FROM stocks JOIN users ON leader = users.id WHERE leader IS NOT NULL',
							[users[i]], function(res) {
							conn.release();
							
							var lmuEnd = new Date().getTime();
							console.log('sgesv in ' + sgesvTotalTime + ' ms, lm update in ' + (lmuEnd - lmuStart) + ' ms');
							
							for (var j = 0; j < res.length; ++j) {
								process.nextTick(_.bind(_.partial(function(r) {
									self.emit('stock-update', r);
								}, res[j]), self));
							}
							
							cb();
						});
					});
				}
				}, self, i)();
			}
		})(); }
	});
	});
	});
	});
	});
	});
	
	});
}

StocksDB.prototype.updateRecord = function(ctx, rec) {
	var self = this;
	
	if (rec.failure)
		return;
	
	assert.notEqual(rec.lastTradePrice, null);
	if (rec.lastTradePrice == 0) // happens with API sometimes.
		return;
	
	assert.notStrictEqual(rec.pieces, null);
	
	ctx.query('INSERT INTO stocks (stockid, lastvalue, ask, bid, lastchecktime, lrutime, leader, name, exchange, pieces) VALUES '+
		'(?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), NULL, ?, ?, ?) ON DUPLICATE KEY ' +
		'UPDATE lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), name = IF(LENGTH(name) >= LENGTH(?), name, ?), exchange = ?, pieces = ?',
		[rec.symbol, rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.exchange, rec.pieces,
		 rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.name, rec.exchange, rec.pieces], function() {
			self.emit('stock-update', {
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

StocksDB.prototype.searchStocks = buscomponent.provideQT('client-stock-search', function(query, ctx, cb) {
	var self = this;
	
	this.getServerConfig(function(cfg) {
	var str = query.name;
	if (!str || str.length < 3)
		return cb('stock-search-too-short');
	
	str = str.trim();
	
	var handleResults = function(results) {
		results = _.uniq(results, false, function(r) { return r.stockid; });
		var symbols = _.pluck(results, 'stockid');
		
		if (symbols.length > 0) {
			symbols = _.map(symbols, escape);
			ctx.query('UPDATE stocks SET lrutime = UNIX_TIMESTAMP() WHERE stockid IN (' + _.map(symbols, _.constant('?')).join(',') + ')', symbols);
		}
		
		cb('stock-search-success', {results: results});
	};
	
	var leadertest = str.match(/__LEADER_(\d+)__/);
	var lid = -1;
	if (leadertest !== null)
		lid = leadertest[1];
	
	var xstr = '%' + str.replace(/%/g, '\\%') + '%';
	ctx.query('SELECT stocks.stockid AS stockid, stocks.lastvalue AS lastvalue, stocks.ask AS  ask, stocks.bid AS bid, '+
		'stocks.leader AS leader, users.name AS leadername, wprovision, lprovision '+
		'FROM stocks JOIN users ON stocks.leader = users.id WHERE users.name LIKE ? OR users.id = ?', [xstr, lid], function(res1) {
	ctx.query('SELECT *, 0 AS wprovision, 0 AS lprovision FROM stocks WHERE (name LIKE ? OR stockid LIKE ?) AND leader IS NULL', [xstr, xstr], function(res2) {
		var externalSearchResultHandler = function(res3) {
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
		};
		
		var externalStocks = _.pluck(res2, 'stockid');

		// 12 ~ ISIN, 6 ~ WAN
		if ([12,6].indexOf(str.length) != -1)
			externalStocks.push(str.toUpperCase());
		
		if (externalStocks.length == 0)
			externalSearchResultHandler([]);
		else
			self.quoteLoader.loadQuotesList(externalStocks, _.bind(self.stocksFilter, self, cfg), externalSearchResultHandler);
	});
	});
	});
});

StocksDB.prototype.stockExchangeIsOpen = buscomponent.provide('stockExchangeIsOpen', ['sxname', 'cfg', 'reply'], function(sxname, cfg, cb) {
	assert.ok(sxname);
	assert.ok(cfg);
	
	var sxdata = cfg.stockExchanges[sxname];
	if (!sxdata) {
		this.emit('error', new Error('Unknown SX: ' + sxname));
		return false;
	}

	var opentime = Date.parse(sxdata.open).getTime();
	var closetime = Date.parse(sxdata.close).getTime();
	var now = new Date();
	
	var res = now.getTime() >= opentime && now.getTime() < closetime && _.indexOf(sxdata.days, now.getUTCDay()) != -1;
	if (cb)
		cb(res);
	
	return res;
});

StocksDB.prototype.sellAll = buscomponent.provideQT('sellAll', function(query, ctx, cb) {
	var self = this;
	
	ctx.query('SELECT s.*, ds.* FROM stocks AS s JOIN depot_stocks AS ds ON ds.stockid = s.id WHERE s.leader = ?', [ctx.user.id], function(res) {
		if (res.length == 0)
			return cb();
		
		var complete = 0;
		for (var i = 0; i < res.length; ++i) {
			var depotentry = res[i];
			self.buyStock({
				amount: -depotentry.amount,
				leader: ctx.user.id,
				__force_now__: true
			}, {id: depotentry.userid}, ctx.access, function() {
				if (++complete == res.length) 
					cb();
			});
		}
	});
});

StocksDB.prototype.buyStock = buscomponent.provideQT('client-stock-buy', function(query, ctx, cb) {
	var self = this;
	
	this.getServerConfig(function(cfg) {
	
	assert.ok(ctx.user);
	assert.ok(ctx.access);
	
	if (query.leader != null)
		query.stockid = '__LEADER_' + query.leader + '__';
	
	ctx.getConnection(function(conn) {
	
	conn.query('SET autocommit = 0; ' +
	'LOCK TABLES depot_stocks WRITE, users AS l WRITE, users AS f WRITE, stocks AS s READ, orderhistory WRITE;', [], function() {
	var commit = function() {
		conn.query('COMMIT; UNLOCK TABLES; SET autocommit = 1;', [], function() { conn.release(); });
	};
	
	var rollback = function() {
		conn.query('ROLLBACK; UNLOCK TABLES; SET autocommit = 1;', [], function() { conn.release(); });
	};
		
	conn.query('SELECT s.*, ' +
		'depot_stocks.amount AS amount, ' +
		'depot_stocks.amount * s.lastvalue AS money, ' +
		's.bid - depot_stocks.provision_hwm AS hwmdiff, ' +
		's.bid - depot_stocks.provision_lwm AS lwmdiff, ' +
		'l.id AS lid, l.wprovision AS wprovision, l.lprovision AS lprovision ' +
		'FROM stocks AS s ' +
		'LEFT JOIN depot_stocks ON depot_stocks.userid = ? AND depot_stocks.stockid = s.id ' +
		'LEFT JOIN users AS l ON s.leader = l.id AND depot_stocks.userid != l.id ' +
		'WHERE s.stockid = ?', [ctx.user.id, query.stockid], function(res) {
		if (res.length == 0 || res[0].lastvalue == 0) {
			rollback();
			return cb('stock-buy-stock-not-found');
		}
		
		assert.equal(res.length, 1);
		
		var r = res[0];
		
		var hadDepotStocksEntry = (r.amount !== null);
		
		if (r.money === null)  r.money = 0;
		if (r.amount === null) r.amount = 0;
		
		if (/__LEADER_(\d+)__/.test(query.stockid) && !ctx.access.has('email_verif') && !query.__force_now__) {
			rollback();
			return cb('stock-buy-email-not-verif');
		}
		
		if (!self.stockExchangeIsOpen(r.exchange, cfg) && !(ctx.access.has('stocks') && query.forceNow) && !query.__force_now__) {
			rollback();
			
			if (!query.__is_delayed__) {
				query.retainUntilCode = 'stock-buy-success';
				this.request({name: 'client-dquery', 
					ctx: ctx,
					query: { 
						condition: 'stock::' + r.stockid + '::exchange-open > 0',
						query: query,
					}
				});
				
				return cb('stock-buy-autodelay-sxnotopen');
			} else {
				return cb('stock-buy-sxnotopen');
			}
		}
		
		var amount = parseInt(query.amount);
		if (amount < -r.amount || amount != amount) {
			rollback();
			return cb('stock-buy-not-enough-stocks');
		}
		
		var ta_value = amount > 0 ? r.ask : r.bid;
		
		assert.ok(r.ask >= 0);
		
		// re-fetch freemoney because the 'user' object might come from dquery
		conn.query('SELECT freemoney, totalvalue FROM users AS f WHERE id = ?', [ctx.user.id], function(ures) {
		assert.equal(ures.length, 1);
		var price = amount * ta_value;
		if (price > ures[0].freemoney && price >= 0) {
			rollback();
			return cb('stock-buy-out-of-money');
		}
		
		assert.ok(r.stockid);
		
		conn.query('SELECT ABS(SUM(amount)) AS amount FROM orderhistory WHERE stocktextid = ? AND userid = ? AND buytime > FLOOR(UNIX_TIMESTAMP()/86400)*86400 AND SIGN(amount) = SIGN(?)',
			[r.stockid, ctx.user.id, r.amount], function(ohr) {
		assert.equal(ohr.length, 1);
		
		var tradedToday = ohr[0].amount || 0;
		
		if ((r.amount + amount) * r.bid >= ures[0].totalvalue * cfg['maxSinglePaperShare'] && price >= 0 && !ctx.access.has('stocks')) {
			rollback();
			return cb('stock-buy-single-paper-share-exceed');
		}
		
		if (Math.abs(amount) + tradedToday > r.pieces && !ctx.access.has('stocks') && !query.__force_now__) {
			rollback();
			return cb('stock-buy-over-pieces-limit');
		}
		
		(amount <= 0 && ((r.hwmdiff && r.hwmdiff > 0) || (r.lwmdiff && r.lwmdiff < 0)) && r.lid ? function(cont) {
			var wprovPay = r.hwmdiff * -amount * r.wprovision / 100.0;
			var lprovPay = r.lwmdiff * -amount * r.lprovision / 100.0;

			if (wprovPay < 0) wprovPay = 0;
			if (lprovPay > 0) lprovPay = 0;
			
			var totalprovPay = wprovPay + lprovPay;
			
			conn.query('UPDATE users AS f SET freemoney = freemoney - ?, totalvalue = totalvalue - ? WHERE id = ?', [totalprovPay, totalprovPay, ctx.user.id], function() {
				conn.query('UPDATE users AS l SET freemoney = freemoney + ?, totalvalue = totalvalue + ?, wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? WHERE id = ?',
					[totalprovPay, totalprovPay, wprovPay, lprovPay, r.lid], cont);
			});
		} : function(cont) { cont(); })(function() {
			var fee = Math.max(Math.abs(cfg['transaction-fee-perc'] * price), cfg['transaction-fee-min']);
			
			conn.query('INSERT INTO orderhistory (userid, stocktextid, leader, money, buytime, amount, fee, stockname, prevmoney, prevamount) ' +
				'VALUES(?,?,?,?,UNIX_TIMESTAMP(),?,?,?,?,?)',
				[ctx.user.id, r.stockid, r.leader, price, amount, fee, r.name, r.money, r.amount], function(oh_res) {
			ctx.feed({
				'type': 'trade',
				'targetid': oh_res.insertId,
				'srcuser': ctx.user.id,
				'json': {'__delay__': !!ures[0].delayorderhist ? cfg.delayOrderHistTime : 0, dquerydata: query.dquerydata || null},
				'feedusers': r.leader ? [r.leader] : []
			});
			
			var tradeID = oh_res.insertId;
			
			var perfn = r.leader ? 'fperf' : 'operf';
			var perfv = amount >= 0 ? 'bought' : 'sold';
			var perffull = perfn + '_' + perfv;
			
			conn.query('UPDATE users AS f SET tradecount = tradecount+1, freemoney = freemoney-(?), totalvalue = totalvalue-(?), '+
				perffull + '=' + perffull + ' + ABS(?) ' +
				' WHERE id = ?', [price+fee, fee, price, ctx.user.id], function() {
			if (!hadDepotStocksEntry) {
				assert.ok(amount >= 0);
				
				conn.query('INSERT INTO depot_stocks (userid, stockid, amount, buytime, buymoney, provision_hwm, provision_lwm) VALUES(?,?,?,UNIX_TIMESTAMP(),?,?,?)', 
					[ctx.user.id, r.id, amount, price, ta_value, ta_value], function() {
					commit();
					cb('stock-buy-success', {fee: fee, tradeid: tradeID}, 'repush');
				});
			} else {
				conn.query('UPDATE depot_stocks SET ' +
					'buytime = UNIX_TIMESTAMP(), buymoney = buymoney + ?, ' +
					'provision_hwm = (provision_hwm * amount + ?) / (amount + ?), ' +
					'provision_lwm = (provision_lwm * amount + ?) / (amount + ?), ' +
					'amount = amount + ? ' +
					'WHERE userid = ? AND stockid = ?', 
					[price, price, amount, price, amount, amount, ctx.user.id, r.id], function() {
					commit();
					cb('stock-buy-success', {fee: fee, tradeid: tradeID}, 'repush');
				});
			}
			});
			});
		});
		});
		});
	});
	});
	});
	});
});

StocksDB.prototype.stocksForUser = buscomponent.provideQT('client-list-own-depot', function(query, ctx, cb) {
	ctx.query('SELECT '+
		'amount, buytime, buymoney, ds.wprov_sum AS wprov_sum, ds.lprov_sum AS lprov_sum, '+
		's.stockid AS stockid, lastvalue, ask, bid, bid * amount AS total, weekstartvalue, daystartvalue, '+
		'users.id AS leader, users.name AS leadername, exchange, s.name, IF(leader IS NULL, s.name, CONCAT("Leader: ", users.name)) AS stockname '+
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.id = ds.stockid LEFT JOIN users ON s.leader = users.id WHERE userid = ? AND amount != 0',
		[ctx.user.id], function(results) {
		cb('list-own-depot-success', {'results': results});
	});
});

StocksDB.prototype.getTradeInfo = buscomponent.provideQT('client-get-trade-info', function(query, ctx, cb) {
	this.getServerConfig(function(cfg) {
		ctx.query('SELECT oh.*,s.*,u.name,events.eventid AS eventid,trader.delayorderhist FROM orderhistory AS oh '+
			'LEFT JOIN stocks AS s ON s.leader = oh.leader '+
			'LEFT JOIN events ON events.type = "trade" AND events.targetid = oh.orderid '+
			'LEFT JOIN users AS u ON u.id = oh.leader '+
			'LEFT JOIN users AS trader ON trader.id = oh.userid WHERE oh.orderid = ?', [query.tradeid], function(oh_res) {
			if (oh_res.length == 0)
				return cb('get-trade-info-notfound');
			var r = oh_res[0];
			
			assert.ok(r.userid);
			if (r.userid != ctx.user.id && !!r.delayorderhist && (new Date().getTime()/1000 - r.buytime < cfg.delayOrderHistTime) && !ctx.access.has('stocks'))
				return cb('get-trade-delayed-history');
			ctx.query('SELECT c.*,u.name AS username,u.id AS uid, url AS profilepic, trustedhtml '+
				'FROM ecomments AS c '+
				'LEFT JOIN httpresources ON httpresources.user = c.commenter AND httpresources.role = "profile.image" '+
				'LEFT JOIN users AS u ON c.commenter = u.id WHERE c.eventid = ?', [r.eventid], function(comments) {
				cb('get-trade-info-success', {'trade': r, 'comments': comments});
			});
		});
	});
});

exports.StocksDB = StocksDB;

})();
