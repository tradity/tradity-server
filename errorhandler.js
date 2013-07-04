(function () { "use strict";

var _ = require('underscore');
var fs = require('fs');
var nodemailer = require('nodemailer');

function ErrorHandler(cfg) {
	this.cfg = cfg.mail;
	this.transport = null;
}

ErrorHandler.prototype.err = function(e, noemail) {
	noemail = noemail || false;
	console.error(e);
	
	if (this.transport === null) 
		this.transport = nodemailer.createTransport(this.cfg.transport, this.cfg.transportData);
	
	var opt = _.clone(this.cfg.options);
	opt.subject = 'SoTrade Error'
	opt.text = process.pid + ': ' + (new Date().toString()) + ': ' + e + '\n';
	
	this.transport.sendMail(opt, _.bind(function (error, resp) {
		if (error)
			this.err(error, true);
	}, this));
	
	fs.appendFile('errors.log', opt.text, function() {});
}

exports.ErrorHandler = ErrorHandler;

})();
