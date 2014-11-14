(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var lapack = require('lapack');
var UnionFind = require('unionfind');
var assert = require('assert');

var buscomponent = require('./stbuscomponent.js');

/**
 * Provides internally used functions for large-scale finance updates,
 * i.e. provisions and leader stock values.
 * @public
 * @module stocks-financeupdate
 */

/**
 * Main object of the {@link module:stocks-financeupdate} module
 * @public
 * @constructor module:stocks-financeupdate~StocksFinanceUpdate
 * @augments module:stbuscomponent~STBusComponent
 */
function StocksFinanceUpdates () {
	StocksFinanceUpdates.super_.apply(this, arguments);
}

util.inherits(StocksFinanceUpdates, buscomponent.BusComponent);

var wprovMax = 'GREATEST(ds.provision_hwm, s.bid)';
var wprovΔ = '(('+wprovMax+' - ds.provision_hwm) * ds.amount)';
var wprovFees = '(('+wprovΔ+' * l.wprovision) / 100)';
var lprovMin = 'LEAST(ds.provision_lwm, s.bid)';
var lprovΔ = '(('+lprovMin+' - ds.provision_lwm) * ds.amount)';
var lprovFees = '(('+lprovΔ+' * l.lprovision) / 100)';

/**
 * Update all provision values in the user finance fields.
 * 
 * The provisions are calculated according to: <br />
 * <math mode="display" xmlns="http://www.w3.org/1998/Math/MathML">
 *     <mrow>
 *         Gain provision =
 *         (max{HWM - bid} - HWM) · (number of shares)
 *         · <mfrac><mrow>(gain provision percentage)</mrow><mrow>100</mrow></mfrac>
 *     </mrow>
 *     <mrow>
 *         Loss provision =
 *         (min{LWM - bid} - LWM) · (number of shares)
 *         · <mfrac><mrow>(loss provision percentage)</mrow><mrow>100</mrow></mfrac>
 *     </mrow>
 * </math> <br />
 * where HWM and LWM stand for high and low water mark, respectively.
 * 
 * After paying the provisions, all HWMs and LWMs are set to their new marks.
 * They are not – as it was the case in earlier revisions of this software –
 * reset after a given amount of time, but rather persist over the entire span
 * of time in which the users holds shares of the corresponding leader.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access
 * 
 * @function busreq~updateProvisions
 */
StocksFinanceUpdates.prototype.updateProvisions = buscomponent.provide('updateProvisions', ['ctx', 'reply'], function (ctx, cb) {
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
});

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

/**
 * Update the leader matrix values.
 * This is quite complicated and deserves to be documented somewhere else
 * and in greater detail (e.g., at https://doc.tradity.de/math/math.pdf).
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access
 * 
 * @function busreq~updateLeaderMatrix
 */
StocksFinanceUpdates.prototype.updateLeaderMatrix = buscomponent.provide('updateLeaderMatrix', ['ctx', 'reply'], function(ctx, cb) {
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
});

})();
