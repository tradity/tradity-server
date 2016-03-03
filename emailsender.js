// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const assert = require('assert');
const nodemailer = require('nodemailer');
const commonUtil = require('tradity-connection');
const debug = require('debug')('sotrade:emailsender');
const sha256 = require('./lib/sha256.js');
const promiseUtil = require('./lib/promise-util.js');
const api = require('./api.js');
const qctx = require('./qctx.js');

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

/** */
class BouncedMailHandler extends api.Requestable {
  constructor() {
    super({
      url: '/bounced-mail',
      methods: ['POST'],
      writing: true,
      returns: [
        { code: 204 },
        { code: 404, identifer: 'mail-not-found' }
      ],
      schema: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The RFC822 Message-Id of the e-mail as set by this server during sending of the mail.'
          },
          diagnostic_code: {
            type: 'string',
            description: 'A diagnostic code set in the e-mail that may help users with troubleshooting.'
          }
        },
        required: ['messageId']
      },
      description: 'Notifies the server about the non-delivery of mails.',
      requiredAccess: 'email-bounces'
    });
  }
  
  handle(query, ctx, cfg, internal) {
    if (!ctx) {
      ctx = new qctx.QContext({parentComponent: this});
    }
    
    if (!internal && !ctx.access.has('email-bounces')) {
      throw new this.PermissionDenied();
    }
    
    debug('Email bounced', query.messageId);
    
    let mail;
    return ctx.startTransaction().then(conn => {
      return conn.query('SELECT mailid, uid FROM sentemails WHERE messageid = ? FOR UPDATE',
        [String(query.messageId)]).then(r => {
        if (r.length === 0) {
          throw new this.ClientError('mail-not-found');
        }
        
        assert.equal(r.length, 1);
        mail = r[0];
        
        assert.ok(mail);
        
        return conn.query('UPDATE sentemails SET bouncetime = UNIX_TIMESTAMP(), diagnostic_code = ? WHERE mailid = ?',
          [String(query.diagnostic_code || ''), mail.mailid]);
      }).then(() => {
        if (!mail) {
          return;
        }
        
        return ctx.feed({
          'type': 'email-bounced',
          'targetid': mail.mailid,
          'srcuser': mail.uid,
          'noFollowers': true,
          conn: conn
        });
      }).then(conn.commit, conn.rollbackAndThrow);
    }).then(() => {
      return { code: 200 };
    });
  }
}

class Mailer extends api.Component {
  constructor() {
    super({
      identifier: 'Mailer',
      description: 'Provides methods for sending e-mails.',
      depends: [BouncedMailHandler]
    });
    
    this.mailer = null;
  }
  
  init() {
    const cfg = this.load('Config').config();
    
    const transportModule = require(cfg.mail.transport);
    this.mailer = nodemailer.createTransport(transportModule(cfg.mail.transportData));
    this.inited = true;
  }

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
   */
  sendTemplateMail(variables, template, ctx, lang, mailtype, uid) {
    debug('Send templated mail', template, lang, ctx.user && ctx.user.lang);
    
    return this.load('TemplateReader').readEMailTemplate(
      template,
      lang || (ctx.user && ctx.user.lang),
      variables || {}
    ).then(opt => {
      return this.sendMail(opt, ctx, template, mailtype || (opt && opt.headers && opt.headers['X-Mailtype']) || '', uid);
    });
  }

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
   */
  sendMail(opt, ctx, template, mailtype, uid) {
    let shortId;
    
    assert.ok(this.mailer);
    
    const cfg = this.load('Config').config();
    const origTo = opt.to;
    
    if (cfg.mail.forceTo) {
      opt.to = cfg.mail.forceTo;
    }
    
    if (cfg.mail.forceFrom) {
      opt.from = cfg.mail.forceFrom;
    }
    
    shortId = sha256(Date.now() + JSON.stringify(opt)).substr(0, 24) + commonUtil.locallyUnique();
    opt.messageId = '<' + shortId + '@' + cfg.mail.messageIdHostname + '>';
    
    return Promise.resolve().then(() => {
      if (ctx && !this.load('Main').readonly) {
        return ctx.query('INSERT INTO sentemails (uid, messageid, sendingtime, templatename, mailtype, recipient) ' +
          'VALUES (?, ?, UNIX_TIMESTAMP(), ?, ?, ?)',
          [uid || (ctx.user && ctx.user.uid) || null, String(shortId), String(template) || null,
          String(mailtype), String(origTo)]);
      }
    }).then(() => {
      return promiseUtil.ncall(this.mailer.sendMail.bind(this.mailer))(opt);
    }).then(status => {
      if (status && status.rejected && status.rejected.length > 0) {
        this.load(BouncedMailHandler).handle({messageId: shortId}, ctx, true);
      }
    }, err => {
      this.load(BouncedMailHandler).handle({messageId: shortId}, ctx, true);
        
      if (err) {
        return this.load('PubSub').publish('error', err);
      }
    });
  }
}

exports.components = [
  Mailer,
  BouncedMailHandler
];
