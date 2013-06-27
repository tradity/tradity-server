(function () { "use strict";

var http = require('http');
var util = require('util');
var events = require('events');
var csv = require('csv');
var _ = require('underscore');

var RAW_LINK_DEFAULT = 'http://download.finance.yahoo.com/d/quotes.csv?s=%{stocklist}&f=%{format}';
var FORMAT_DEFAULT = ['s', 'n', 'l1'];
var MAXLEN_DEFAULT = 196;
var USER_AGENT_DEFAULT = 'Yahoo quotes.csv loader script (contact: sqrt@entless.org) (NodeJS ' + process.version + ' http)';

function YahooFinanceQuoteEntry(id, format, record) {
	this.id = id;
	_.each(_.zip(format, record), _.bind(function(e) {
		this[e[0]] = e[1];
	}, this));
	
	this.symbol = this.s;
	this.name = this.n;
	this.lastTradePrice = this.l1;
}

function YahooFinanceQuoteLoader (rawLink, format, maxlen, userAgent) {
	this.rawLink = rawLink || RAW_LINK_DEFAULT;
	this.format = format || FORMAT_DEFAULT;
	this.maxlen = maxlen || MAXLEN_DEFAULT;
	this.userAgent = userAgent || USER_AGENT_DEFAULT;
}
util.inherits(YahooFinanceQuoteLoader, events.EventEmitter);

YahooFinanceQuoteLoader.prototype._handleRecord = function(record) {
	if (!record.length || record.length - 1 != this.format.length)
		this.emit('error', 'Record length (' + (record.length - 1) + ') does not fit format length (' + (this.format.length) + ')!');
	
	this.emit('record', new YahooFinanceQuoteEntry(record.shift(), this.format, record));
}

YahooFinanceQuoteLoader.prototype._makeRequest = function(stocklist) {
	if (stocklist.length > this.maxlen) {
		this._makeRequest(stocklist.slice(this.maxlen));
		this._makeRequest(stocklist.slice(0, this.maxlen));
		return;
	}
	
	var fstring = 's' + this.format.join('');
	var forwardError = _.bind(function(e) {this.emit('error', e)}, this);
	var sl = _.reduce(stocklist, function(memo, code) { return memo + '+' + code; }, '');
	var requrl = this.rawLink.replace('%\{stocklist\}', sl).replace('%\{format\}', fstring);
	var req = http.request(requrl, _.bind(function(res) {
		csv().from.stream(res.on('error', forwardError)).on('record', _.bind(function(rec) {
			this._handleRecord(rec);
		}, this)).on('error', forwardError);
	}, this));
	req.setHeader('User-Agent', this.userAgent);
	req.end();
}

YahooFinanceQuoteLoader.prototype.loadQuotes = function(stocklist, callback) {
	this._makeRequest(stocklist);
	_.each(stocklist, _.bind(function(e) {
		var cb;
		cb = _.bind(function(record) { if (record.id == e) {
			callback(record);
			this.removeListener('record', cb);
		}}, this);
		
		this.on('record', cb);
	}, this));
}

exports.YahooFinanceQuoteLoader = YahooFinanceQuoteLoader;

function test() {
	var ql = new YahooFinanceQuoteLoader();
	ql.on('error', function(e) { console.log(e); });
	ql.loadQuotes(['GOOG', '^GDAXI', 'KO', 'BA', 'INTC', 'MCD', 'IBM', 'MSFT', 'DIS'], function(rec) {
		console.log('Name: ' + rec.name + ', LT Price: ' + rec.lastTradePrice);
	});
}

if (require.main === module)
	test();

})();
