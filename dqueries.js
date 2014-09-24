(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var qctx = require('./qctx.js');
var Access = require('./access.js').Access;
var buscomponent = require('./buscomponent.js');

function DelayedQueriesDB () {
	this.queries = {};
	
	this.neededStocks = {};
	this.queryTypes = ['stock-buy', 'dquery-remove'];
};
util.inherits(DelayedQueriesDB, buscomponent.BusComponent);

DelayedQueriesDB.prototype.onBusConnect = function() {
	var self = this;
	var ctx = new qctx.QContext({parentComponent: this});
	
	this.on('stock-update', function(ev) {
		if (self.neededStocks['s-'+ev.stockid]) {
			_.each(self.neededStocks['s-'+ev.stockid], function(entryid) {
				self.checkAndExecute(ctx, self.queries[entryid]);
			});
		}
	});
	
	this.loadDelayedQueries();
};

DelayedQueriesDB.prototype.getNeededStocks = buscomponent.provide('neededStocksDQ', ['reply'], function(cb) {
	var neededIDs = _.chain(this.neededStocks).keys().map(function(id) {
		return id.substr(2);
	}).value();
	
	cb(neededIDs);
	return neededIDs;
});

DelayedQueriesDB.prototype.checkAndExecute = function(ctx, query) {
	var self = this;
	
	query.check(ctx, function(condmatch) {
		if (!condmatch)
			return;
		self.executeQuery(query);
	});
};

DelayedQueriesDB.prototype.loadDelayedQueries = function() {
	var self = this;
	
	var ctx = new qctx.QContext({parentComponent: self});
	
	ctx.query('SELECT * FROM dqueries', [], function(r) {
		_.each(r, function(res) {
			res.query = JSON.parse(res.query);
			res.userinfo = JSON.parse(res.userinfo);
			res.accessinfo = Access.fromJSON(res.accessinfo);
			self.addQuery(ctx, res);
		});
	});
};

DelayedQueriesDB.prototype.listDelayQueries = buscomponent.provideQT('client-dquery-list', function(query, ctx, cb) {
	cb('dquery-list-success', {
		'results': (_.chain(this.queries).values()
			.filter(function(q) { return q.userinfo.id == ctx.user.id; })
			.map(function(q) { return _.omit(q, 'userinfo', 'accessinfo'); })
			.value())
	});
});

DelayedQueriesDB.prototype.removeQueryUser = buscomponent.provideQT('client-dquery-remove', function(query, ctx, cb) {
	var queryid = query.queryid;
	if (this.queries[queryid] && this.queries[queryid].userinfo.id == ctx.user.id) {
		this.removeQuery(this.queries[queryid], ctx);
		cb('dquery-remove-success');
	} else {
		cb('dquery-remove-notfound');
	}
});

DelayedQueriesDB.prototype.addDelayedQuery = buscomponent.provideQT('client-dquery', function(query, ctx, cb) {
	var self = this;
	
	cb = cb || function() {};
	
	var qstr = null;
	try {
		self.parseCondition(query.condition);
		qstr = JSON.stringify(query.query);
	} catch (e) {
		self.emit('error', e);
		return cb('format-error');
	}
	
	if (this.queryTypes.indexOf(query.query.type) == -1)
		self('unknown-query-type');
	
	ctx.query('INSERT INTO dqueries (`condition`, query, userinfo, accessinfo) VALUES(?,?,?,?)',
		[query.condition, qstr, JSON.stringify(ctx.user), ctx.access.toJSON()], function(r) {
		query.queryid = r.insertId;
		query.userinfo = ctx.user;
		query.accessinfo = ctx.access;
		cb('dquery-success', {'queryid': query.queryid});
		self.addQuery(ctx, query);
	});
});

DelayedQueriesDB.prototype.addQuery = function(ctx, query) {
	assert.ok(query);

	var cond = this.parseCondition(query.condition);
	query.check = cond.check;
	query.neededStocks = cond.neededStocks;
	
	var entryid = query.queryid + '';
	assert.ok(!this.queries[entryid]);
	this.queries[entryid] = query;
	_.each(query.neededStocks, _.bind(this.addNeededStock, this, query.queryid));
	this.checkAndExecute(ctx, query);
};

DelayedQueriesDB.prototype.addNeededStock = function(queryid, stock) {
	if (this.neededStocks['s-'+stock]) {
		assert.equal(_.indexOf(this.neededStocks['s-'+stock], queryid), -1);
		this.neededStocks['s-'+stock].push(queryid);
	} else {
		this.neededStocks['s-'+stock] = [queryid];
	}
};

DelayedQueriesDB.prototype.parseCondition = function(str) {
	var clauses = str.split('∧');
	var cchecks = [];
	var stocks = [];
	_.each(clauses, _.bind(function(cl) {
		cl = cl.trim();
		var terms = cl.split(/[<>]/);
		if (terms.length != 2)
			throw new Error('condition clause must contain exactly one < or > expression');
		var lt = cl.indexOf('<') != -1;
		var lhs = terms[0].trim();
		var rhs = terms[1].trim();
		var variable = lhs.split(/::/);
		var value = parseFloat(rhs);
		switch (variable[0]) {
			case 'time':
				cchecks.push(function(ctx, cb) {
					var t = new Date().getTime()/1000;
					cb(lt ? t < value : t > value);
				});
				break;
			case 'stock':
				if (variable.length != 3)
					throw new Error('expecting level 3 nesting for stock variable');
				var stockid = variable[1];
				var fieldname = variable[2];
				if (_.indexOf(stocks, stockid) == -1)
					stocks.push(stockid);
				switch(fieldname) {
					case 'exchange-open':
						cchecks.push(_.bind(function(ctx, cb) {
							ctx.query('SELECT exchange FROM stocks WHERE stockid = ?', [stockid], function(r) {
								if (r.length == 0)
									return cb(false);
								
								this.getServerConfig(function(cfg) {
									assert.ok(cfg);
									
									this.request({name: 'stockExchangeIsOpen', sxname: r[0].exchange, cfg: cfg}, function(isOpen) {
										return cb(lt ? isOpen < value : isOpen > value);
									});
								});
							});
						}, this));
						break;
					default:
						if (!/^\w+$/.test(fieldname))
							throw new Error('bad fieldname');
						cchecks.push(_.bind(function(ctx, cb) {
							ctx.query('SELECT ' + fieldname + ' FROM stocks WHERE stockid = ?', [stockid], function(r) {
								cb(r.length > 0 && (lt ? r[0][fieldname] < value : r[0][fieldname] > value));
							});
						}, this));
						break;
				}
				break;
			default:
				throw new Error('unknown variable type');
		}
	}, this));
	
	return {
		check: function(ctx, cb) {
			var result = true;
			var count = 0;
			_.each(cchecks, function(check) {
				check(ctx, function(res) {
					result = result && res;
					if (++count == cchecks.length)
						cb(result);
				});
			});
		},
		neededStocks: stocks
	};
};

DelayedQueriesDB.prototype.executeQuery = function(query) {
	var self = this;
	
	var ctx = new qctx.QContext({user: query.userinfo, access: query.accessinfo, parentComponent: self});
	query.query.__is_delayed__ = true;
	self.request({
		name: 'client-' + query.query.type,
		query: query.query,
		ctx: ctx
	}, function(code) {
		var json = query.query.dquerydata || {};
		json.result = code;
		if (!query.query.retainUntilCode || query.query.retainUntilCode == code) {
			ctx.feed({'type': 'dquery-exec', 'targetid': null, 'srcuser': query.userinfo.id, 'json': json, 'noFollowers': true});
			self.removeQuery(query, ctx);
		}
	});
};

DelayedQueriesDB.prototype.removeQuery = function(query, ctx) {
	var self = this;
	
	ctx.query('DELETE FROM dqueries WHERE queryid = ?', [query.queryid], function() {
		delete self.queries[query.queryid];
		_.each(query.neededStocks, function(stock) {
			self.neededStocks['s-'+stock] = _.without(self.neededStocks['s-'+stock], query.queryid);
			if (self.neededStocks['s-'+stock].length == 0)
				delete self.neededStocks['s-'+stock];
		});
	});
};

DelayedQueriesDB.prototype.resetUser = buscomponent.provide('dqueriesResetUser', ['ctx', 'reply'], function(ctx, cb) {
	var toBeDeleted = [];
	for (var queryid in this.queries) {
		var q = this.queries[queryid];
		if (q.userinfo.id == ctx.user.id || (q.query.leader == ctx.user.id))
			toBeDeleted.push(q);
	}
	
	for (var i = 0; i < toBeDeleted.length; ++i)
		this.removeQuery(toBeDeleted[i], ctx);
	
	cb();
});

exports.DelayedQueriesDB = DelayedQueriesDB;
})();

