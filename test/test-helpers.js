(function () { "use strict";

Error.stackTraceLimit = Infinity;

var sotradeClient = require('../sotrade-client.js');
var serverUtil = require('../server-util.js');
var _ = require('lodash');
var Q = require('q');
var assert = require('assert');

var getSocket = _.memoize(function() {
	var socket = new sotradeClient.SoTradeConnection({noSignByDefault: true});
	
	return socket.once('server-config').then(_.constant(socket));
});

var getTestUser = _.memoize(function() {
	var username = 'mm' + Date.now() * (process.id | 0x100);
	var password = serverUtil.sha256(username).substr(0, 12);
	var email = username + '@invalid.invalid';
	var uid = null;
	
	var schoolid = 'Musterschule';
	var schoolname = schoolid;
	
	return getSocket().then(function(socket) {
		return socket.emit('list-schools').then(function(data) {
			assert.equal(data.code, 'list-schools-success');
			for (var i = 0; i < data.result.length; ++i) {
				assert.ok(data.result[i].banner === null || typeof data.result[i].banner == 'string');
				
				if (data.result[i].name == schoolid) {
					schoolid = data.result[i].id;
					break;
				}
			}
			
			return socket.emit('register', {
				__sign__: true,
				name: username,
				giv_name: 'John',
				fam_name: 'Doe ' + Date.now() % 19,
				realnamepublish: true,
				delayorderhist: false,
				password: password,
				email: email,
				school: null,
				nomail: true,
				betakey: '1-a.skidulaqrniucznl',
				street: '',
				town: '',
				zipcode: '',
				traditye: 0,
				dla_optin: 0
			});
		}).then(function(data) {
			assert.equal(data.code, 'reg-success');
			
			return socket.emit('login', {
				name: email,
				pw: password,
				stayloggedin: false
			});
		}).then(function(data) {
			assert.equal(data.code, 'login-success');
					
			return socket.emit('get-own-options');
		}).then(function(data) {
			assert.equal(data.code, 'get-own-options-success');
			assert.ok(!data.result.pwhash);
			assert.ok(data.result.uid);
			
			return {
				username: username,
				password: password,
				email: email,
				uid: data.result.uid,
				schoolname: schoolname,
				schoolid: schoolid
			};
		})
	});
});

exports.getSocket = getSocket;
exports.getTestUser = getTestUser;

})();
