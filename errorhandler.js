(function () { "use strict";

var _ = require('underscore');
var fs = require('fs');
var util = require('util');
var buscomponent = require('./bus/buscomponent.js');

function ErrorHandler() {
}

util.inherits(ErrorHandler, buscomponent.BusComponent);

ErrorHandler.prototype.err = buscomponent.listener('error', function(e, noemail) {
	var self = this;
	
	if (!e)
		return this.err(new Error('Error without Error object caught -- abort'), true);
	
	this.getServerConfig(function(cfg) {
		try {
			noemail = noemail || false;
			
			var opt = _.clone(cfg.mail['error-base']);
			opt.text = process.pid + ': ' + (new Date().toString()) + ': ' + e + '\n';
			if (e.stack)
				opt.text += e.stack + '\n';
			
			if (self.bus)
				opt.text += '\n' + util.inspect(self.bus.packetLog.reverse(), {depth: 2});
					
			console.error(opt.text);
			
			self.request({name: 'sendMail', opt: opt}, function (error, resp) {
				if (error)
					this.err(error, true);
			});
			
			if (cfg.errorLogFile)
				fs.appendFile(cfg.errorLogFile, opt.text, function() {});
		} catch(e2) {
			console.error('ERROR WHILE HANDLING OTHER ERROR:\n', e2, 'during handling of\n', e);
		}
	});
});

exports.ErrorHandler = ErrorHandler;

})();
