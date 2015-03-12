(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var Q = require('q');
var qctx = require('./qctx.js');
var Access = require('./access.js').Access;
var buscomponent = require('./stbuscomponent.js');

/**
 * Provides infrastructure for delaying queries until certain conditions are met.
 * @public
 * @module dqueries
 */

/**
 * Main object of the {@link module:dqueries} module
 * 
 * @property {object} queries  A local copy of the delayed queries table.
 * @property {object} neededStocks  A stock id -> list of delayed queries map; The latter
 *                                  will be informed about updates on the stock data.
 * @property {string[]} queryTypes  A list of {@link c2s} query types which may be delayed.
 * 
 * @public
 * @constructor module:dqueries~DelayedQueries
 * @augments module:stbuscomponent~STBusComponent
 */
function DelayedQueries () {
	DelayedQueries.super_.apply(this, arguments);
	
	this.queries = {};
	
	this.neededStocks = {};
	this.queryTypes = ['stock-buy', 'dquery-remove', 'ping'];
};

util.inherits(DelayedQueries, buscomponent.BusComponent);

DelayedQueries.prototype.onBusConnect = function() {
	var self = this;
	var ctx = new qctx.QContext({parentComponent: this});
	
	this.on('stock-update', function(ev) {
		if (self.neededStocks['s-'+ev.stockid]) {
			_.each(self.neededStocks['s-'+ev.stockid], function(entryid) {
				self.checkAndExecute(ctx, self.queries[entryid]);
			});
		}
	});
	
	return this.loadDelayedQueries();
};

/**
 * Return all stocks which the delayed queries database needs as a string array.
 * 
 * @function busreq~neededStocksDQ
 */
DelayedQueries.prototype.getNeededStocks = buscomponent.provide('neededStocksDQ', [], function() {
	var neededIDs = _.chain(this.neededStocks).keys().map(function(id) {
		return id.substr(2);
	}).value();
	
	return neededIDs;
});

/**
 * Checks the preconditions for a singled delayed query and,
 * if they are met, executes it.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {Query} query  The delayed query to be checked.
 * 
 * @function module:dqueries~DelayedQueries#checkAndExecute
 */
DelayedQueries.prototype.checkAndExecute = function(ctx, query) {
	var self = this;
	
	if (ctx.getProperty('readonly'))
		return;
	
	return query.check(ctx).then(function(condmatch) {
		if (condmatch)
			return self.executeQuery(query);
	});
};

/**
 * Load all delayed queries from the database and populate the
 * local structures with the data.
 * 
 * @function module:dqueries~DelayedQueries#loadDelayedQueries
 */
DelayedQueries.prototype.loadDelayedQueries = function() {
	var self = this;
	
	var ctx = new qctx.QContext({parentComponent: self});
	
	return ctx.query('SELECT * FROM dqueries').then(function(r) {
		return Q.all(r.map(function(res) {
			res.query = JSON.parse(res.query);
			res.userinfo = JSON.parse(res.userinfo);
			res.accessinfo = Access.fromJSON(res.accessinfo);
			return self.addQuery(ctx, res);
		}));
	});
};

/**
 * List all delayed queries for the current user.
 * 
 * @return {object}  Returns with <code>dquery-list-success</code> and sets
 *                   <code>.results</code> accordingly to a list of delayed queries.
 * 
 * @function c2s~dquery-list
 */
DelayedQueries.prototype.listDelayQueries = buscomponent.provideQT('client-dquery-list', function(query, ctx) {
	return { code: 'dquery-list-success', 
		results: _.chain(this.queries).values()
			.filter(function(q) { return q.userinfo.id == ctx.user.id; })
			.map(function(q) { return _.omit(q, 'userinfo', 'accessinfo'); })
			.value()
	};
});

/**
 * Delete a delayed request of the current user.
 * 
 * @param {int} query.queryid  The delayed query’s numerical id.
 * 
 * @return {object}  Returns with <code>dquery-remove-success</code> or
 *                   <code>dquery-remove-notfound</code>.
 * 
 * @function c2s~dquery-remove
 */
DelayedQueries.prototype.removeQueryUser = buscomponent.provideWQT('client-dquery-remove', function(query, ctx) {
	var queryid = query.queryid;
	if (this.queries[queryid] && this.queries[queryid].userinfo.id == ctx.user.id) {
		return this.removeQuery(this.queries[queryid], ctx).then(function() {
			return { code: 'dquery-remove-success' };
		});
	} else {
		throw new this.SoTradeClientError('dquery-remove-notfound');
	}
});

/**
 * Add a delayed request by the current user.
 * 
 * @param {int} query.query  The query which is to be delayed
 * @param {string} query.query.retainUntilCode  If set, retain the query in the delayed 
 *                                              queries database until the return code
 *                                              matches this string.
 * @param {string} query.condition  The conditions under which the query
 *                                  will be executed. See
 *                                  {@link module:dqueries~DelayedQueries#parseCondition}.
 * 
 * @return {object}  Returns with <code>dquery-success</code> or a common error code.
 * 
 * @function c2s~dquery
 */
DelayedQueries.prototype.addDelayedQuery = buscomponent.provideWQT('client-dquery', function(query, ctx) {
	var self = this;
	
	var qstr = null;
	self.parseCondition(query.condition);
	
	try {
		qstr = JSON.stringify(query.query);
	} catch (e) {
		self.emitError(e);
		throw new self.FormatError();
	}
	
	if (this.queryTypes.indexOf(query.query.type) == -1)
		throw new self.SoTradeClientError('unknown-query-type');
	
	var userinfo = _.clone(ctx.user);
	delete userinfo.pwsalt;
	delete userinfo.pwhash;
	delete userinfo.clientopt;
	delete userinfo.clientstorage;
	
	return ctx.query('INSERT INTO dqueries (`condition`, query, userinfo, accessinfo) VALUES(?,?,?,?)',
		[String(query.condition), qstr, JSON.stringify(userinfo), ctx.access.toJSON()]).then(function(r) {
		query.queryid = r.insertId;
		query.userinfo = ctx.user;
		query.accessinfo = ctx.access;
		
		return self.addQuery(ctx, query);
	}).then(function() {
		return { code: 'dquery-success', 'queryid': query.queryid };
	});
});

/**
 * Check all delayed queries for being executable.
 * 
 * @return  Returns with <code>dquery-checkall-success</code> or
 *          <code>permission-denied</code>.
 * @function c2s~dquery-checkall
 */
DelayedQueries.prototype.checkAllDQueries = buscomponent.provideWQT('client-dquery-checkall', function(query, ctx) {
	var self = this;
	
	if (!ctx.access.has('dqueries'))
		throw new self.PermissionDenied();
	
	return Q.all(_.chain(self.queries).values().map(function(q) {
		return self.checkAndExecute(ctx, q);
	}).value()).then(function() {
		return { code: 'dquery-checkall-success' };
	});
});

/**
 * Load a delayed query into the local delayed queries list.
 * 
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {object} query  The delayed query database entry.
 * 
 * @function module:dqueries~DelayedQueries#addQuery
 */
DelayedQueries.prototype.addQuery = function(ctx, query) {
	assert.ok(query);

	var cond = this.parseCondition(query.condition);
	
	query.check = cond.check;
	query.neededStocks = cond.neededStocks;
	
	var entryid = String(query.queryid);
	assert.ok(!this.queries[entryid]);
	this.queries[entryid] = query;
	_.each(query.neededStocks, _.bind(this.addNeededStock, this, query.queryid));
	return this.checkAndExecute(ctx, query);
};

/**
 * Indicate that a delayed query requires information on a certain stock.
 * 
 * @param {int} queryid  The numerical delayed query id.
 * @param {string} stock  The stock’s id (ISIN/etc.).
 * 
 * @function module:dqueries~DelayedQueries#addQuery
 */
DelayedQueries.prototype.addNeededStock = function(queryid, stock) {
	if (this.neededStocks['s-'+stock]) {
		assert.equal(_.indexOf(this.neededStocks['s-'+stock], queryid), -1);
		this.neededStocks['s-'+stock].push(queryid);
	} else {
		this.neededStocks['s-'+stock] = [queryid];
	}
};

/**
 * Parse a delayed query condition string.
 * 
 * Currently, such a string can consist of various clauses
 * joined by <code>'∧'</code> (logical and), each of which
 * are comparisons using &lt; or &gt; of certain variables.
 * 
 * @example
 * stock::US90184L1026::exchange-open > 0 ∧ stock::US90184L1026::bid > 331000
 * @example
 * stock::US90184L1026::exchange-open > 0
 * @example
 * time > 1416085723 ∧ time < 1416095723
 * 
 * @param {string} str  The condition string to be checked
 * 
 * @return {object}  Returns an object where <code>.check(ctx)</code>
 *                   is a callback for checking whether the condition is currently met
 *                   (returning a Q promise)
 *                   and where <code>.neededStocks</code> is a list of stock ids
 *                   required to have accurate database information for checking.
 * 
 * @function module:dqueries~DelayedQueries#parseCondition
 */
DelayedQueries.prototype.parseCondition = function(str) {
	var self = this;
	
	var clauses = str.split('∧');
	var cchecks = [];
	var stocks = [];
	_.each(clauses, function(cl) {
		cl = cl.trim();
		var terms = cl.split(/[<>]/);
		if (terms.length != 2)
			throw new self.FormatError('condition clause must contain exactly one < or > expression');
		
		var lt = cl.indexOf('<') != -1;
		var lhs = terms[0].trim();
		var rhs = terms[1].trim();
		var variable = lhs.split(/::/);
		var value = parseFloat(rhs);
		switch (variable[0]) {
			case 'time':
				cchecks.push(function(ctx) {
					var t = Date.now()/1000;
					return lt ? t < value : t > value;
				});
				break;
			case 'stock':
				if (variable.length != 3)
					throw new self.FormatError('expecting level 3 nesting for stock variable');
				var stockid = variable[1];
				var fieldname = variable[2];
				if (_.indexOf(stocks, stockid) == -1)
					stocks.push(stockid);
				switch(fieldname) {
					case 'exchange-open':
						cchecks.push(function(ctx) {
							return ctx.query('SELECT exchange FROM stocks WHERE stockid = ?', [String(stockid)]).then(function(r) {
								if (r.length == 0)
									return false;
								
								return self.getServerConfig().then(function(cfg) {
									assert.ok(cfg);
									
									return self.request({name: 'stockExchangeIsOpen', sxname: r[0].exchange, cfg: cfg});
								}).then(function(isOpen) {
									return lt ? isOpen < value : isOpen > value;
								});
							});
						});
						break;
					default:
						if (!/^\w+$/.test(fieldname))
							throw new self.FormatError('bad fieldname');
						cchecks.push(function(ctx) {
							return ctx.query('SELECT ' + fieldname + ' FROM stocks WHERE stockid = ?',
								[String(stockid)]).then(function(r) {
								return r.length > 0 && (lt ? r[0][fieldname] < value : r[0][fieldname] > value);
							});
						});
						break;
				}
				break;
			default:
				throw new self.FormatError('unknown variable type');
		}
	});
	
	return {
		check: function(ctx) {
			var count = 0;
			
			return Q.all(cchecks.map(function(check) {
				return check(ctx);
			})).then(function(allCheckResults) {
				return allCheckResults.reduce(function(a, b) { return a && b; });
			});
		},
		neededStocks: stocks
	};
};

/**
 * Informs users of delayed queries having been executed.
 * 
 * This event incorporates all fields from the delayed queries
 * info set by the originating user.
 * 
 * @typedef s2c~dquery~exec
 * @type {Event}
 */

/**
 * Execute a delayed query and, if appropiate, removes it from the list.
 * 
 * @param {object} query  The delayed query.
 * 
 * @function module:dqueries~DelayedQueries#executeQuery
 */
DelayedQueries.prototype.executeQuery = function(query) {
	var self = this;
	
	var ctx = new qctx.QContext({user: query.userinfo, access: query.accessinfo, parentComponent: self});
	query.query._isDelayed = true;
	
	if (query.executionPromise)
		return query.executionPromise;
	
	assert.strictEqual(self.queries[query.queryid], query);
	
	return query.executionPromise = self.request({
		name: 'client-' + query.query.type,
		query: query.query,
		ctx: ctx
	}).then(function(result) {
		var json = query.query.dquerydata || {};
		json.result = result.code;
		
		if (!query.query.retainUntilCode || query.query.retainUntilCode == result.code) {
			return ctx.feed({
				'type': 'dquery-exec',
				'targetid': null,
				'srcuser': query.userinfo.id,
				'json': json,
				'noFollowers': true
			}).then(function() {
				return self.removeQuery(query, ctx);
			});
		} else {
			delete query.executionPromise;
		}
	});
};

/**
 * Removes a delayed query from the local structures and the database.
 * 
 * @param {object} query  The delayed query.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function module:dqueries~DelayedQueries#removeQuery
 */
DelayedQueries.prototype.removeQuery = function(query, ctx) {
	var self = this;
	
	return ctx.query('DELETE FROM dqueries WHERE queryid = ?', [parseInt(query.queryid)]).then(function() {
		delete self.queries[query.queryid];
		_.each(query.neededStocks, function(stock) {
			self.neededStocks['s-'+stock] = _.without(self.neededStocks['s-'+stock], query.queryid);
			if (self.neededStocks['s-'+stock].length == 0)
				delete self.neededStocks['s-'+stock];
		});
	});
};

/**
 * Removes a delayed query from the local structures and the database.
 * 
 * @param {object} query  The delayed query.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function module:dqueries~DelayedQueries#removeQuery
 */
DelayedQueries.prototype.resetUser = buscomponent.provide('dqueriesResetUser', ['ctx'], function(ctx) {
	var toBeDeleted = [];
	for (var queryid in this.queries) {
		var q = this.queries[queryid];
		if (q.userinfo.id == ctx.user.id || (q.query.leader == ctx.user.id))
			toBeDeleted.push(q);
	}
	
	for (var i = 0; i < toBeDeleted.length; ++i)
		this.removeQuery(toBeDeleted[i], ctx);
});

exports.DelayedQueries = DelayedQueries;
})();

