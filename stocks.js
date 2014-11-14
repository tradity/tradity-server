(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var lapack = require('lapack');
var assert = require('assert');
var UnionFind = require('unionfind');
require('datejs');
var qctx = require('./qctx.js');
var buscomponent = require('./stbuscomponent.js');

function Stocks () {
	Stocks.super_.apply(this, arguments);
	
	this.quoteLoader = null;
}

util.inherits(Stocks, buscomponent.BusComponent);

Stocks.prototype.onBusConnect = function() {
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

Stocks.prototype.stocksFilter = function(cfg, rec) {
	return _.chain(cfg.stockExchanges).keys().contains(rec.exchange).value() && rec.currency_name == cfg.requireCurrency;
};

Stocks.prototype.regularCallback = buscomponent.provide('regularCallbackStocks', ['query', 'ctx', 'reply'], function(query, ctx, cb) {
	var self = this;
	
	cb = cb || function() {};
	
	if (ctx.getProperty('readonly'))
		return cb();
		
	var rcbST = Date.now();
	
	var xcb = function() {
		var rcbET = Date.now();
		console.log('Stocks rcb in ' + (rcbET - rcbST) + ' ms');
		cb();
	};
	
	self.cleanUpUnusedStocks(ctx, function() {
	self.updateStockValues(ctx, function() {
	self.updateLeaderMatrix(ctx, function() {
		var provcb = function() {
			self.updateRankingInformation(ctx, function() {
				if (query.weekly) {
					self.weeklyCallback(ctx, function() {
						self.dailyCallback(ctx, xcb);
					});
				} else if (query.daily) {
					self.dailyCallback(ctx, xcb);
				} else {
					xcb();
				}
			});
		};
		
		if (query.provisions)
			self.updateProvisions(ctx, provcb);
		else
			provcb();
	});
	});
	});
});

Stocks.prototype.updateRankingInformation = function(ctx, cb) {
	var self = this;
	
	cb = cb || function() {};
	
	ctx.query('UPDATE users_finance SET ' +
		'fperf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id ' +
			'WHERE userid=users_finance.id AND leader IS NOT NULL), ' +
		'operf_cur = (SELECT SUM(ds.amount * s.bid) FROM depot_stocks AS ds JOIN stocks AS s ON ds.stockid = s.id ' +
			'WHERE userid=users_finance.id AND leader IS NULL)', [], function() {
		self.updateValueHistory(ctx, cb);
	});	
}

Stocks.prototype.updateValueHistory = function(ctx, cb) {
	var copyFields = 'totalvalue, wprov_sum, lprov_sum, fperf_bought, fperf_cur, fperf_sold, operf_bought, operf_cur, operf_sold';
	ctx.query('INSERT INTO tickshistory (userid, ticks, time) SELECT id, ticks, UNIX_TIMESTAMP() FROM users');
	
	ctx.query('CREATE TEMPORARY TABLE users_dindex SELECT id, deletiontime FROM users; ' +
		'INSERT INTO valuehistory (userid, ' + copyFields + ', time) SELECT users_finance.id, ' + copyFields + ', UNIX_TIMESTAMP() ' +
		'FROM users_finance JOIN users_dindex ON users_dindex.id = users_finance.id WHERE users_dindex.deletiontime IS NULL; ' +
		'DROP TABLE users_dindex', [], cb);
}

Stocks.prototype.dailyCallback = function(ctx, cb) {
	cb = cb || function() {};
	
	ctx.query('UPDATE stocks SET daystartvalue = bid', [], cb);
}

Stocks.prototype.weeklyCallback = function(ctx, cb) {
	ctx.query('UPDATE stocks SET weekstartvalue = bid', [], cb);
}

Stocks.prototype.cleanUpUnusedStocks = function(ctx, cb) {
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

Stocks.prototype.updateStockValues = function(ctx, cb) {
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

Stocks.prototype.updateProvisions = function (ctx, cb) {
	ctx.getConnection(function (conn, commit) {
	conn.query('SET autocommit = 0; ' +
	'LOCK TABLES depot_stocks AS ds WRITE, users_finance AS l WRITE, users_finance AS f WRITE, ' +
	'stocks AS s READ, transactionlog WRITE;', [], function() {
		conn.query('SELECT ' +
			'ds.depotentryid AS dsid, s.stockid AS stocktextid, ' +
			wprovFees + ' AS wfees, ' + wprovMax + ' AS wmax, ' +
			lprovFees + ' AS lfees, ' + lprovMin + ' AS lmin, ' +
			'ds.provision_hwm, ds.provision_lwm, s.bid, ds.amount, ' +
			'f.id AS fid, l.id AS lid ' +
			'FROM depot_stocks AS ds JOIN stocks AS s ON s.id = ds.stockid ' +
			'JOIN users_finance AS f ON ds.userid = f.id JOIN users_finance AS l ON s.leader = l.id AND f.id != l.id', [],
		function(dsr) {
		if (!dsr.length) {
			commit();
			return cb();
		}
		
		var complete = 0;
		for (var j = 0; j < dsr.length; ++j) { _.partial(function(j) {
			assert.ok(dsr[j].wfees >= 0);
			assert.ok(dsr[j].lfees <= 0);
			dsr[j].wfees = parseInt(dsr[j].wfees);
			dsr[j].lfees = parseInt(dsr[j].lfees);
			
			var dsid = dsr[j].dsid;
			var totalfees = dsr[j].wfees + dsr[j].lfees;
			
			(Math.abs(totalfees) < 1 ? function(cont) { cont(); } : function(cont) {
			conn.query('INSERT INTO transactionlog (orderid, type, stocktextid, a_user, p_user, amount, time, json) VALUES ' + 
				'(NULL, "provision", ?, ?, ?, ?, UNIX_TIMESTAMP(), ?)', 
				[dsr[j].stocktextid, dsr[j].fid, dsr[j].lid, totalfees, JSON.stringify({
					reason: 'regular-provisions',
					provision_hwm: dsr[j].provision_hwm,
					provision_lwm: dsr[j].provision_lwm,
					bid: dsr[j].bid,
					depot_amount: dsr[j].amount
				})],
				cont);
			})(function() {
			conn.query('UPDATE depot_stocks AS ds SET ' +
				'provision_hwm = ?, wprov_sum = wprov_sum + ?, ' +
				'provision_lwm = ?, lprov_sum = lprov_sum + ? ' +
				'WHERE depotentryid = ?', [dsr[j].wmax, dsr[j].wfees, dsr[j].lmin, dsr[j].lfees, dsr[j].dsid], function() {
			conn.query('UPDATE users_finance AS f SET freemoney = freemoney - ?, totalvalue = totalvalue - ? WHERE id = ?',
				[totalfees, totalfees, dsr[j].fid], function() {
			conn.query('UPDATE users_finance AS l SET freemoney = freemoney + ?, totalvalue = totalvalue + ?, wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? WHERE id = ?',
				[totalfees, totalfees, dsr[j].wfees, dsr[j].lfees, dsr[j].lid], function() {
				if (++complete == dsr.length) 
					commit(cb);
			});
			});
			});
			});
		}, j)(); }
		});
	});
	});
};

function identityMatrix(n) {
	var A = [];
	for (var i = 0; i < n; ++i) {
		var row = [];
		A.push(row);
		for (var j = 0; j < n; ++j)
			row[j] = (i == j ? 1.0 : 0.0);
	}
	
	return A;
}

Stocks.prototype.updateLeaderMatrix = function(ctx, cb) {
	var self = this;
	
	var lmuStart = Date.now();
	
	self.getServerConfig(function(cfg) {
	
	ctx.getConnection(function (conn, commit) {
	conn.query('SET autocommit = 0; ' +
		'LOCK TABLES depot_stocks AS ds READ, users_finance WRITE, stocks AS s WRITE;', [], function() {
	conn.query('SELECT ds.userid AS uid FROM depot_stocks AS ds ' +
		'UNION SELECT s.leader AS uid FROM stocks AS s WHERE s.leader IS NOT NULL', [], function(users) {
	conn.query(
		'SELECT ds.userid AS uid, SUM(ds.amount * s.bid) AS valsum, SUM(ds.amount * s.ask) AS askvalsum, ' +
		'freemoney, users_finance.wprov_sum + users_finance.lprov_sum AS prov_sum ' +
		'FROM depot_stocks AS ds ' +
		'LEFT JOIN stocks AS s ON s.leader IS NULL AND s.id = ds.stockid ' +
		'LEFT JOIN users_finance ON ds.userid = users_finance.id ' +
		'GROUP BY uid ', [], function(res_static) {
	conn.query('SELECT id AS uid, 0 AS askvalsum, 0 AS valsum, freemoney, wprov_sum + lprov_sum AS prov_sum ' +
		'FROM users_finance WHERE (SELECT COUNT(*) FROM depot_stocks AS ds WHERE ds.userid = users_finance.id) = 0', [],
		function(res_static2) {
		res_static = res_static.concat(res_static2);
	conn.query('SELECT s.leader AS luid, ds.userid AS fuid, ds.amount AS amount ' +
		'FROM depot_stocks AS ds JOIN stocks AS s ON s.leader IS NOT NULL AND s.id = ds.stockid', [], function(res_leader) {
		users = _.uniq(_.pluck(users, 'uid'));
		
		var lmuFetchData = Date.now();
		
		var userIdToIndex = [];
		for (var k = 0; k < users.length; ++k)
			userIdToIndex[users[k]] = k;
		
		var userIdToResStaticIndex = [];
		for (var k = 0; k < res_static.length; ++k)
			userIdToResStaticIndex[res_static[k].uid] = k;
			
		var followerToResLeaderIndices = [];
		for (var k = 0; k < res_leader.length; ++k) {
			var fuid = res_leader[k].fuid;
			if (followerToResLeaderIndices[fuid])
				followerToResLeaderIndices[fuid].push(k);
			else
				followerToResLeaderIndices[fuid] = [k];
		}
		
		if (users.length == 0)
			return cb();
		
		var complete = 0;
		
		// find connected components
		var uf = new UnionFind(users.length);
		for (var i = 0; i < res_leader.length; ++i)
			uf.union(userIdToIndex[res_leader[i].luid], userIdToIndex[res_leader[i].fuid]);
		
		var components = {};
		for (var i = 0; i < users.length; ++i) {
			if (!components[uf.find(i)])
				components[uf.find(i)] = [users[i]];
			else
				components[uf.find(i)].push(users[i]);
		}
		
		var sgesvTotalTime = 0, presgesvTotalTime = 0, postsgesvTotalTime = 0;
		var updateQuery = '';
		var updateParams = [];
		
		for (var ci_ in components) { (function() {
			var componentStartTime = Date.now();
			var ci = ci_;
			var cusers = components[ci];
			var n = cusers.length;
			
			var cuserIdToIndex = {};
			for (var k = 0; k < cusers.length; ++k)
				cuserIdToIndex[cusers[k]] = k;
			
			var A = identityMatrix(n); // slightly faster than the lodash equivalent via 2 map()s
			var B = _.map(_.range(n), function() { return [0.0, 0.0]; });
			var prov_sum = _.map(_.range(n), function() { return [0.0]; });
			
			for (var k = 0; k < cusers.length; ++k) {
				var uid = cusers[k];
				
				// res_static
				{
					var r = res_static[userIdToResStaticIndex[uid]];
					var localIndex = cuserIdToIndex[uid];
					
					assert.strictEqual(r.uid, uid);
					assert.ok(localIndex < n);
					
					if (r.valsum === null) // happens when one invests only in leaders
						r.valsum = 0;
					
					B[localIndex] = [
						r.valsum    + r.freemoney - r.prov_sum,
						r.askvalsum + r.freemoney - r.prov_sum
					];
					prov_sum[localIndex] = r.prov_sum;
				}
				
				// res_leader (is indexed by follwer uid)
				var rlIndices = followerToResLeaderIndices[uid];
				
				if (rlIndices) for (var j = 0; j < rlIndices.length; ++j) {
					var r = res_leader[rlIndices[j]];
					
					assert.equal(r.fuid, uid); // the follower part is already known
					var l = cuserIdToIndex[r.luid]; // find leader uid
					
					// the leader MUST be in the same connected component
					assert.notEqual(typeof l, 'undefined');
					
					A[k][l] -= r.amount / cfg.leaderValueShare;
				}
			}
			
			var sgesvST = Date.now();
			var res = lapack.sgesv(A, B);
			if (!res) {
				self.emitError(new Error('SLE solution not found for\nA = ' + A + '\nB = ' + B));
				return;
			}
			var sgesvET = Date.now();
			sgesvTotalTime += sgesvET - sgesvST;
			presgesvTotalTime += sgesvST - componentStartTime;
			
			var X =  _.pluck(res.X, 0);
			var Xa = _.pluck(res.X, 1);
			//console.log(JSON.stringify(A),JSON.stringify(B),JSON.stringify(userIdToIndex),JSON.stringify(X));

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
				updateParams.push((lv + lva)/2.0, lva, lv, lv < 10000 ? 0 : 100000000, cusers[i]);
				updateQuery += 'UPDATE users_finance SET totalvalue = ? WHERE id = ?;';
				updateParams.push(X[i] + prov_sum[i], cusers[i]);
				
				if (++complete == users.length) {
					var lmuComputationsComplete = Date.now();
					conn.query(updateQuery, updateParams, function() {
						commit(false, function() {
							conn.query('SELECT stockid, lastvalue, ask, bid, stocks.name AS name, leader, users.name AS leadername ' +
								'FROM stocks JOIN users ON leader = users.id WHERE leader IS NOT NULL',
								[users[i]], function(res) {
								conn.release();
								
								var lmuEnd = Date.now();
								console.log('lmu timing: ' +
									presgesvTotalTime + ' ms pre-sgesv total, ' +
									sgesvTotalTime + ' ms sgesv total, ' +
									postsgesvTotalTime + ' ms post-sgesv total, ' +
									(lmuEnd - lmuStart) + ' ms lmu total, ' +
									(lmuFetchData - lmuStart) + ' ms fetching, ' +
									(lmuEnd - lmuComputationsComplete) + ' ms writing');
								
								for (var j = 0; j < res.length; ++j) {
									process.nextTick(_.bind(_.partial(function(r) {
										self.emitGlobal('stock-update', r);
									}, res[j]), self));
								}
								
								cb();
							});
						});
					});
				}
				}, self, i)();
			}
			
			var componentEndTime = Date.now();
			postsgesvTotalTime += componentEndTime - sgesvET;
		})(); }
	});
	});
	});
	});
	});
	});
	
	});
}

Stocks.prototype.updateRecord = function(ctx, rec) {
	var self = this;
	
	if (rec.failure)
		return;
	
	assert.notEqual(rec.lastTradePrice, null);
	if (rec.lastTradePrice == 0) // happens with API sometimes.
		return;
	
	assert.notStrictEqual(rec.pieces, null);
	
	var emitSUEvent = function() {
		self.emitGlobal('stock-update', {
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
	};
	
	if (ctx.getProperty('readonly'))
		return emitSUEvent();
	
	ctx.query('INSERT INTO stocks (stockid, lastvalue, ask, bid, lastchecktime, lrutime, leader, name, exchange, pieces) VALUES '+
		'(?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), NULL, ?, ?, ?) ON DUPLICATE KEY ' +
		'UPDATE lastvalue = ?, ask = ?, bid = ?, lastchecktime = UNIX_TIMESTAMP(), name = IF(LENGTH(name) >= LENGTH(?), name, ?), exchange = ?, pieces = ?',
		[rec.symbol, rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.exchange, rec.pieces,
		 rec.lastTradePrice * 10000, rec.ask * 10000, rec.bid * 10000, rec.name, rec.name, rec.exchange, rec.pieces], emitSUEvent);
};

Stocks.prototype.searchStocks = buscomponent.provideQT('client-stock-search', function(query, ctx, cb) {
	var self = this;
	
	this.getServerConfig(function(cfg) {
	var str = String(query.name);
	if (!str || str.length < 3)
		return cb('stock-search-too-short');
	
	str = str.trim();
	
	var handleResults = function(results) {
		results = _.uniq(results, false, function(r) { return r.stockid; });
		var symbols = _.pluck(results, 'stockid');
		
		if (symbols.length > 0 && !ctx.getProperty('readonly')) {
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
	ctx.query('SELECT stocks.stockid AS stockid, stocks.lastvalue AS lastvalue, stocks.ask AS ask, stocks.bid AS bid, '+
		'stocks.leader AS leader, users.name AS leadername, wprovision, lprovision '+
		'FROM stocks ' +
		'JOIN users ON stocks.leader = users.id ' +
		'JOIN users_finance ON users.id = users_finance.id ' +
		'WHERE users.name LIKE ? OR users.id = ?', [xstr, lid], function(res1) {
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

Stocks.prototype.stockExchangeIsOpen = buscomponent.provide('stockExchangeIsOpen', ['sxname', 'cfg', 'reply'], function(sxname, cfg, cb) {
	assert.ok(sxname);
	assert.ok(cfg);
	
	var sxdata = cfg.stockExchanges[sxname];
	if (!sxdata) {
		this.emitError(new Error('Unknown SX: ' + sxname));
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

Stocks.prototype.sellAll = buscomponent.provideWQT('sellAll', function(query, ctx, cb) {
	var self = this;
	
	ctx.query('SELECT s.*, ds.* FROM stocks AS s JOIN depot_stocks AS ds ON ds.stockid = s.id WHERE s.leader = ?', [ctx.user.id], function(res) {
		if (res.length == 0)
			return cb();
		
		var complete = 0;
		for (var i = 0; i < res.length; ++i) {
			var depotentry = res[i];
			
			var newCtx = new qctx.QContext({
				parentComponent: this,
				user: {id: depotentry.userid, uid: depotentry.userid},
				access: ctx.access
			});
			
			self.buyStock({
				amount: -depotentry.amount,
				leader: ctx.user.id,
			}, newCtx, true, function() {
				if (++complete == res.length) 
					cb();
			});
		}
	});
});

Stocks.prototype.buyStock = buscomponent.provide('client-stock-buy',
	['query', 'ctx', 'forceNow', 'reply'], function(query, ctx, forceNow, cb) {
	var self = this;
	
	if (ctx.getProperty('readonly'))
		return cb('server-readonly');
	
	this.getServerConfig(function(cfg) {
	
	assert.ok(ctx.user);
	assert.ok(ctx.access);
	
	if (query.leader != null)
		query.stockid = '__LEADER_' + query.leader + '__';
	
	ctx.getConnection(function(conn, commit, rollback) {
	
	conn.query('SET autocommit = 0; ' +
	'LOCK TABLES depot_stocks WRITE, users_finance AS l WRITE, users_finance AS f WRITE, users AS fu WRITE, ' +
	'stocks AS s READ, orderhistory WRITE, transactionlog WRITE;', [], function() {
	
	conn.query('SELECT s.*, ' +
		'depot_stocks.amount AS amount, ' +
		'depot_stocks.amount * s.lastvalue AS money, ' +
		'depot_stocks.provision_hwm, depot_stocks.provision_lwm, s.bid, ' +
		's.bid - depot_stocks.provision_hwm AS hwmdiff, ' +
		's.bid - depot_stocks.provision_lwm AS lwmdiff, ' +
		'l.id AS lid, l.wprovision AS wprovision, l.lprovision AS lprovision ' +
		'FROM stocks AS s ' +
		'LEFT JOIN depot_stocks ON depot_stocks.userid = ? AND depot_stocks.stockid = s.id ' +
		'LEFT JOIN users_finance AS l ON s.leader = l.id AND depot_stocks.userid != l.id ' +
		'WHERE s.stockid = ?', [ctx.user.id, String(query.stockid)], function(res) {
		if (res.length == 0 || res[0].lastvalue == 0) {
			rollback();
			return cb('stock-buy-stock-not-found');
		}
		
		assert.equal(res.length, 1);
		
		var r = res[0];
		
		var hadDepotStocksEntry = (r.amount !== null);
		
		if (r.money === null)  r.money = 0;
		if (r.amount === null) r.amount = 0;
		
		if (/__LEADER_(\d+)__/.test(query.stockid) && !ctx.access.has('email_verif') && !forceNow) {
			rollback();
			return cb('stock-buy-email-not-verif');
		}
		
		forceNow = forceNow || (ctx.access.has('stocks') && query.forceNow);
		
		if (!self.stockExchangeIsOpen(r.exchange, cfg) && !forceNow) {
			rollback();
			
			if (!query._isDelayed) {
				query.retainUntilCode = 'stock-buy-success';
				self.request({name: 'client-dquery', 
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
		conn.query('SELECT freemoney, totalvalue FROM users_finance AS f WHERE id = ?', [ctx.user.id], function(ures) {
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
		
		if (Math.abs(amount) + tradedToday > r.pieces && !ctx.access.has('stocks') && !forceNow) {
			rollback();
			return cb('stock-buy-over-pieces-limit');
		}
		
		var fee = Math.max(Math.abs(cfg['transaction-fee-perc'] * price), cfg['transaction-fee-min']);
		
		conn.query('INSERT INTO orderhistory (userid, stocktextid, leader, money, buytime, amount, fee, stockname, prevmoney, prevamount) ' +
			'VALUES(?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?, ?, ?)', 
			[ctx.user.id, r.stockid, r.leader, price, amount, fee, r.name, r.money, r.amount], function(oh_res) {
		(amount <= 0 && ((r.hwmdiff && r.hwmdiff > 0) || (r.lwmdiff && r.lwmdiff < 0)) && r.lid ? function(cont) {
			var wprovPay = r.hwmdiff * -amount * r.wprovision / 100.0;
			var lprovPay = r.lwmdiff * -amount * r.lprovision / 100.0;

			if (wprovPay < 0) wprovPay = 0;
			if (lprovPay > 0) lprovPay = 0;
			
			var totalprovPay = wprovPay + lprovPay;
			
			conn.query('INSERT INTO transactionlog (orderid, type, stocktextid, a_user, p_user, amount, time, json) ' + 
				'VALUES (?, "provision", ?, ?, ?, ?, UNIX_TIMESTAMP(), ?)',
				[oh_res.insertId, r.stockid, ctx.user.id, r.lid, totalprovPay, JSON.stringify({
					reason: 'trade',
					provision_hwm: r.provision_hwm,
					provision_lwm: r.provision_lwm,
					bid: r.bid,
					depot_amount: amount
				})], function() {
			conn.query('UPDATE users_finance AS f SET freemoney = freemoney - ?, totalvalue = totalvalue - ? WHERE id = ?',
				[totalprovPay, totalprovPay, ctx.user.id], function() {
			conn.query('UPDATE users_finance AS l SET freemoney = freemoney + ?, totalvalue = totalvalue + ?, wprov_sum = wprov_sum + ?, lprov_sum = lprov_sum + ? WHERE id = ?',
				[totalprovPay, totalprovPay, wprovPay, lprovPay, r.lid], cont);
			});
			});
		} : function(cont) { cont(); })(function() {
			ctx.feed({
				'type': 'trade',
				'targetid': oh_res.insertId,
				'srcuser': ctx.user.id,
				'json': {delay: !!ures[0].delayorderhist ? cfg.delayOrderHistTime : 0, dquerydata: query.dquerydata || null},
				'feedusers': r.leader ? [r.leader] : []
			});
			
			var tradeID = oh_res.insertId;
			
			var perfn = r.leader ? 'fperf' : 'operf';
			var perfv = amount >= 0 ? 'bought' : 'sold';
			var perffull = perfn + '_' + perfv;
			
			conn.query('INSERT INTO transactionlog (orderid, type, stocktextid, a_user, p_user, amount, time, json) VALUES ' + 
				'(?, "stockprice", ?, ?, NULL, ?, UNIX_TIMESTAMP(), ?), ' +
				'(?, "fee",        ?, ?, NULL, ?, UNIX_TIMESTAMP(), ?)',
				[oh_res.insertId, r.stockid, ctx.user.id, price, JSON.stringify({reason: 'trade'}),
				 oh_res.insertId, r.stockid, ctx.user.id, fee,   JSON.stringify({reason: 'trade'})], function() {
			conn.query('UPDATE users AS fu SET tradecount = tradecount+1 WHERE id = ?', [ctx.user.id], function() {
			conn.query('UPDATE users_finance AS f SET freemoney = freemoney-(?), totalvalue = totalvalue-(?), '+
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
	});
});

Stocks.prototype.stocksForUser = buscomponent.provideQT('client-list-own-depot', function(query, ctx, cb) {
	ctx.query('SELECT '+
		'amount, buytime, buymoney, ds.wprov_sum AS wprov_sum, ds.lprov_sum AS lprov_sum, '+
		's.stockid AS stockid, lastvalue, ask, bid, bid * amount AS total, weekstartvalue, daystartvalue, '+
		'users.id AS leader, users.name AS leadername, exchange, s.name, ' +
		'IF(leader IS NULL, s.name, CONCAT("Leader: ", users.name)) AS stockname '+
		'FROM depot_stocks AS ds ' +
		'JOIN stocks AS s ON s.id = ds.stockid ' +
		'LEFT JOIN users ON s.leader = users.id ' +
		'WHERE userid = ? AND amount != 0',
		[ctx.user.id], function(results) {
		cb('list-own-depot-success', {'results': results});
	});
});

Stocks.prototype.listTransactions = buscomponent.provideQT('client-list-transactions', function(query, ctx, cb) {
	ctx.query('SELECT t.*, a.name AS aname, p.name AS pname, s.name AS stockname FROM transactionlog AS t ' +
		'LEFT JOIN users AS a ON a.id = t.a_user ' +
		'LEFT JOIN users AS p ON p.id = t.p_user ' +
		'LEFT JOIN stocks AS s ON s.stockid = t.stocktextid ' +
		'WHERE t.a_user = ? OR t.p_user = ? ', [ctx.user.id, ctx.user.id], function(results) {
		for (var i = 0; i < results.length; ++i)
			results[i].json = results[i].json ? JSON.parse(results[i].json) : {};

		cb('list-transactions-success', { results: results });
	});
});

Stocks.prototype.getTradeInfo = buscomponent.provideQT('client-get-trade-info', function(query, ctx, cb) {
	this.getServerConfig(function(cfg) {
		ctx.query('SELECT oh.*,s.*,u.name,events.eventid AS eventid,trader.delayorderhist FROM orderhistory AS oh '+
			'LEFT JOIN stocks AS s ON s.leader = oh.leader '+
			'LEFT JOIN events ON events.type = "trade" AND events.targetid = oh.orderid '+
			'LEFT JOIN users AS u ON u.id = oh.leader '+
			'LEFT JOIN users AS trader ON trader.id = oh.userid WHERE oh.orderid = ?', [parseInt(query.tradeid)], function(oh_res) {
			if (oh_res.length == 0)
				return cb('get-trade-info-notfound');
			var r = oh_res[0];
			
			assert.ok(r.userid);
			if (r.userid != ctx.user.id && !!r.delayorderhist && (Date.now()/1000 - r.buytime < cfg.delayOrderHistTime) && !ctx.access.has('stocks'))
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

exports.Stocks = Stocks;

})();
