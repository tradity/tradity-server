(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var commonUtil = require('./common/util.js');
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

Mailer.prototype.sendTemplateMail = buscomponent.provide('sendTemplateMail',
	['variables', 'template', 'ctx', 'reply'],
	function(variables, template, ctx, cb) {
	var self = this;
	
	self.request({name: 'readEMailTemplate', 
		template: template,
		variables: variables || {},
	}, function(opt) {
		self.sendMail(opt, ctx, onFailure, template, cb);
	});
});

Mailer.prototype.sendMail = buscomponent.provide('sendMail', ['opt', 'ctx', 'template', 'reply'],
	buscomponent.needsInit(function(opt, ctx, template, cb)
{
	var self = this;
	
	assert.ok(self.mailer);
	
	onFailure = onFailure || function() {};
	
	self.getServerConfig(function(cfg) {
		if (cfg.mail.forceTo)
			opt.to = cfg.mail.forceTo;
		if (cfg.mail.forceFrom)
			opt.from = cfg.mail.forceFrom;
		
		var shortId = commonUtil.sha256(Date.now() + JSON.stringify(opt)).substr(0, 24) + commonUtil.locallyUnique();
		opt.messageId = '<' + shortId + '@' + cfg.mail.messageIdHostname + '>';
		
		(ctx ? function(cont) {
			ctx.query('INSERT INTO sentemails (uid, messageid, sendingtime, templatename) ' +
				'VALUES (?, ?, UNIX_TIMESTAMP(), ?)',
				[(ctx.user && ctx.user.id) || null, shortId, template || null], cont);
		} : function(cont) { cont(); })(function() {
			self.mailer.sendMail(opt, function(err, status) {
				if (err || status && status.rejected.length > 0)
					onFailure();
				
				if (err)
					self.emitError(err);
				
				cb();
			});
		});
	});
}));

exports.Mailer = Mailer;

})();

