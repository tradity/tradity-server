(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var hash = require('mhash').hash;
var crypto = require('crypto');
var assert = require('assert');

function DBSubsystemBase () {
	this.db = null;
}
util.inherits(DBSubsystemBase, events.EventEmitter);

DBSubsystemBase.prototype.dbevent = function(name, data, access) {
	this.emit('dbevent', {name:name, data:data, access:access});
}

function UserDB (db) {
	this.db = db;
}
util.inherits(UserDB, DBSubsystemBase);

UserDB.prototype.generatePWKey = function(pw, cb) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var pwsalt = buf.toString('hex');
		var pwhash = hash('sha256', pwsalt + pw);
		cb(pwsalt, pwhash);
	}, this));
}

UserDB.prototype.listStocks = function(user, cb) {
	this.db.query(
	'SELECT d.*, s.* FROM depot_stocks AS d WHERE userid = ? JOIN stocks AS s ON d.stockid = s.id', [user.id], _.bind(function(err, res) {
		if (err)
			this.emit('error', new Error(err));
		
		cb(_.map(res, function(row) { return new DepotStock(row); }));
	}));
}

UserDB.prototype.insertPSEmail = function(email, cb) {
	this.db.query('SELECT COUNT(*) AS c FROM ps_emails WHERE email = ?', [email], _.bind(function(err, res) {
		if (err) {
			this.emit('error', new Error(err));
			return;
		}
		
		assert.equal(res.length, 1);
			
		if (res[0].c != 0) {
			assert.equal(res[0].c, 1);
			cb('email-already-present');
			return;
		}
		
		this.db.query('INSERT INTO ps_emails (email, time) VALUES(?, UNIX_TIMESTAMP())', [email], _.bind(function(err, res) {
			if (err)
				this.emit('error', new Error(err));
			else
				cb('email-enter-success');
		}, this));
	}, this));
}

UserDB.prototype.sendRegisterEmail = function(data, emailsender, cfg, cb) {
	var opt = _.clone(cfg.mail['register-base']);
	opt.to = data.email;
	opt.subject += ' (' + data.name + ')';
	opt.generateTextFromHTML = true;
	opt.html = 'For completion of the registration, please click the following link:\n' + 
	'[TODO: INSERT AN ACTUAL LINK.]';
	
	cb('reg-email-sending');
	
	emailsender.sendMail(opt, _.bind(function (error, resp) {
		if (error) {
			cb('reg-email-failed');
			this.emit('error', error);
		} else {
			cb('reg-success');
		}
	}, this));
}
					
UserDB.prototype.register = function(data, emailsender, cfg, cb) {
	if ((data.gender != 'male' && data.gender != 'female' && data.gender != 'undisclosed') || !data.name) {
		cb('format-error');
		return;
	}
	
	if (!data.password || data.password.length < 5) {
		cb('reg-too-short-pw');
		return;
	}
	
	this.db.query('SELECT email,name AS c FROM users WHERE (email = ? AND NOT email_verif) OR (name = ?)', [data.email, data.name], _.bind(function(err, res) {
		if (err) {
			this.emit('error', new Error(err));
			return;
		}
		
		if (res.length > 0) {
			if (res[0].name == data.name)
				cb('reg-name-already-present');
			else if (res[0].email == data.email)
				cb('reg-email-already-present');
			else
				throw new Error('db returned bad email/name match: ' + [res[0], data]);
			return;
		}
		
		var schoolLookupCB = _.bind(function(err, res) {
			if (err) {
				this.emit('error', new Error(err));
				return;
			}
			
			if (res.length == 0) {
				cb('reg-unknown-school');
				return;
			}
			
			this.generatePWKey(data.password, _.bind(function(pwsalt, pwhash) {
				this.db.query('INSERT INTO users (name, giv_name, fam_name, realnamepublish, pwhash, pwsalt, gender, school, email)' +
				'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
				[data.name, data.giv_name, data.fam_name, data.realnamepublish, pwhash, pwsalt, data.gender, data.school, data.email],
				_.bind(function(err, res) {
					if (err) 
						this.emit('error', new Error(err));
					else 
						this.sendRegisterEmail(data, emailsender, cfg, cb);
				}, this));
			}, this));
		}, this);
		
		if (data.school !== null) {
			this.db.query('SELECT COUNT(*) FROM schools WHERE id = ?', [data.school], schoolLookupCB);
		} else {
			schoolLookupCB(null, [0]);
		}
	}, this));
}

exports.UserDB = UserDB;

})();
