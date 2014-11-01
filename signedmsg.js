(function () { "use strict";

var _ = require('underscore');
var util = require('util');
var fs = require('fs');
var crypto = require('crypto');
var assert = require('assert');
var buscomponent = require('./stbuscomponent.js');

function SignedMessagingDB () {
	SignedMessagingDB.super_.apply(this, arguments);
	
	this.privateKey = null;
	this.publicKeys = [];
	this.algorithm = 'RSA-SHA256';
}

util.inherits(SignedMessagingDB, buscomponent.BusComponent);

SignedMessagingDB.prototype.onBusConnect = function() {
	var self = this;
	
	self.getServerConfig(function(cfg) {
		self.useConfig(cfg);
	});
};

SignedMessagingDB.prototype.useConfig = function(cfg) {
	this.privateKey = fs.readFileSync(cfg.privateKey, {encoding: 'utf-8'});
	this.publicKeys = fs.readFileSync(cfg.publicKeys, {encoding: 'utf-8'})
		.replace(/\n-+BEGIN PUBLIC KEY-+\n/gi, function(s) { return '\0' + s; }).split(/\0/).map(function(s) { return s.trim(); });
	this.algorithm = cfg.signatureAlgorithm || this.algorithm;
}

SignedMessagingDB.prototype.createSignedMessage = buscomponent.provide('createSignedMessage', ['msg', 'reply'], function(msg, cb) {
	var self = this;
	var string = new Buffer(JSON.stringify(msg)).toString('base64');
	var sign = crypto.createSign('RSA-SHA256');
	
	sign.end(string, null, function() {
		var signed = string + '~' + sign.sign(self.privateKey, 'base64');
		cb(signed);
	});
});

SignedMessagingDB.prototype.verifySignedMessage = buscomponent.provide('verifySignedMessage', ['msg', 'reply'], function(msg, cb) {
	var self = this;
	
	var msg_ = msg.split('~');
	if (msg_.length != 2)
		return cb(null);
	
	var string = msg_[0], signature = msg_[1];
	
	function verifySingleKey (i) {
		if (i == self.publicKeys.length)
			return cb(null); // no key matched
		
		var pubkey = self.publicKeys[i];
		var verify = crypto.createVerify('RSA-SHA256');
		
		verify.end(string, null, function() {
			if (verify.verify(pubkey, signature, 'base64')) {
				// move current public key to first position (lru caching)
				self.publicKeys.splice(0, 0, self.publicKeys.splice(i, 1)[0]);
				
				return cb(JSON.parse(new Buffer(string, 'base64').toString()));
			} else {
				verifySingleKey(i+1); // try next key
			}
		});
	}
	
	verifySingleKey(0);
});

exports.SignedMessagingDB = SignedMessagingDB;

/* small test script */
if (require.main === module) {
	var smdb = new SignedMessagingDB();
	smdb.privateKey = '-----BEGIN RSA PRIVATE KEY-----\n' +
	'MIIEogIBAAKCAQEA1+x4pXKTYzlg7kb6dpQ0TX8HhDF7L6G0Jg0whCy6ssCZgLKX\n' +
	'a5t/Fp0Zv1SI7DzUVswCyxHs2Yi/tBE8Vw+PAltsC127I2uabReueCaEFfOs4e+7\n' +
	'R+IRCH1sG7g+4n3MMvqmmkKOUbekggCdY0TuMSEFiGbd2PL2Pr93R3jdQ8oBOAgl\n' +
	'bUoVOk4NVDccnn9+74ZtmrtaTiJ1oHzNhfyFDNPU2u6zUIOvCF7Hc8oQjxKZk78g\n' +
	'AB2dho/TpZDDgnq5Sfn53HT0DBR6yCz7CXH5cWFjRfalhe3X/ZMsXt936Hhz2GiP\n' +
	'MIXLjRcFX1cCGpvwEDxj0dXV9X1JNyb0mYrOywIDAQABAoIBAELr75iXokamifxP\n' +
	'02DdHjjGnjXCgEOLAqKog9jzZAny16CjuXqIfyMrHcfHE4jkcYtVP6hgrd/eGkxc\n' +
	'6y6wi8pXO21qZ43a08nsBQ8IIPgMxhBglNL6pfzToqYUvKjGBHvoY6p75lA9cqc4\n' +
	'OY+C1bA0Y9qaxzduVhOsk/N66lkPuPcWEvv0BmW0DjE64CL89hpgin2Jq+VA3Bz/\n' +
	'2JEf9OBtyjsFhvk3hIcF7mhn44qmP2vvJzk795MwzeWIqcWtEZzlmzzvc3KigLQq\n' +
	'O3V50/Sb88Pf0YhXceQ9MQb2hD+xsnIVKwrPT+MaB4/YT846RI+LlqaYwD5f6N7K\n' +
	'sMrVaoECgYEA8WPJBTkEt+yXhqQWBsYT0vcRqB9UoUz3GaRitlw0BU9BCY+vrdYq\n' +
	'F2AlaNYejr1RAhxQ0ny3msQtEpJ6Mc+b/sy/a5+lEiBYmMfWKSlIZpCdqE2SVZpq\n' +
	'2Imh9wtMoXq/B0qXsO0ak1cu1Vr3XzYY1d4EqfI6GpJShz8Q9IKjB3kCgYEA5P4a\n' +
	'GJ3ZcylIk1Na14+o9fxnzd/5aHUPg4k1v25wmlqg4FtH3nlCiAwc3i7h52vMJwRN\n' +
	'5cHe/juTPQMTJla6il6wHkmVTBDDZxwhYt5ht2Wn5bkgymxBbp5m6HGgNQboFHv5\n' +
	'b9ujWKV/mKbokFvdglPkXWMx+p3ygXTDoT4Mg2MCgYB4OavINyLbfDHn9FeoHgWH\n' +
	'oFih9KDRCaVUlyQ3EWszbcrFuVPVcAJczB01vtdPXok3VOUIQOetZKHSSzQjFPTs\n' +
	'DgwUzVmI0qVtyrImpBIUS1jKl4AXtKYcnUgW5ADRuHHmbsdobl87HUQNLZZhTG9I\n' +
	'LaEDB8raqyABjm6iaWJLeQKBgE+U34zejsuu9UH+Hfv8OUQDzC+IPy1GQXX9IWi+\n' +
	'APQjuvU9w+RVUAHn88Bjmq7Kj9CfdlL65XyFR85UWztfuMSN07cy62fcC4yyAghS\n' +
	'MLOD6K21gOfYZ4UCF9GAa6UCGXXFABMXydTs70Ml/nzs8DZy4VJzPtNSQQ0sfzBy\n' +
	'V/bxAoGALBWQ/kMxBVrPjfIdKOGRWVib+RNfzrnUMqSsMZ/+0oxkHxtvkjag7X3+\n' +
	'MN71ew1GiMQnkuddriufRrZ80CelrRTuoh9ni8KlVnc5dkSMzFO3975D3qm4wai1\n' +
	'uWdMhu78NVC+gEhkw3m6cu20Xy338tYIOk9yIebz69XEu0qNN1s=\n' +
	'-----END RSA PRIVATE KEY-----';
	
	smdb.publicKeys = [
		'-----BEGIN PUBLIC KEY-----\n' +
		'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1+x4pXKTYzlg7kb6dpQ0\n' +
		'TX8HhDF7L6G0Jg0whCy6ssCZgLKXa5t/Fp0Zv1SI7DzUVswCyxHs2Yi/tBE8Vw+P\n' +
		'AltsC127I2uabReueCaEFfOs4e+7R+IRCH1sG7g+4n3MMvqmmkKOUbekggCdY0Tu\n' +
		'MSEFiGbd2PL2Pr93R3jdQ8oBOAglbUoVOk4NVDccnn9+74ZtmrtaTiJ1oHzNhfyF\n' +
		'DNPU2u6zUIOvCF7Hc8oQjxKZk78gAB2dho/TpZDDgnq5Sfn53HT0DBR6yCz7CXH5\n' +
		'cWFjRfalhe3X/ZMsXt936Hhz2GiPMIXLjRcFX1cCGpvwEDxj0dXV9X1JNyb0mYrO\n' +
		'ywIDAQAB\n' +
		'-----END PUBLIC KEY-----'
	];
	
	var message = {
		apeWants: 'BANANA'
	};
	
	smdb.createSignedMessage(message, function(signed) {
		console.log(signed);
		smdb.verifySignedMessage(signed, function(message) {
			console.log('message.apeWants =', message.apeWants);
		});
	});
}

})();
