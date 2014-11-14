(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var nodemailer = require('nodemailer');
var buscomponent = require('./stbuscomponent.js');

function Mailer () {
	Mailer.super_.apply(this, arguments);
	this.mailer = null;
};

util.inherits(Mailer, buscomponent.BusComponent);

Mailer.prototype._init = function(cb) {
	var self = this;
	
	this.getServerConfig(function(cfg) {
		self.mailer = nodemailer.createTransport(cfg.mail.transport(cfg.mail.transportData));
		self.inited = true;
		cb();
	});
};

Mailer.prototype.sendMail = buscomponent.provide('sendMail', ['opt', 'reply'], buscomponent.needsInit(function(opt, cb) {
	assert.ok(this.mailer);
	
	this.getServerConfig(function(cfg) {
		if (cfg.mail.forceTo)
			opt.to = cfg.mail.forceTo;
		if (cfg.mail.forceFrom)
			opt.to = cfg.mail.forceFrom;
		
		this.mailer.sendMail(opt, cb);
	});
}));

exports.Mailer = Mailer;

})();

