(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var assert = require('assert');
var nodemailer = require('nodemailer');
var buscomponent = require('./buscomponent.js');

function MailerDB () {
	this.mailer = null;
};

util.inherits(MailerDB, buscomponent.BusComponent);

MailerDB.prototype._init = function(cb) {
	this.getServerConfig(function(cfg) {
		this.mailer = nodemailer.createTransport(cfg.mail.transport, cfg.mail.transportData);
		this.inited = true;
		cb();
	});
};

MailerDB.prototype.sendMail = buscomponent.provide('sendMail', ['opt', 'reply'], buscomponent.needsInit(function(opt, cb) {
	assert.ok(this.mailer);
	
	this.mailer.sendMail(opt, cb);
}));

exports.MailerDB = MailerDB;

})();

