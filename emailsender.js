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
	['variables', 'template', 'ctx', 'mailtype', 'reply'],
	function(variables, template, ctx, mailtype, cb) {
	var self = this;
	
	self.request({name: 'readEMailTemplate', 
		template: template,
		variables: variables || {},
	}, function(opt) {
		self.sendMail(opt, ctx, template, mailtype || opt.headers.xMailtype || '', cb);
	});
});

Mailer.prototype.emailBounced = buscomponent.provide('client-email-bounced', ['query', 'internal', 'ctx', 'reply'],
	function(query, internal, ctx, cb)
{
	cb = cb || function() {};
	
	if (!ctx)
		ctx = new QContext({parentComponent: this});
	
	if (!internal && !ctx.access.has('email-bounces'))
		return cb('permission-denied');
	
	ctx.query('SELECT mailid, uid FROM sentemails WHERE messageid = ?', [String(query.messageId)], function(r) {
		if (r.length == 0)
			return cb('email-bounced-notfound');
		
		assert.equal(r.length, 1);
		var mail = r[0];
		
		ctx.query('UPDATE sentemails SET bouncetime = UNIX_TIMESTAMP() WHERE mailid = ?', [mail.mailid], function() {
			ctx.feed({'type': 'email-bounced', 'targetid': mail.mailid, 'srcuser': mail.uid, 'noFollowers': true});
		});
	});
});

Mailer.prototype.sendMail = buscomponent.provide('sendMail',
	['opt', 'ctx', 'template', 'mailtype', 'reply'],
	buscomponent.needsInit(function(opt, ctx, template, mailtype, cb)
{
	var self = this;
	
	assert.ok(self.mailer);
	
	self.getServerConfig(function(cfg) {
		if (cfg.mail.forceTo)
			opt.to = cfg.mail.forceTo;
		if (cfg.mail.forceFrom)
			opt.from = cfg.mail.forceFrom;
		
		var shortId = commonUtil.sha256(Date.now() + JSON.stringify(opt)).substr(0, 24) + commonUtil.locallyUnique();
		opt.messageId = '<' + shortId + '@' + cfg.mail.messageIdHostname + '>';
		
		(ctx ? function(cont) {
			ctx.query('INSERT INTO sentemails (uid, messageid, sendingtime, templatename, mailtype) ' +
				'VALUES (?, ?, UNIX_TIMESTAMP(), ?, ?)',
				[(ctx.user && ctx.user.id) || null, shortId, template || null, mailtype], cont);
		} : function(cont) { cont(); })(function() {
			self.mailer.sendMail(opt, function(err, status) {
				if (err || status && status.rejected.length > 0)
					self.emailBounced({messageId: shortId}, true, ctx);
				
				if (err)
					self.emitError(err);
				
				cb();
			});
		});
	});
}));

exports.Mailer = Mailer;

})();

