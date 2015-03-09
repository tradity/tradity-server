(function () { "use strict";

var _ = require('lodash');
var fs = require('fs');
var util = require('util');
var Q = require('q');
var semaphore = require('q-semaphore');
var ratelimit = require('q-ratelimit');
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
	
	this.sem = semaphore(1);
	this.throttle = ratelimit(10000);
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
	
	var cfg, longErrorText;
	
	self.getServerConfig().catch(function(e2) {
		console.error('Could not get server config due to', e2);
		return null;
	}).then(function(cfg_) {
		cfg = cfg_;
		
		return Q.all([self.sem.take(), self.throttle()]);
	}).then(function() {
		noemail = noemail || false;
		
		longErrorText = process.pid + ': ' + (new Date().toString()) + ': ' + e + '\n';
		if (e.stack)
			longErrorText += e.stack + '\n';
		else // assume e is not actually an Error instance
			longErrorText += util.inspect(e) + '\n';
		
		if (self.bus) {
			longErrorText += 'Bus: ' + self.bus.id + '\n';
			longErrorText += '\n' + util.inspect(self.bus.packetLog.reverse(), {depth: 2});
		
			if (e.nonexistentType || e.name.match(/^Assertion/i))
				longErrorText += '\n' + JSON.stringify(self.bus.busGraph.json()) + '\n';
		}
		
		if (!process.env.SOTRADE_DO_NOT_OUTPUT_ERRORS)
			console.error(longErrorText);
		
		if (cfg && cfg.errorLogFile)
			return Q.nfcall(fs.appendFile, cfg.errorLogFile, longErrorText);
	}).then(function() {
		if (cfg && cfg.mail) {
			var opt = _.clone(cfg.mail['errorBase']);
			opt.text = longErrorText;
			return self.request({name: 'sendMail', mailtype: 'error', opt: opt});
		} else {
			console.warn('Could not send error mail due to missing config!');
		}
	}).catch(function(e2) {
		console.error('Error while handling other error:\n', e2, 'during handling of\n', e);
	}).then(function() {
		return self.sem.leave();
	}).done();
});

exports.ErrorHandler = ErrorHandler;

})();
