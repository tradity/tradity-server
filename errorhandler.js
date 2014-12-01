(function () { "use strict";

var _ = require('lodash');
var fs = require('fs');
var util = require('util');
var buscomponent = require('./stbuscomponent.js');

/**
 * Provides methods for handling, logging, and notifying about errors.
 * 
 * @public
 * @module errorhandler
 */

/**
 * Main object of the {@link module:errorhandler} module
 * 
 * @public
 * @constructor module:errorhandler~ErrorHandler
 * @augments module:stbuscomponent~STBusComponent
 */
function ErrorHandler() {
	ErrorHandler.super_.apply(this, arguments);
}

util.inherits(ErrorHandler, buscomponent.BusComponent);


/**
 * Listener for <code>error</code> events.
 * 
 * This logs the error and sends, if possible, an e-mail
 * to notify about the error.
 * The exact behaviour, such as the e-mail recipient, can be set
 * in the server configuration.
 * 
 * @function module:errorhandler~ErrorHandler#err
 */
ErrorHandler.prototype.err = buscomponent.listener('error', function(e, noemail) {
	var self = this;
	
	if (!e)
		return self.err(new Error('Error without Error object caught -- abort'), true);
	
	var handler = function(cfg) {
		try {
			noemail = noemail || false;
			
			var longErrorText = process.pid + ': ' + (new Date().toString()) + ': ' + e + '\n';
			if (e.stack)
				longErrorText += e.stack + '\n';
			else // assume e is not actually an Error instance
				longErrorText += util.inspect(e) + '\n';
			
			if (self.bus) {
				longErrorText += 'Bus: ' + self.bus.id + '\n';
				longErrorText += '\n' + util.inspect(self.bus.packetLog.reverse(), {depth: 2});
			
				if (e.nonexistentType)
					longErrorText += '\n' + JSON.stringify(self.bus.busGraph.json()) + '\n';
			}
			
			console.error(longErrorText);
			
			if (cfg && cfg.mail) {
				var opt = _.clone(cfg.mail['errorBase']);
				opt.text = longErrorText;
				self.request({name: 'sendMail', mailtype: 'error', opt: opt}, function (error, resp) {
					if (error)
						self.err(error, true);
				});
			} else {
				console.warn('Could not send error mail due to missing config!');
			}
			
			if (cfg && cfg.errorLogFile)
				fs.appendFile(cfg.errorLogFile, longErrorText, function() {});
		} catch(e2) {
			console.error('Error while handling other error:\n', e2, 'during handling of\n', e);
		}
	};
	
	try {
		self.getServerConfig(handler);
	} catch (e2) {
		console.error('Could not get server config due to', e2);
		handler();
	}
});

exports.ErrorHandler = ErrorHandler;

})();
