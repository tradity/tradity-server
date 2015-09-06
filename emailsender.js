(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var Q = require('q');
var assert = require('assert');
var nodemailer = require('nodemailer');
var commonUtil = require('tradity-connection');
var sha256 = require('./lib/sha256.js');
var buscomponent = require('./stbuscomponent.js');
var qctx = require('./qctx.js');

/**
 * Provides methods for sending e-mails.
 * 
 * @public
 * @module emailsender
 */

/**
 * Main object of the {@link module:emailsender} module
 * 
 * @public
 * @constructor module:emailsender~Mailer
 * @augments module:stbuscomponent~STBusComponent
 */
function Mailer () {
	Mailer.super_.apply(this, arguments);
	this.mailer = null;
};

util.inherits(Mailer, buscomponent.BusComponent);

Mailer.prototype._init = function() {
	var self = this;
	
	return this.getServerConfig().then(function(cfg) {
		var transportModule = require(cfg.mail.transport);
		self.mailer = nodemailer.createTransport(transportModule(cfg.mail.transportData));
		self.inited = true;
	});
};

/**
 * Send an e-mail based on a template.
 * This is basically a composition of {@link busreq~readEMailTemplate}
 * and {@link busreq~sendMail}.
 * 
 * @param {object} variables  See {@link busreq~readEMailTemplate}.
 * @param {string} template  See {@link busreq~readEMailTemplate}.
 * @param {?string} lang  The preferred language for the files to be read in.
 * @param {string} mailtype  See {@link busreq~sendMail}.
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * 
 * @function busreq~sendTemplateMail
 */
Mailer.prototype.sendTemplateMail = buscomponent.provide('sendTemplateMail',
	['variables', 'template', 'ctx', 'lang', 'mailtype', 'uid'],
	function(variables, template, ctx, lang, mailtype, uid) {
	var self = this;
	
	return self.request({name: 'readEMailTemplate', 
		template: template,
		lang: lang || (ctx.user && ctx.user.lang),
		variables: variables || {},
	}).then(function(opt) {
		return self.sendMail(opt, ctx, template, mailtype || (opt && opt.headers && opt.headers['X-Mailtype']) || '', uid);
	});
});

/**
 * Information about an email which could not be delivered.
 * 
 * @typedef s2c~email-bounced
 * @type {Event}
 * 
 * @property {string} messageid  The RFC822 Message-Id of the non-delivered e-mail.
 * @property {int} sendingtime  The unix timestamp of the message leaving the server.
 * @property {int} bouncetime  The unix timestamp of receiving the failure notification.
 * @property {string} mailtype  The e-mail type as set by the caller of
 *                              {@link busreq~sendMail}.
 * @property {string} mailrecipient  The <code>To:</code> mail adress.
 * @property {string} diagnostic_code  The diagnostic code send by the rejecting server.
 */

/**
 * Notifies the server about the non-delivery of mails.
 * This requires appropiate privileges.
 * 
 * @param {string} query.messageId  The RFC822 Message-Id of the e-mail as set
 *                                  by this server during sending of the mail.
 * @param {?string} query.diagnostic_code  A diagnostic code set in the e-mail.
 *                                         This may be displayed to users in order
 *                                         to help troubleshooting problems.
 * 
 * @return {object}  Returns with <code>email-bounced-notfound</code>,
 *                   <code>email-bounced-success</code> or a common error code.
 * 
 * @function c2s~email-bounced
 */
Mailer.prototype.emailBounced = buscomponent.provideW('client-email-bounced', ['query', 'internal', 'ctx'],
	function(query, internal, ctx)
{
	var self = this;
	
	if (!ctx)
		ctx = new qctx.QContext({parentComponent: self});
	
	if (!internal && !ctx.access.has('email-bounces'))
		throw new self.PermissionDenied();
	
	var mail;
	return ctx.startTransaction().then(function(conn) {
		return conn.query('SELECT mailid, uid FROM sentemails WHERE messageid = ? FOR UPDATE',
			[String(query.messageId)]).then(function(r) {
			if (r.length == 0)
				throw new self.SoTradeClientError('email-bounced-notfound');
			
			assert.equal(r.length, 1);
			mail = r[0];
			
			assert.ok(mail);
			
			return conn.query('UPDATE sentemails SET bouncetime = UNIX_TIMESTAMP(), diagnostic_code = ? WHERE mailid = ?',
				[String(query.diagnostic_code || ''), mail.mailid]);
		}).then(function() {
			if (!mail)
				return;
			
			return ctx.feed({
				'type': 'email-bounced',
				'targetid': mail.mailid,
				'srcuser': mail.uid,
				'noFollowers': true,
				conn: conn
			});
		}).then(conn.commit, conn.rollbackAndThrow);
	}).then(function() {
		return { code: 'email-bounced-success' };
	});
});

/**
 * Send an e-mail to a user.
 * 
 * @param {object} opt  General information about the mail. The format of this
 *                      is specified by the underlying SMTP module
 *                      (i.e. <code>nodemailer</code>).
 * @param {module:qctx~QContext} ctx  A QContext to provide database access.
 * @param {string} template  The name of the template used for e-mail generation.
 * @param {string} mailtype  An identifer describing the kind of sent mail.
 *                           This is useful for displaying it to the user in case
 *                           of delivery failure.
 * 
 * @function busreq~sendMail
 */
Mailer.prototype.sendMail = buscomponent.provide('sendMail',
	['opt', 'ctx', 'template', 'mailtype', 'uid'],
	buscomponent.needsInit(function(opt, ctx, template, mailtype, uid)
{
	var self = this;
	var shortId;
	
	assert.ok(self.mailer);
	
	return self.getServerConfig().then(function(cfg) {
		var origTo = opt.to;
		
		if (cfg.mail.forceTo)
			opt.to = cfg.mail.forceTo;
		if (cfg.mail.forceFrom)
			opt.from = cfg.mail.forceFrom;
		
		shortId = sha256(Date.now() + JSON.stringify(opt)).substr(0, 24) + commonUtil.locallyUnique();
		opt.messageId = '<' + shortId + '@' + cfg.mail.messageIdHostname + '>';
		
		if (ctx && !ctx.getProperty('readonly'))
			return ctx.query('INSERT INTO sentemails (uid, messageid, sendingtime, templatename, mailtype, recipient) ' +
				'VALUES (?, ?, UNIX_TIMESTAMP(), ?, ?, ?)',
				[uid || (ctx.user && ctx.user.uid) || null, String(shortId), String(template) || null,
				String(mailtype), String(origTo)]);
		
		return Q();
	}).then(function() {
		return Q.ninvoke(self.mailer, 'sendMail', opt);
	}).then(function(status) {
		if (status && status.rejected && status.rejected.length > 0)
			self.emailBounced({messageId: shortId}, true, ctx);
	}, function(err) {
		self.emailBounced({messageId: shortId}, true, ctx);
			
		if (err)
			self.emitError(err);
	});
}));

exports.Mailer = Mailer;

})();

