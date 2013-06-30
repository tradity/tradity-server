(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var events = require('events');
var hash = require('mhash').hash;
var crypto = require('crypto');

function User (db, id) {
	this.db = db;
	
	this.db.query('SELECT * FROM users WHERE id = ?', [id], _.bind(function(err, res) {
		if (err)
			this.emit('error', err);
		if (res.length != 1)
			this.emit('error', 'Expect query to return exactly one user entry');
		
		for (var e in res[0])
			this[e] = res[0][e];
	}, this));
}
util.inherits(User, events.EventEmitter);

User.prototype.hasExactPassword = function(trypw) {
	return hash('sha256', this.pwsalt + trypw) === this.pwhash;
}

User.prototype.setPassword = function(pw) {
	crypto.randomBytes(16, _.bind(function(ex, buf) {
		var pwsalt = buf.toString('hex');
		var pwhash = hash('sha256', this.pwsalt + pw);
		this.db.query('UPDATE users SET pwsalt = ?, pwhash = ? WHERE id = ?', [pwsalt, pwhash, this.id], _.bind(function(err, res) {
			if (err)
				this.emit('error');
			
			this.pwsalt = pwsalt;
			this.pwhash = pwhash;
			this.emit('password-changed');
		}, this));
	}, this));
}

User.prototype.setNickName = function(nickname) {
	this.db.query('UPDATE users SET nickname = ? WHERE id = ?', [nickname, this.id], _.bind(function(err, res) {
		if (err)
			this.emit('error');
			
		this.nickname = nickname;
		this.emit('name-changed');
	}, this));
}

User.prototype.setEMail = function(email) {
	this.db.query('UPDATE users SET email = ? WHERE id = ?', [email, this.id], _.bind(function(err, res) {
		if (err)
			this.emit('error');
			
		this.email = email;
		this.emit('email-changed');
	}, this));
}

User.prototype.listStocks = function(cb) {
	this.db.query(
	'SELECT d.*, s.* FROM depot_stocks AS d WHERE userid = ? JOIN stocks AS s ON d.stockid = s.id', [this.id], _.bind(function(res) {
		cb(_.map(res, function(row) { return new DepotStock(row); }));
	}));
}

})();
