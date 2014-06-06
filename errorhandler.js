(function () { "use strict";

var _ = require('underscore');
var fs = require('fs');
var util = require('util');
var buscomponent = require('./buscomponent.js');

function ErrorHandler() {
}

util.inherits(ErrorHandler, buscomponent.BusComponent);

ErrorHandler.prototype.err = buscomponent.listener('error', function(e, noemail) {
	if (!e)
		return this.err(new Error('Error without Error object caught -- abort'), true);
	
	this.getServerConfig(function(cfg) {
		noemail = noemail || false;
		
		var opt = _.clone(cfg.mail['error-base']);
		opt.text = process.pid + ': ' + (new Date().toString()) + ': ' + e + '\n';
		if (e.stack)
			opt.text += e.stack + '\n';
		
		try {
			if (this.bus)
				opt.text += '\n' + util.inspect(this.bus.log.reverse(), {depth: 3});
		} catch(e) { console.error(e); }
				
		console.error(opt.text);
		
		this.request({name: 'sendMail', opt: opt}, function (error, resp) {
			if (error)
				this.err(error, true);
		});
		
		if (cfg.errorLogFile)
			fs.appendFile(cfg.errorLogFile, opt.text, function() {});
	});
});

exports.ErrorHandler = ErrorHandler;

})();
