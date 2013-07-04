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

UserDB.prototype.getUser = function(id) {
	this.db.query('SELECT * FROM users WHERE id = ?', [id], _.bind(function(err, res) {
		if (err)
			this.emit('error', err);
		if (res.length != 1)
			this.emit('error', 'Expect query to return exactly one user entry');
		
		for (var e in res[0])
			this[e] = res[0][e];
	}, this));
}

UserDB.prototype.hasExactPassword = function(user, trypw) {
	return hash('sha256', user.pwsalt + trypw) === user.pwhash;
}

UserDB.prototype.setPassword = function(user, pw) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var pwsalt = buf.toString('hex');
		var pwhash = hash('sha256', user.pwsalt + pw);
		this.db.query('UPDATE users SET pwsalt = ?, pwhash = ? WHERE id = ?', [pwsalt, pwhash, user.id], _.bind(function(err, res) {
			if (err)
				this.emit('error');
			
			user.pwsalt = pwsalt;
			user.pwhash = pwhash;
			this.dbevent('password-changed', user, 'user-identical');
		}, this));
	}, this));
}

UserDB.prototype.setNickName = function(nickname) {
	this.db.query('UPDATE users SET nickname = ? WHERE id = ?', [nickname, this.id], _.bind(function(err, res) {
		if (err)
			this.emit('error');
			
		this.nickname = nickname;
		this.dbevent('name-changed', user, '*');
	}, this));
}

UserDB.prototype.setEMail = function(user, email) {
	this.db.query('UPDATE users SET email = ? WHERE id = ?', [email, user.id], _.bind(function(err, res) {
		if (err)
			this.emit('error');
			
		user.email = email;
		this.dbevent('email-changed', user, 'user-identical');
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
			cb(true, false);
			return;
		}
		
		this.db.query('INSERT INTO ps_emails (email, time) VALUES(?, UNIX_TIMESTAMP())', [email], _.bind(function(err, res) {
			if (err)
				this.emit('error', new Error(err));
			else
				cb(false, true);
		}, this));
	}, this));
}

exports.UserDB = UserDB;

})();
