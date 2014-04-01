(function () { "use strict";

var _ = require('underscore');
var fs = require('fs');
var nodemailer = require('nodemailer');

function ErrorHandler(cfg, mailer) {
	this.prot = cfg.mail['error-base'];
	this.transport = mailer;
}

ErrorHandler.prototype.err = function(e, noemail) {
	noemail = noemail || false;
	
	var opt = _.clone(this.prot);
	opt.text = process.pid + ': ' + (new Date().toString()) + ': ' + e + '\n';
	if (e.stack)
		opt.text += e.stack + '\n';
		
	if (this.getEnvironmentInformation) 
		opt.text += '\n' + JSON.stringify(this.getEnvironmentInformation(), null, 2);
			
	console.error(opt.text);
	
	this.transport.sendMail(opt, _.bind(function (error, resp) {
		if (error)
			this.err(error, true);
	}, this));
	
	fs.appendFile('errors.log', opt.text, function() {});
}

ErrorHandler.prototype.wrap = function(f) {
	var eh = this;
	return function() {
		try {
			f.apply(this, arguments);
		} catch (e) {
			eh.err(e);
		}
	}
}

exports.ErrorHandler = ErrorHandler;

})();
