(function () { "use strict";

var http = require('http');
var util = require('util');
var events = require('events');
var csv = require('csv');
var _ = require('underscore');

var FAKE_CALLBACK = 'YAHOO.util.UHScriptNodeDataSource.callbacks';
var INFO_LINK_DEFAULT = 'http://download.finance.yahoo.com/d/quotes.csv?s=%{stocklist}&f=%{format}';
var SEARCH_LINK_DEFAULT = 'http://d.yimg.com/aq/autoc?query=%{name}&region=DE&lang=de-DE&callback=%{fake-cb}&rnd=%{random}';
var FORMAT_DEFAULT = ['s', 'n', 'l1', 'a', 'b', 'x'];
var MAXLEN_DEFAULT = 196;
var USER_AGENT_DEFAULT = 'Yahoo quotes.csv loader script (contact: sqrt@entless.org) (NodeJS ' + process.version + ' http)';

function YahooFinanceQuoteEntry(id, format, record) {
	this.id = id;
	_.each(_.zip(format, record), _.bind(function(e) {
		this[e[0]] = (e[1] == 'N/A' ? null : e[1]);
	}, this));
	
	this.symbol = this.s;
	this.lastTradePrice = this.l1;
	this.ask = this.a ? this.a : this.l1;
	this.bid = this.b ? this.b : this.l1;
	this.exchange = this.x;
	this.setName(this.n);
	this.fetchTime = new Date().getTime();
}

YahooFinanceQuoteEntry.prototype.setName = function(n) {
	this.n = this.name = n;
}

function YahooFinanceQuoteLoader (infoLink, searchLink, format, maxlen, userAgent, cacheTime) {
	this.infoLink = infoLink || INFO_LINK_DEFAULT;
	this.searchLink = searchLink || SEARCH_LINK_DEFAULT;
	this.format = format || FORMAT_DEFAULT;
	this.maxlen = maxlen || MAXLEN_DEFAULT;
	this.userAgent = userAgent || USER_AGENT_DEFAULT;
	this.cacheTime = cacheTime || 25000;
	this.cache = {};
}
util.inherits(YahooFinanceQuoteLoader, events.EventEmitter);

YahooFinanceQuoteLoader.prototype._handleRecord = function(record, cached) {
	var rec = null;
	
	if (!cached) {
		if (!record.length || record.length - 1 != this.format.length)
			this.emit('error', new Error('Record length (' + (record.length - 1) + ') does not fit format length (' + (this.format.length) + ')!'));
		
		rec = new YahooFinanceQuoteEntry(record.shift(), this.format, record, cached);
	
		this.cache['s-' + rec.symbol] = rec;
	} else
		rec = record;
		
	this.emit('record', rec);
}

YahooFinanceQuoteLoader.prototype._makeQuoteRequest = function(stocklist) {
	stocklist = _.filter(stocklist, _.bind(function(stockid) {
		var cv = this.cache['s-' + stockid];
		if (cv) {
			if (cv.fetchTime > new Date().getTime() - this.cacheTime) {
				this._handleRecord(cv, true);
				return false;
			} else {
				delete this.cache['s-' + stockid];
			}
		} 
		
		return true;
	}, this));
	
	if (stocklist.length > this.maxlen) {
		this._makeQuoteRequest(stocklist.slice(this.maxlen));
		this._makeQuoteRequest(stocklist.slice(0, this.maxlen));
		return;
	}
	
	if (stocklist.length == 0) // everything was cached
		return;
	
	var fstring = 's' + this.format.join('');
	var forwardError = _.bind(function(e) {
		this.emit('error', e);
	}, this);
	var sl = _.reduce(stocklist, function(memo, code) { return memo + '+' + code; }, '');
	var requrl = this.infoLink.replace('%\{stocklist\}', sl).replace('%\{format\}', fstring);
	
	var req = http.request(requrl, _.bind(function(res) {
		csv().from.stream(res.on('error', forwardError)).on('record', _.bind(function(rec) {
			this._handleRecord(rec, false);
		}, this)).on('error', forwardError);
	}, this));
	
	req.on('error', forwardError);
	req.setHeader('User-Agent', this.userAgent);
	req.end();
}

YahooFinanceQuoteLoader.prototype.loadQuotes = function(stocklist, filter, callback) {
	filter = filter || function() { return true; };
	callback = callback || function() {};
	
	if (stocklist.length == 0) {
		this.emit('error', new Error('Called with empty stocklist'));
		return;
	}
	
	_.each(stocklist, _.bind(function(e) {
		var cb;
		cb = _.bind(function(record) { if (record.id == e && filter(record)) {
			this.removeListener('record', cb);
			callback(record);
		}}, this);
		
		this.on('record', cb);
	}, this));
	
	this._makeQuoteRequest(stocklist);
}

YahooFinanceQuoteLoader.prototype.searchAndFindQuotes = function(name, filter, callback) {
	filter = filter || function() { return true; }
	callback = callback || function() {};
	
	var forwardError = _.bind(function(e) {this.emit('error', e)}, this);
	
	var requrl = this.searchLink.replace('%\{name\}', name).replace('%\{random\}', new Date().getTime()).replace('%\{fake-cb\}', FAKE_CALLBACK);
	
	var req = http.request(requrl, _.bind(function(res) {
		var resultstr = '';
		res.setEncoding('utf8');
		
		res.on('data', function(buf) {
			resultstr += buf;
		});
		
		res.on('end', _.bind(function() {
			var r = JSON.parse(resultstr.replace(FAKE_CALLBACK, '').replace(/[()]/g, ''));
			var rset = r.ResultSet.Result;
			
			for (var i = 0; i < rset.length; ++i)
				rset[i].exchange = rset[i].exchDisp;
			rset = _.filter(rset, filter);
			
			var stocklist = [];
							
			var records = [];
			
			for (var i = 0; i < rset.length; ++i) {
				stocklist.push(rset[i].symbol);
				records[i] = null;
			}
			
			if (stocklist.length == 0)
				return callback([]);
			
			this.loadQuotes(stocklist, filter, _.bind(function(record) {
				var sym = record.symbol;
				for (var i = 0; i < rset.length; ++i) {
					if (sym == rset[i].symbol) {
						record.setName(rset[i].name);
						this.emit('record', record);
						records[i] = record;
						break;
					}
				}
				
				if (records.indexOf(null) == -1)
					callback(records);
			}, this));
		}, this));
		
		res.on('error', forwardError);
	}, this));
	req.setHeader('User-Agent', this.userAgent);
	req.end();
}

exports.YahooFinanceQuoteLoader = YahooFinanceQuoteLoader;

function test() {
	var ql = new YahooFinanceQuoteLoader();
	ql.on('error', function(e) { console.log(e, e.stack + ''); });
	ql.loadQuotes(['GOOG', '^GDAXI', 'KO', 'BA', 'INTC', 'MCD', 'IBM', 'MSFT', 'DIS', 'MDO.F'], null, function(rec) {
		console.log('Name: ' + rec.name + ', LT Price: ' + rec.lastTradePrice, 'Exch:', rec.exchange);
	});
	
	ql.searchAndFindQuotes('DONALD', null, function(rec) {
		for (var i = 0; i < rec.length; ++i) 
			console.log('Name: ' + rec[i].name + ', LT Price: ' + rec[i].lastTradePrice);
			
		ql.searchAndFindQuotes('Donaldson Burston', null, function(rec) {
			for (var i = 0; i < rec.length; ++i)
				console.log('Name: ' + rec[i].name + ', LT Price: ' + rec[i].lastTradePrice);
		});
	});
}

if (require.main === module)
	test();

})();
