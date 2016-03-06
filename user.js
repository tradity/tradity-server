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

const crypto = require('crypto');
const assert = require('assert');
const _ = require('lodash');
const validator = require('validator');
const genders = require('genders');
const sha256 = require('./lib/sha256.js');
const api = require('./api.js');
const qctx = require('./qctx.js');
const debug = require('debug')('sotrade:user');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;
require('datejs'); // XXX

const randomBytes = promiseUtil.ncall(crypto.randomBytes);
const pseudoRandomBytes = promiseUtil.ncall(crypto.pseudoRandomBytes);
const pbkdf2 = promiseUtil.ncall(crypto.pbkdf2);

class UserManagementRequestable extends api.Requestable {
  constructor(opt) {
    super(opt);
  }

  /**
   * Generates a password hash and salt combination.
   * 
   * @param {string} pw  The password string to generate a salt+hash for.
   * 
   * @return {object}  A Promise for an object of the form { salt: …, hash: …, algorithm: … }
   */
  generatePWKey(pw, cfg) {
    let pwsalt, iterations;
    
    return randomBytes(32).then(pwsalt_ => {
      pwsalt = pwsalt_;
      
      iterations = cfg.passwords.pbkdf2Iterations;
      assert.strictEqual(iterations, parseInt(iterations));
      assert.ok(iterations >= cfg.passwords.pbkdf2MinIterations);
      
      return pbkdf2(String(pw), pwsalt, 1 << iterations, 64);
    }).then(pwhash => {
      return {salt: pwsalt, hash: pwhash, algorithm: 'PBKDF2|' + iterations};
    });
  }

  /**
   * Writes a new hash/salt combination into the database.
   * 
   * @param {string} pw  The password string to generate a salt+hash for.
   * @param {string} timeName  Either <code>'changetime'</code> or <code>'issuetime'</code>,
   *                           depending on password type
   * @param {int} uid  The numerical user id for this password.
   * @param {object} conn  A connection to access the database with.
   * 
   * @return {object}  A Promise for having saved the password.
   */
  generatePassword(pw, timeName, uid, conn) {
    assert.ok(['changetime', 'issuetime'].indexOf(timeName) >= 0);
    
    debug('Generate password', timeName, uid);
    
    return this.generatePWKey(pw, this.load('Config').config()).then(pwdata => {
      return conn.query('INSERT INTO passwords (pwsalt, pwhash, algorithm, uid, ' + timeName + ') ' +
        'VALUES(?, ?, ?, ?, UNIX_TIMESTAMP())',
        [pwdata.salt, pwdata.hash, pwdata.algorithm, uid]);
    });
  }

  /**
   * Verifies a password hash and salt combination.
   * 
   * @param {object} pwdata  The pwsalt, pwhash, algorithm tuple to be checked against
   * @param {string} pw  The password to be checked
   * 
   * @return {object}  A Promise for a boolean indicating success
   */
  verifyPassword(pwdata, pw) {
    debug('Verify password', pwdata.algorithm);
    
    if (pwdata.algorithm === 'SHA256') {
      return Promise.resolve(pwdata.pwhash !== sha256(pwdata.pwsalt + pw));
    }
    
    const pbkdf2Match = pwdata.algorithm.match(/^PBKDF2\|(\d+)$/);
    if (pbkdf2Match) {
      const iterations = parseInt(pbkdf2Match[1]);
      
      const cfg = this.load('Config').config();
      
      if (iterations < cfg.passwords.pbkdf2MinIterations) {
        return false;
      }
      
      return pbkdf2(String(pw), pwdata.pwsalt, 1 << iterations, 64).then(pwhash => {
        return pwhash.toString('hex') === pwdata.pwhash.toString('hex');
      });
    }
    
    console.warn('Unknown password hashing algorithm:', pwdata.algorithm);
    return Promise.resolve(false);
  }
  
  isDeprecatedPasswordAlgorithm(algorithm) {
    return /^SHA256$/i.test(algorithm);
  }

  /**
   * Sends the registation e-mail to a new user or after an e-mail address change.
   * 
   * @param {object} data  General information on the receiver of the email.
   * @param {string} data.name  The username of the receiver.
   * @param {string} data.email  The e-mail adress of the receiver.
   * @param {string} data.url  The URL of the e-mail address confirmation link.
   *
   * @return  Returns with <code>reg-success</code>.
   */
  sendRegisterEmail(data, ctx, xdata) {
    ctx.access.drop('email_verif');
    
    debug('Prepare register email', data.email);
    
    let loginResp, key;
    return this.login({
      name: data.email,
      stayloggedin: true,
    }, ctx, xdata, true, true).then(loginResp_ => {
      loginResp = loginResp_;
      assert.ok(loginResp.code >= 200 && loginResp.code <= 299);
      
      return randomBytes(16);
    }).then(buf => {
      key = buf.toString('hex');
      
      return ctx.query('INSERT INTO email_verifcodes (`uid`, `time`, `key`) VALUES(?, UNIX_TIMESTAMP(), ?)', 
        [ctx.user.uid, key]);
    }).then(() => {
      const cfg = this.load('Config').config();
      
      const url = cfg.varReplace(cfg.regurl
        .replace(/\{\$key\}/g, key)
        .replace(/\{\$uid\}/g, ctx.user.uid));
      
      debug('Send register email', data.email, data.lang, data.name, ctx.user.uid);
      return this.load('sendTemplateMail').sendTemplateMail(
        {'url': url, 'username': data.name, 'email': data.email},
        'register-email.eml',
        ctx, data.lang
      );
    }).then(() => {
      loginResp.code = 204;
      return loginResp;
    });
  }
}

class Login extends UserManagementRequestable {
  constructor() {
    super({
      url: '/login',
      requiredLogin: false,
      methods: ['POST'],
      returns: [
        { code: 200 },
        { code: 403, identifier: 'wrong-username-pw' }
      ],
      writing: 'maybe',
      description: 'Logs a user into their account.',
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A user name or e-mail address'
          },
          pw: {
            type: 'string',
            description: 'The user’s password'
          },
          stayloggedin: {
            type: 'boolean',
            description: 'Whether the user wishes to remain logged in for an extended period of time'
          }
        },
        required: ['name', 'pw', 'stayloggedin']
      },
      depends: ['Achievements', 'SignedMessaging']
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata, useTransaction, ignorePassword) {
    const name = String(query.name);
    const pw = String(query.pw);
    let key, uid;
    
    debug('Login', xdata.remoteip, name, useTransaction, ignorePassword);
    
    return Promise.resolve().then(() => {
      const query = 'SELECT passwords.*, users.email_verif ' +
        'FROM passwords ' +
        'JOIN users ON users.uid = passwords.uid ' +
        'WHERE (email = ? OR name = ?) AND deletiontime IS NULL ' +
        'ORDER BY email_verif DESC, users.uid DESC, changetime DESC FOR UPDATE';

      if (this.load('ReadonlyStore').readonly || !useTransaction) {
        return ctx.query(query, [name, name]);
      }
      
      return ctx.startTransaction().then(conn => {
        return conn.query(query, [name, name]).then(conn.commit, conn.rollbackAndThrow);
      });
    }).then(res => {
      if (res.length === 0) {
        if (!useTransaction) {
          return this.handleWithRequestInfo(query, ctx, cfg, xdata, true, ignorePassword);
        }
        
        throw new this.ClientError('wrong-username-pw');
      }
      
      /* if there is an user with a verified e-mail address
       * do not allow other users with the same e-mail address to log in */
      const haveVerifiedEMail = _.some(_.map(res, 'email_verif'));
      
      return res.map(r => {
        return (foundUser => {
          if (foundUser !== null) {
            return foundUser; // already found user id -> ok!
          }
          
          if (haveVerifiedEMail && !r.email_verif) {
            return null;
          }
          
          if (ignorePassword) {
            return r;
          }
          
          return this.verifyPassword(r, pw).then(passwordOkay => {
            return passwordOkay ? r : null;
          });
        });
      }).reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve(null));
    }).then(r => {
      if (r === null) {
        if (!useTransaction) {
          return this.handleWithRequestInfo(query, ctx, cfg, xdata, true, ignorePassword);
        }
        
        throw new this.ClientError('wrong-username-pw');
      }
      
      uid = r.uid;
      assert.equal(parseInt(r.pwid), r.pwid);
      assert.equal(parseInt(uid), uid);
      
      if (this.load('ReadonlyStore').readonly) {
        return;
      }
      
      const achievementsCtx = ctx.clone();
      achievementsCtx.user = { uid: uid };
      this.load('Achievements').checkAchievements(achievementsCtx);
      
      debug('Update passwords', xdata.remoteip, name, uid, r.pwid);
      return Promise.all([
        ctx.query('DELETE FROM passwords WHERE pwid != ? AND uid = ?', [r.pwid, uid]),
        r.issuetime !== null ? ctx.query('UPDATE passwords SET changetime = UNIX_TIMESTAMP() WHERE pwid = ?', [r.pwid]) : Promise.resolve(),
        this.isDeprecatedPasswordAlgorithm(r.algorithm) ? this.generatePassword(pw, 'changetime', uid, ctx) : Promise.resolve()
      ]);
    }).then(() => {
      return randomBytes(16);
    }).then(buf => {
      key = buf.toString('hex');
      
      const today = parseInt(Date.now() / 86400);
      if (this.load('ReadonlyStore').readonly) {
        key = key.substr(0, 6);
        
        debug('Sign session key', xdata.remoteip, name, uid, today);
        
        return this.load('SignedMessaging').createSignedMessage({
          uid: uid,
          sid: key,
          date: today
        }).then(sid => {
          return { code: 200,
            key: ':' + sid,
            uid: uid,
            repush: true
          };
        });
      } else {
        return ctx.startTransaction().then(conn => {
          debug('Add session to table', xdata.remoteip, name, uid, today);
          
          return conn.query('INSERT INTO sessions(uid, `key`, logintime, lastusetime, endtimeoffset)' +
            'VALUES(?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?)',
            [uid, key, query.stayloggedin ? cfg.stayloggedinTime : cfg.normalLoginTime])
            .then(conn.commit, conn.rollbackAndThrow);
        }).then(() => {
          return { code: 200, key: key, uid: uid };
        });
      }
    });
  }
}

class Logout extends UserManagementRequestable {
  constructor() {
    super({
      url: '/logout',
      methods: ['POST'],
      returns: [
        { code: 200 }
      ],
      writing: true,
      description: 'Logs a user out of their account.'
    });
  }
  
  handle(query, ctx) {
    debug('Logout', query.key);
    
    return ctx.query('DELETE FROM sessions WHERE `key` = ?', [String(query.key)]).then(() => {
      return { code: 200, key: null };
    });
  }
}

class EmailVerify extends api.Requestable {
  constructor() {
    super({
      url: '/verify-email',
      methods: ['POST'],
      returns: [
        { code: 200 },
        { code: 403, identifier: 'already-verified' },
        { code: 403, identifier: 'other-already-verified' },
        { code: 404, identifier: 'email-not-found' },
        { code: 404, identifier: 'code-not-found' }
      ],
      writing: true,
      requiredLogin: false,
      schema: {
        type: 'object',
        properties: {
          uid: {
            type: 'integer',
            description: 'The assigned user id.',
          },
          key: {
            type: 'string',
            description: 'The key from the confirmation link.'
          }
        },
        required: ['uid', 'key']
      },
      description: 'Verify a user’s e-mail address with the key from the confirmation link.',
      depends: [Login]
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata) {
    const uid = parseInt(query.uid);
    const key = String(query.key);
    let email;
    
    debug('Verify email', uid);
    
    return ctx.startTransaction().then(conn => {
      return conn.query('SELECT email_verif, email FROM users WHERE uid = ? LOCK IN SHARE MODE', [uid])
      .then(res => {
        if (res.length !== 1) {
          throw new this.ClientError('email-not-found');
        }
        
        email = res[0].email;
        if (res[0].email_verif) {
          throw new this.ClientError('already-verified');
        }
        
        return conn.query('SELECT COUNT(*) AS c FROM email_verifcodes WHERE uid = ? AND `key` = ? FOR UPDATE', [uid, key]);
      }).then(res => {
        assert.equal(res.length, 1);
        
        if (res[0].c < 1 && !ctx.access.has('userdb')) {
          throw new this.ClientError('code-not-found');
        }
        
        return conn.query('SELECT COUNT(*) AS c FROM users WHERE email = ? AND email_verif = 1 AND uid != ? LOCK IN SHARE MODE', [email, uid]);
      }).then(res => {
        if (res[0].c > 0) {
          throw new this.ClientError('other-already-verified');
        }
      
        return conn.query('DELETE FROM email_verifcodes WHERE uid = ?', [uid]);
      }).then(() => {
        return conn.query('UPDATE users SET email_verif = 1 WHERE uid = ?', [uid]);
      }).then(() => {
        ctx.access.grant('email_verif');
      }).then(conn.commit, conn.rollbackAndThrow);
    }).then(() => {
      return this.load(Login).handle({
        name: email,
        stayloggedin: true,
      }, new qctx.QContext({access: ctx.access, parentComponent: this}), xdata, true, true);
    });
  }
}

class UpdateUserStatistics extends api.Component {
  constructor() {
    super({
      identifier: 'UpdateUserStatistics',
      description: 'Write session and statistics information to the database.',
      notes: 'Sets the session’s last use date to make sure it does not expire.\n' +
        'This function usually writes data at most once per minute to reduce database writes.',
      depends: ['ReadonlyStore']
    });
  }
  
  handle(user, ctx, force) {
    if (!user) {
      return Promise.resolve();
    }
    
    const now = Date.now();
    const lastSessionUpdate = ctx.properties.get('lastSessionUpdate');
    
    if (((!lastSessionUpdate || (now - lastSessionUpdate) < 60000) && !force) ||
      this.load('ReadonlyStore').readonly ||
      !user)
    {
      // don't update things yet
      ctx.properties.set('pendingTicks', ctx.properties.get('pendingTicks') + 1);
      
      return Promise.resolve();
    } else {
      const ticks = ctx.properties.get('pendingTicks');
      ctx.properties.set('pendingTicks', 0);
      ctx.properties.set('lastSessionUpdate', now);
      
      debug('Adding ticks', user.uid, ticks);
      
      return Promise.all([
        ctx.query('UPDATE sessions SET lastusetime = UNIX_TIMESTAMP() WHERE id = ?', [user.sid]),
        ctx.query('UPDATE globalvars SET value = ? + value WHERE name="ticks"', [ticks, user.uid])
      ]);
    }
  }
}

class LoadSessionUser extends api.Component {
  constructor() {
    super({
      identifier: 'LoadSessionUser',
      description: 'Load information on the current user from the database.',
      depends: ['ReadonlyStore', 'UpdateUserStatistics', 'SignedMessaging']
    });
  }
  
  handle(key, ctx) {
    const signedLogin = (key[0] === ':');
    
    return Promise.resolve().then(() => {
      if (!signedLogin) {
        return {uid: null, key: key};
      }
      
      // was signed login, e. g. during read-only period
      return this.load('SignedMessaging').verifySignedMessage(key.substr(1))
        .then(msg => {
        const today = parseInt(Date.now() / 86400);
        if (!msg || msg.date <= today - 1) { // message at least 24 hours old
          return null;
        }
        
        debug('Verified user in readonly mode', msg.uid);
        return { uid: msg.uid, key: msg.sid };
      });
    }).then(loginInfo => {
      if (!loginInfo) {
        return null;
      }
      
      return ctx.query('SELECT users.*, users_finance.*, users_data.*, users.uid AS uid, ' +
        (signedLogin ? '' : 'sessions.id AS sid, ') +
        'schools.path AS schoolpath, schools.schoolid AS schoolid, schools.name AS schoolname, jointime, sm.pending AS schoolpending ' +
        'FROM users ' +
        'JOIN users_finance ON users_finance.uid = users.uid ' +
        'JOIN users_data ON users_data.uid = users.uid ' +
        (signedLogin ? '' : 'JOIN sessions ON sessions.uid = users.uid ') +
        'LEFT JOIN schoolmembers AS sm ON sm.uid = users.uid ' +
        'LEFT JOIN schools ON schools.schoolid = sm.schoolid ' +
        'WHERE ' + (signedLogin ? 'users.uid = ? ' : '`key` = ? ' +
        (this.load('ReadonlyStore').readonly ? '' : 'AND lastusetime + endtimeoffset > UNIX_TIMESTAMP() ')) +
        'LIMIT 1', [signedLogin ? loginInfo.uid : loginInfo.key])
      .then(res => {
        if (res.length === 0) {
          return null;
        }
        
        assert.equal(res.length, 1);
        const user = res[0];
        
        assert.ok(user.uid === loginInfo.uid || loginInfo.uid === null);
        
        user.realnamepublish = !!user.realnamepublish;
        user.delayorderhist = !!user.delayorderhist;
        
        try {
          user.clientopt = JSON.parse(user.clientopt);
        } catch (e) {
          user.clientopt = {};
        }
        
        if (signedLogin) {
          user.sid = loginInfo.key;
        }
        
        debug('Loaded user', user.uid);
        
        return Promise.resolve().then(() => {
          return this.load('UpdateUserStatistics').handle(user, ctx);
        }).then(() => user);
      });
    });
  }
}

class ValidateUsername extends api.Requestable {
  constructor() {
    super({
      url: '/validate-username/:name',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 403, identifier: 'invalid-char' },
        { code: 403, identifier: 'already-present' },
      ],
      requiredLogin: false,
      description: 'Checks that a username is valid.',
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The (possible) user name'
          },
          uid: {
            type: 'integer',
            description: '(Used internally)'
          }
        },
        required: ['name']
      }
    });
  }
  
  handle(query, ctx) {
    const uid = query.uid;
    
    if (!/^[^\.,@<>\x00-\x20\x7f!"'\/\\$#()^?&{}%]+$/.test(query.name) ||
      parseInt(query.name) === parseInt(query.name)) {
      throw new this.ClientError('invalid-char');
    }
    
    return ctx.query('SELECT uid FROM users ' +
      'WHERE (name = ?) ORDER BY NOT(uid != ?) FOR UPDATE',
      [query.name, uid]).then(res => {
      
      if (res.length > 0 && res[0].uid !== uid) {
        throw new this.ClientError('already-present');
      }
      
      return { code: 200 };
    });
  }
}

class ValidateEmail extends api.Requestable {
  constructor() {
    super({
      url: '/validate-email/:email',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 403, identifier: 'invalid-email' },
        { code: 403, identifier: 'already-present' },
      ],
      requiredLogin: false,
      description: 'Checks that an email address is valid.',
      schema: {
        type: 'object',
        properties: {
          email: {
            type: 'string',
            description: 'The (possible) email address.'
          },
          uid: {
            type: 'integer',
            description: '(Used internally)'
          }
        },
        required: ['email']
      }
    });
  }
  
  handle(query, ctx) {
    const uid = query.uid;
    
    if (!validator.isEmail(query.email)) {
      throw new this.ClientError('invalid-email');
    }
    
    return ctx.query('SELECT uid FROM users ' +
      'WHERE email = ? AND email_verif ORDER BY NOT(uid != ?) FOR UPDATE',
      [query.email, uid]).then(res => {
      if (res.length > 0 && res[0].uid !== uid) {
        throw new this.ClientError('already-present');
      }
      
      return { code: 200 };
    });
  }
}

class UpdateUserRequestable extends UserManagementRequestable {
  constructor(options) {
    super(Object.assign({}, {
      returns: [
        { code: 200 },
        { code: 403, identifier: 'already-logged-in' },
        { code: 403, identifier: 'too-short-pw' },
        { code: 403, identifier: 'unknown-gender' },
        { code: 403, identifier: 'invalid-provision' },
        { code: 403, identifier: 'beta-necessary' },
        { code: 403, identifier: 'invalid-email' },
        { code: 403, identifier: 'email-already-present' },
        { code: 403, identifier: 'name-already-present' },
        { code: 404, identifier: 'unknown-school' },
        { code: 404, identifier: 'unknown-school' },
      ],
      schema: {
        type: 'object',
        properties: {
          betakey: { type: ['string', 'null'] },
          email: { type: 'string' },
          name: { type: 'string' },
          gender: { type: ['string', 'null'] },
          giv_name: { type: ['string', 'null'] },
          fam_name: { type: ['string', 'null'] },
          wprovision: { type: ['integer', 'null'] },
          lprovision: { type: ['integer', 'null'] },
          birthday: { type: ['integer', 'null'] },
          desc: { type: ['string', 'null'] },
          street: { type: ['string', 'null'] },
          town: { type: ['string', 'null'] },
          zipcode: { type: ['string', 'null'] },
          lang: { type: ['string', 'null'] },
          school: { type: ['string', 'integer', 'null'] },
          schoolclass: { type: ['string', 'null'] },
          realnamepublish: { type: 'boolean' },
          invitekey: { type: 'string' }
        },
        required: ['email', 'name']
      },
      writing: true,
      depends: [ValidateEmail, ValidateUsername]
    }, options));
  }
  
  updateUser(query_, type, ctx, cfg, xdata) {
    // make a copy since we actually want to provide defaults for some values here
    const query = Object.assign({}, query_);
    
    debug('Update user', type, ctx.user && ctx.user.uid);
    
    const betakey = query.betakey ? String(query.betakey).split('-') : [0,0];
    
    let uid;
    let gainUIDCBs = [];
    
    return Promise.resolve().then(() => {
      uid = ctx.user !== null ? ctx.user.uid : null;
      
      if ((query.password || type !== 'change') && (!query.password || query.password.length < 5)) {
        throw new this.ClientError('too-short-pw');
      }
      
      if (query.gender !== null && genders.genders.indexOf(query.gender) === -1) {
        throw new this.ClientError('unknown-gender');
      }
      
      query.giv_name = String(query.giv_name || '');
      query.fam_name = String(query.fam_name || '');
      query.wprovision = parseInt(query.wprovision) || cfg.defaultWProvision;
      query.lprovision = parseInt(query.lprovision) || cfg.defaultLProvision;
      query.birthday = query.birthday ? parseInt(query.birthday) : null;
      query.street = query.street ? String(query.street) : null;
      query.town = query.town ? String(query.town) : null;
      query.zipcode = query.zipcode ? String(query.zipcode) : null;
      
      if (query.wprovision < cfg.minWProvision || query.wprovision > cfg.maxWProvision ||
        query.lprovision < cfg.minLProvision || query.lprovision > cfg.maxLProvision) {
        throw new this.ClientError('invalid-provision');
      }
      
      query.lang = String(query.lang || cfg.languages[0].id);
      if (_.chain(cfg.languages).map('id').indexOf(query.lang).value() === -1) {
        throw new this.ClientError('invalid-language');
      }
      
      if (!query.school) { // e.g. empty string
        query.school = null;
      }
      
      return ctx.startTransaction();
    }).then(conn => {
      return Promise.all([
        (ctx.user && query.email === ctx.user.email) ||
          this.load(ValidateEmail).handle({ email: query.email, uid: uid }, conn),
        (ctx.user && query.name === ctx.user.name) ||
          this.load(ValidateUsername).handle({ name: query.name, uid: uid }, conn)
      ]).then(() => {
      return conn.query('SELECT `key` FROM betakeys WHERE `id` = ? FOR UPDATE',
        [betakey[0]]);
    }).then(βkey => {
      if (cfg.betakeyRequired && (βkey.length === 0 || βkey[0].key !== betakey[1]) && 
        type === 'register' && !ctx.access.has('userdb')) {
        throw new this.ClientError('beta-necessary');
      }
      
      if (query.school === null) {
        return [];
      }
      
      return conn.query('SELECT schoolid FROM schools WHERE ? IN (schoolid, name, path) FOR UPDATE', [String(query.school)]);
    }).then(res => {
      if (res.length === 0 && query.school !== null) {
        if (parseInt(query.school) === parseInt(query.school) || !query.school) {
          throw new this.ClientError('unknown-school');
        }
        
        let possibleSchoolPath = '/' + String(query.school).toLowerCase().replace(/[^\w_-]/g, '');
        
        return conn.query('SELECT COUNT(*) AS c FROM schools WHERE path = ?', [possibleSchoolPath]).then(psRes => {
          assert.equal(psRes.length, 1);
          
          if (psRes[0].c === 0) { /* no collision, no additional identifier needed */
            return null;
          }
          
          return pseudoRandomBytes(3);
        }).then(rand => {
          if (rand) {
            possibleSchoolPath += '-' + rand.toString('base64') + String(Date.now()).substr(3, 4);
          }
          
          debug('Create school for user update', possibleSchoolPath);
          
          return conn.query('INSERT INTO schools (name, path) VALUES(?, ?)',
            [String(query.school), possibleSchoolPath]);
        });
      } else {
        if (query.school !== null) {
          assert.ok(parseInt(query.school) !== query.school || query.school === res[0].schoolid);
          query.school = res[0].schoolid;
        }
        
        return [];
      }
    }).then(res => {
      if (res && res.insertId) {
        // in case school was created
        
        const schoolid = res.insertId;
        query.school = schoolid;
        
        gainUIDCBs.push(() => {
          assert.equal(uid, parseInt(uid));
          
          return ctx.feed({
            'type': 'school-create',
            'targetid': schoolid,
            'srcuser': uid,
            'conn': conn
          });
        });
      }
      
      if (type === 'change') {
        return Promise.all([
          conn.query('UPDATE users SET name = ?, email = ?, email_verif = ?, ' +
            'delayorderhist = ?, skipwalkthrough = ? WHERE uid = ?',
            [String(query.name),
            String(query.email), query.email === ctx.user.email ? 1 : 0, 
            query.delayorderhist ? 1:0, query.skipwalkthrough ? 1:0, uid]),
          conn.query('UPDATE users_data SET giv_name = ?, fam_name = ?, realnamepublish = ?, ' +
            'birthday = ?, `desc` = ?, street = ?, zipcode = ?, town = ?, traditye = ?, ' +
            'clientopt = ?, dla_optin = ?, schoolclass = ?, lang = ?, gender = ? WHERE uid = ?',
            [String(query.giv_name), String(query.fam_name), query.realnamepublish?1:0,
            query.birthday, String(query.desc), String(query.street),
            String(query.zipcode), String(query.town), JSON.stringify(query.clientopt || {}),
            query.traditye?1:0, query.dla_optin?1:0, String(query.schoolclass || ''),
            String(query.lang), query.gender, uid]),
          conn.query('UPDATE users_finance SET wprovision = ?, lprovision = ? WHERE uid = ?',
            [query.wprovision, query.lprovision, uid]),
          query.password ? this.generatePassword(query.password, 'changetime', uid, conn) : Promise.resolve()
        ]).then(() => {
          if (query.school === ctx.user.school) {
            return;
          }
          
          return Promise.resolve().then(() => {
            if (ctx.user.school !== null) {
              return conn.query('DELETE FROM schooladmins WHERE uid = ? AND schoolid = ?', [uid, ctx.user.school]);
            }
          }).then(() => {
            if (query.school === null) {
              return conn.query('DELETE FROM schoolmembers WHERE uid = ?', [uid]);
            }
            
            return conn.query('REPLACE INTO schoolmembers (uid, schoolid, pending, jointime) '+
              'VALUES(?, ?, ' + (ctx.access.has('schooldb') ? '0' :
                '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0)') + ', UNIX_TIMESTAMP())',
              [uid, String(query.school), String(query.school)]);
          });
        }).then(() => {
          if (query.name === ctx.user.name) {
            return;
          }
          
          return ctx.feed({
            'type': 'user-namechange',
            'targetid': uid,
            'srcuser': uid,
            'json': {'oldname': ctx.user.name, 'newname': query.name},
            'conn': conn
          }).then(() => {
            return conn.query('UPDATE stocks SET name = ? WHERE leader = ?', ['Leader: ' + query.name, uid]);
          });
        }).then(() => {
          if (query.wprovision === ctx.user.wprovision && query.lprovision === ctx.user.lprovision) {
            return;
          }
          
          return ctx.feed({'type': 'user-provchange', 'targetid': uid, 'srcuser': uid, json:
            {'oldwprov': ctx.user.wprovision, 'newwprov': query.wprovision,
             'oldlprov': ctx.user.lprovision, 'newlprov': query.lprovision}, 'conn': conn});
        }).then(() => {
          if (query.desc === ctx.user.desc) {
            return;
          }
          
          return ctx.feed({'type': 'user-descchange', 'targetid': uid, 'srcuser': uid, 'conn': conn});
        });
      } else {
        let inv = {};
        return Promise.resolve().then(() => {
          if (query.betakey) {
            return conn.query('DELETE FROM betakeys WHERE id = ?', [betakey[0]]);
          }
        }).then(() => {
          if (!query.invitekey) {
            return;
          }
          
          return conn.query('SELECT * FROM invitelink WHERE `key` = ?', [String(query.invitekey)]).then(invres => {
            if (invres.length === 0) {
              return;
            }
            
            assert.equal(invres.length, 1);
            
            inv = invres[0];
            if (inv.schoolid && !query.school || parseInt(query.school) === parseInt(inv.schoolid)) {
              query.school = inv.schoolid;
              inv.__schoolverif__ = 1;
            }
            
            gainUIDCBs.push(() => {
              return conn.query('INSERT INTO inviteaccept (iid, uid, accepttime) VALUES(?, ?, UNIX_TIMESTAMP())', [inv.iid, uid]);
            });
          });
        }).then(() => {
          return conn.query('INSERT INTO users ' +
            '(name, delayorderhist, email, email_verif, registertime) ' +
            'VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())',
            [String(query.name), query.delayorderhist?1:0,
            String(query.email), (inv.email && inv.email === query.email) ? 1 : 0]);
        }).then(res => {
          uid = res.insertId;
          
          return query.password ? this.generatePassword(query.password, 'changetime', uid, conn) : Promise.resolve();
        }).then(() => {
          return conn.query('INSERT INTO users_data (uid, giv_name, fam_name, realnamepublish, traditye, ' +
            'street, zipcode, town, schoolclass, lang, gender) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?); ' +
            'INSERT INTO users_finance(uid, wprovision, lprovision, freemoney, totalvalue) '+
            'VALUES (?, ?, ?, ?, ?)',
            [uid, String(query.giv_name), String(query.fam_name), query.realnamepublish?1:0,
            query.traditye?1:0, String(query.street), String(query.zipcode), String(query.town),
            String(query.schoolclass || ''), String(query.lang), query.gender,
            uid, cfg.defaultWProvision, cfg.defaultLProvision,
            cfg.defaultStartingMoney, cfg.defaultStartingMoney]);
        }).then(() => {
          return ctx.feed({'type': 'user-register', 'targetid': uid, 'srcuser': uid, 'conn': conn});
        }).then(() => {
          return conn.query('INSERT INTO stocks (stocktextid, leader, name, exchange, pieces) VALUES(?, ?, ?, ?, 100000000)',
            ['__LEADER_' + uid + '__', uid, 'Leader: ' + query.name, 'tradity']);
        }).then(() => {
          if (query.school) {
            return conn.query('INSERT INTO schoolmembers (uid, schoolid, pending, jointime) ' +
              'VALUES(?, ?, ' + 
              (inv.__schoolverif__ ? '1' : '((SELECT COUNT(*) FROM schooladmins WHERE schoolid = ? AND status="admin") > 0) ') +
              ', UNIX_TIMESTAMP())',
              [uid, String(query.school), String(query.school)]);
          }
        });
      }
    }).then(() => {
      assert.strictEqual(uid, parseInt(uid));
      
      return gainUIDCBs.reduce((a,b) => Promise.resolve(a).then(b), Promise.resolve());
    }).then(conn.commit, conn.rollbackAndThrow);
    }).then(() => {
      if ((ctx.user && query.email === ctx.user.email) || (ctx.access.has('userdb') && query.nomail)) {
        return { code: 200, data: { uid: uid }, repush: true };
      }
      
      return this.sendRegisterEmail(query,
        new qctx.QContext({user: {uid: uid}, access: ctx.access,
          parentComponent: this}),
        xdata);
    });
  }
}

class Register extends UpdateUserRequestable {
  constructor() {
    super({
      url: '/register',
      methods: ['POST'],
      requiredLogin: false,
      description: 'Sets up a new user.'
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata) {
    if (ctx.user !== null) {
      throw new this.ClientError('already-logged-in');
    }
    
    return this.updateUser(query, 'register', ctx, cfg, xdata);
  }
}

class ChangeOptions extends UpdateUserRequestable {
  constructor() {
    super({
      url: '/options',
      methods: ['PUT'],
      requiredLogin: false,
      description: 'Changes the settings and general information for the current user.'
    });
  }
  
  handleWithRequestInfo(query, ctx, cfg, xdata) {
    return this.updateUser(query, 'change', ctx, cfg, xdata);
  }
}

/**
 * Indicates that a user changed their username
 * 
 * @typedef s2c~user-namechange
 * @type {Event}
 * 
 * @property {string} oldname  The user’s name before the change
 * @property {string} newname  The user’s name after the change
 */

/**
 * Indicates that a user changed their leader provisions
 * 
 * @typedef s2c~user-provchange
 * @type {Event}
 * 
 * @property {int} oldwprov  The user’s gain provision before the change
 * @property {int} newwprov  The user’s gain provision after the change
 * @property {int} oldlprov  The user’s loss provision before the change
 * @property {int} newlprov  The user’s loss provision after the change
 */

/**
 * Indicates that a user changed their description text
 * 
 * @typedef s2c~user-descchange
 * @type {Event}
 */

/** */
class ResetUser extends api.Requestable {
  constructor() {
    super({
      url: '/reset-user',
      methods: ['POST'],
      returns: [
        { code: 204 }
      ],
      writing: true,
      requiredAccess: 'userdb',
      description: 'Resets the current user financially into their initial state.',
      depends: ['SellAllStocks']
    });
  }
  
  handle(query, ctx, cfg) {
    debug('Reset user', ctx.user.uid);
    
    if (!cfg.resetAllowed && !ctx.access.has('userdb')) {
      throw new this.Forbidden();
    }
    
    assert.ok(ctx.user);
    assert.ok(ctx.access);
    
    return ctx.query('DELETE FROM depot_stocks WHERE uid = ?', [ctx.user.uid]).then(() => {
      return ctx.query('UPDATE users_finance SET freemoney = ?, totalvalue = ?, ' +
        'fperf_bought = 0, fperf_cur = 0, fperf_sold = 0, ' + 
        'operf_bought = 0, operf_cur = 0, operf_sold = 0, ' + 
        'wprov_sum = 0, lprov_sum = 0 ' + 
        'WHERE uid = ?', [cfg.defaultStartingMoney, cfg.defaultStartingMoney, ctx.user.uid]);
    }).then(() => {
      return this.load('SellAllStocks').handle(query, ctx);
    }).then(() => {
      const val = cfg.defaultStartingMoney / 1000;
      
      return Promise.all([
        ctx.query('UPDATE stocks SET lastvalue = ?, ask = ?, bid = ?, ' +
          'daystartvalue = ?, weekstartvalue = ?, lastchecktime = UNIX_TIMESTAMP() WHERE leader = ?',
          [val, val, val, val, val, ctx.user.uid]),
        ctx.query('DELETE FROM valuehistory WHERE uid = ?', [ctx.user.uid]),
        ctx.feed({'type': 'user-reset', 'targetid': ctx.user.uid, 'srcuser': ctx.user.uid}),
        this.load('PubSub').publish('DelayedQueries:resetUser', { uid: ctx.user.uid })
      ]);
    }).then(() => ({ code: 204 }));
  }
}

class ListGenders extends api.Requestable {
  constructor() {
    super({
      url: '/genders',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      requiredLogin: false,
      description: 'Returns a list of genders for users to pick from.'
    });
  }
  
  handle(query, ctx) {
    return Promise.resolve().then(() => {
      if (this.cache.has('gender-statistics')) {
        return this.cache.use('gender-statistics');
      }
      
      return this.cache.add('gender-statistics', 60000,
        ctx.query('SELECT gender, COUNT(gender) AS gc FROM users_data GROUP BY gender ORDER BY gc DESC'));
    }).catch(e => {
      console.error('Error loading gender list', e);
      /* if something went wrong, everything still is just fine */
      return [];
    }).then(stats => {
      const genderRanking = _.map(stats, 'gender').slice(0, 4);
      genders.genders = _.sortBy(genders.genders, gender => {
        let rankingIndex = genderRanking.indexOf(gender);
        if (rankingIndex === -1) {
          rankingIndex = Infinity;
        }
        
        return [rankingIndex, gender];
      });
      
      return {
        code: 200,
        data: genders
      };
    });
  }
}

class ResetPassword extends UserManagementRequestable {
  constructor() {
    super({
      url: '/reset-password',
      methods: ['POST'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'user-not-found' },
        { code: 403, identifier: 'already-logged-in' },
      ],
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' }
        },
        required: ['name']
      },
      requiredLogin: false,
      writing: true,
      description: 'Resets the current user’s password.',
      depends: ['Mailer']
    });
  }
  
  handle(query, ctx) {
    if (ctx.user) {
      throw new this.ClientError('already-logged-in');
    }
    
    const name = String(query.name);
    let pw, u;
    
    debug('Reset password', name);
    
    return ctx.query('SELECT users.uid, email, lang ' +
      'FROM users ' +
      'JOIN users_data ON users.uid = users_data.uid ' +
      'WHERE name = ? OR email = ? AND deletiontime IS NULL ' +
      'LIMIT 1 FOR UPDATE',
      [name, name]).then(res => {
      if (res.length === 0) {
        throw new this.ClientError('user-not-found');
      }
      
      u = res[0];
      assert.ok(u);
      
      return randomBytes(8);
    }).then(buf => {
      pw = buf.toString('hex');
      return this.generatePassword(pw, 'issuetime', u.uid, ctx);
    }).then(() => {
      return this.load('Mailer').sendTemplateMail(
        {'password': pw, 'username': query.name, 'email': u.email},
        'password-reset-email.eml',
        ctx, u.lang, null, u.uid
      );
    }).then(() => ({ code: 200 }));
  }
}

class InviteKeyInfo extends api.Requestable {
  constructor() {
    super({
      url: '/invitekey/:invitekey',
      methods: ['GET'],
      returns: [
        { code: 200 },
        { code: 404, identifier: 'key-not-found' }
      ],
      schema: {
        type: 'object',
        properties: {
          invitekey: { type: 'string' }
        },
        required: ['invitekey']
      },
      requiredLogin: false,
      description: 'Returns basic information on an invitation key.'
    });
  }
  
  handle(query, ctx, cfg) {
    return ctx.query('SELECT email, schoolid FROM invitelink WHERE `key` = ?',
      [String(query.invitekey)]).then(res => {
      if (res.length === 0) {
        throw new this.ClientError('key-not-found');
      }
    
      assert.equal(res.length, 1);
      
      res[0].url = cfg.varReplace(cfg.inviteurl.replace(/\{\$key\}/g, String(query.invitekey)));
      
      return { code: 200, data: res[0] };
    });
  }
}

class CreateInviteLink extends api.Component {
  constructor() {
    super({
      identifier: 'CreateInviteLink',
      description: 'Sends an invite e-mail to a user.',
      depends: ['Mailer']
    });
  }

  /**
   * Sends an invite e-mail to a user.
   * 
   * @param {object} data  General information on sender and receiver of the e-mail.
   * @param {string} data.sender.name  The username of the sender.
   * @param {string} data.sender.email  The e-mail address of the sender.
   * @param {string} data.email  The e-mail adress of the receiver.
   * @param {string} data.url  The URL of the invite link.
   * @param {module:qctx~QContext} ctx  A QContext to provide database access.
   * 
   * @return  Returns with <code>{ code: 204 }</code>.
   */
  sendInviteEmail(data, ctx) {
    debug('Send invite email', data.email, data.url, ctx.user && ctx.user.uid);
    
    return this.load('Mailer').sendTemplateMail(
      {'sendername': data.sender.name, 'sendermail': data.sender.email, 'email': data.email, 'url': data.url},
      'invite-email.eml', ctx
    ).then(() => ({ code: 200 }));
  }
  
  handle(query, ctx, cfg, ErrorProvider, schoolid) {
    ctx = ctx.clone(); // so we can’t lose the user object during execution
    
    debug('Create invite link for', ctx.user.uid, query.email, schoolid);
    
    let sendKeyToCaller = ctx.access.has('userdb');
    let key, url, email;
    
    schoolid = typeof schoolid !== 'undefined' ? schoolid : query.schoolid;
    
    if (typeof schoolid === 'undefined') {
      schoolid = null;
    }
    
    if (schoolid && isNaN(parseInt(schoolid))) {
      throw new ErrorProvider.BadRequest(new Error('Need school id'));
    }
    
    return Promise.resolve().then(() => {
      email = query.email ? String(query.email) : null;
      
      if (!ctx.access.has('userdb')) {
        if (email && !/([\w_+.-]+)@([\w.-]+)$/.test(email)) { // XXX validator.js
          throw new ErrorProvider.ClientError('invalid-email');
        }
        
        if (!ctx.access.has('email_verif')) {
          throw new ErrorProvider.ClientError('email-not-verified');
        }
      }
      
      return Promise.all([
        pseudoRandomBytes(16),
        ctx.query('SELECT COUNT(*) AS c FROM schools WHERE schoolid = ?', [schoolid])
      ]);
    }).then(spread((buf, schoolcountres) => {
      if (schoolid && schoolcountres[0].c !== 1) {
        throw new ErrorProvider.ClientError('school-not-found');
      }
      
      key = buf.toString('hex');
      return ctx.query('INSERT INTO invitelink ' +
        '(uid, `key`, email, ctime, schoolid) VALUES ' +
        '(?, ?, ?, UNIX_TIMESTAMP(), ?)', 
        [ctx.user.uid, key, email, schoolid !== null ? schoolid : null]);
    })).then(() => {
      url = cfg.varReplace(cfg.inviteurl.replace(/\{\$key\}/g, key));
    
      if (query.email) {
        return this.sendInviteEmail({
          sender: ctx.user,
          email: email,
          url: url
        }, ctx);
      } else {
        sendKeyToCaller = true;
        return { code: 200 };
      }
    }).then(ret => {
      if (sendKeyToCaller) {
        ret.url = url;
        ret.key = key; 
      }
      
      return ret;
    });
  }
}

exports.components = [
  Login,
  Logout,
  EmailVerify,
  Register,
  ChangeOptions,
  ValidateUsername,
  ValidateEmail,
  ResetUser,
  ListGenders,
  ResetPassword,
  InviteKeyInfo,
  LoadSessionUser,
  UpdateUserStatistics,
  CreateInviteLink
];
