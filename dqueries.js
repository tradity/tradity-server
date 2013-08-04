(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');

function DelayedQueriesDB (db, config, stocksdb) {
	this.db = db;
	this.cfg = config;
	this.stocksdb = stocksdb;
	this.stocksdb.stockNeeders.push(this);
	this.queries = {};
	this.neededStocks = {};
	this.queryTypes = {
		'stock-buy': _.bind(this.stocksdb.buyStock, this.stocksdb)
	};
	
	this.stocksdb.on('push', _.bind(function(ev) {
		if (ev.type == 'stock-update' && this.neededStocks['s-'+ev.stockid]) {
			_.each(this.neededStocks['s-'+ev.stockid], _.bind(function(entryid) {
				this.checkAndExecute(this.queries[entryid]);
			}, this));
		}
	}, this));
	
	this.loadDelayedQueries();
}
util.inherits(DelayedQueriesDB, require('./objects.js').DBSubsystemBase);

DelayedQueriesDB.prototype.getNeededStocks = function() {
	return _.chain(this.neededStocks).keys().map(function(id) {
		return id.substr(2);
	}).value();
}

DelayedQueriesDB.prototype.checkAndExecute = function(query) {
	query.check(_.bind(function(condmatch) {
		if (!condmatch)
			return;
		this.executeQuery(query);
	}, this));
}

DelayedQueriesDB.prototype.loadDelayedQueries = function() {
	this.query('SELECT * FROM dqueries', [], function(r) {
		_.each(r, _.bind(function(res) {
			res.query = JSON.parse(res.query);
			res.userinfo = JSON.parse(res.userinfo);
			res.accessinfo = JSON.parse(res.accessinfo);
			this.addQuery(res);
		},this));
	});
}

DelayedQueriesDB.prototype.listDelayQueries = function(query, user, access, cb) {
	cb('dquery-list-success', {
		'results': (_.chain(this.queries).values()
			.filter(function(q) { return q.userinfo.id == user.id; })
			.map(function(q) { return _.omit(q, 'userinfo', 'accessinfo'); })
			.value())
	});
}

DelayedQueriesDB.prototype.removeQueryUser = function(query, user, access, cb) {
	var queryid = query.queryid;
	if (this.queries[queryid] && this.queries[queryid].userinfo.id == user.id) {
		this.removeQuery(this.queries[queryid]);
		cb('dquery-remove-success');
	} else {
		cb('dquery-remove-notfound');
	}
}

DelayedQueriesDB.prototype.addDelayedQuery = function(query, user, access, cb) {
	var qstr = null;
	try {
		this.parseCondition(query.condition);
		qstr = JSON.stringify(query.query);
	} catch (e) {
		this.emit('error', e);
		return cb('format-error');
	}
	
	if (!this.queryTypes[query.query.type])
		cb('unknown-query-type');
	
	this.query('INSERT INTO dqueries (`condition`, query, userinfo, accessinfo) VALUES(?,?,?,?)',
		[query.condition, qstr, JSON.stringify(user), JSON.stringify(access)], function(r) {
		query.queryid = r.insertId;
		query.userinfo = user;
		query.accessinfo = access;
		cb('dquery-success', {'queryid': query.queryid});
		this.addQuery(query);
	});
}

DelayedQueriesDB.prototype.addQuery = function(query) {		
	var cond = this.parseCondition(query.condition);
	query.check = cond.check;
	query.neededStocks = cond.neededStocks;
	var entryid = query.queryid + '';
	assert.ok(!this.queries[entryid]);
	this.queries[entryid] = query;
	_.each(query.neededStocks, _.bind(this.addNeededStock,this,query.queryid));
	this.checkAndExecute(query);
}

DelayedQueriesDB.prototype.addNeededStock = function(queryid, stock) {
	if (this.neededStocks['s-'+stock]) {
		assert.equal(_.indexOf(this.neededStocks['s-'+stock], queryid), -1);
		this.neededStocks['s-'+stock].push(queryid);
	} else {
		this.neededStocks['s-'+stock] = [queryid];
	}
}

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
				cchecks.push(function(cb) {
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
				if (!/^\w+$/.test(fieldname))
					throw new Error('bad fieldname');
				cchecks.push(_.bind(function(cb) {
					this.query('SELECT ' + fieldname + ' FROM stocks WHERE stockid = ?', [stockid], function(r) {
						cb(r.length > 0 && (lt ? r[0][fieldname] < value : r[0][fieldname] > value));
					});
				}, this));
				break;
			default:
				throw new Error('unknown variable type');
		}
	}, this));
	return {check: function(cb) {
		var result = true;
		var count = 0;
		_.each(cchecks, function(check) {
			check(function(res) {
				result = result && res;
				if (++count == cchecks.length)
					cb(result);
			});
		});
	}, neededStocks: stocks};
}

DelayedQueriesDB.prototype.executeQuery = function(query) {
	var e = this.queryTypes[query.query.type];
	assert.ok(e);
	e(query.query, query.userinfo, query.accessinfo, _.bind(function(code) {
		this.feed({'type': 'dquery-exec', 'targetid':null, 'srcuser': query.userinfo.id, 'json': {'result': code}});
		this.removeQuery(query);
	}, this));
}

DelayedQueriesDB.prototype.removeQuery = function(query) {
	this.query('DELETE FROM dqueries WHERE queryid = ?', [query.queryid], function() {
		delete this.queries[query.id];
		_.each(query.neededStocks, _.bind(function(stock) {
			this.neededStocks[stock] = _.without(this.neededStocks[stock], stock);
			if (this.neededStocks[stock].length == 0)
				delete this.neededStocks[stock];
		}, this));
	});
}

exports.DelayedQueriesDB = DelayedQueriesDB;
})();

