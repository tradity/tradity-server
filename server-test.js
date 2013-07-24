(function () { "use strict";

var sio = require('socket.io-client');
var fs = require('fs');
var assert = require('assert');
var _ = require('underscore');

var cfg = require('./config.js').config;

var socket = sio.connect('http://localhost:' + cfg.wsport);
var authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString();
var key = '';

socket.on('connect', function() {
	var t = new Date().getTime() * (process.id | 0x100);
	var email = t + '@invalid.invalid';
	var password = 'musterpw' + t;
	
	var emit = function (e, d) { console.log('outgoing', e, d); socket.emit(e, d); }
	socket.on('response', function (data) {
		console.log('incoming', data);
		
		switch(data['is-reply-to']) {
			case 'list-schools-1':
				assert.equal(data.code, 'list-schools-success');
				var schoolid = 'Musterschule';
				for (var i = 0; i < data.result.length; ++i) {
					if (data.result[i].name == schoolid) {
						schoolid = data.result[i].id;
						break;
					}
				}
				
				emit('query', {
					type: 'register',
					id: 'register',
					name: 'mm' + t,
					giv_name: 'Max',
					fam_name: 'Mustermann der ' + (t % (1 << 17)) + '.',
					realnamepublish: true,
					password: password,
					email: email,
					gender: 'undisclosed',
					school: schoolid
				});
				break;
			case 'register':
				assert(data.code == 'reg-email-sending' || data.code == 'reg-success', 'Register return code should be email-sending or success');
				if (data.code != 'reg-email-sending') 
					break;
				emit('query', {
					type: 'emailverif',
					id: 'emailverif',
					uid: data.uid,
					authorizationKey: authorizationKey
				});
				break;
			case 'emailverif':
				assert.equal(data.code, 'email-verify-success');
				emit('query', {
					type: 'login',
					id: 'login-1',
					name: email,
					pw: password,
					stayloggedin: false
				});
				break;
			case 'login-1':
				assert.equal(data.code, 'login-success');
				key = data.key;
				emit('query', {
					type: 'list-schools',
					id: 'list-schools-2',
					key: key
				});
				break;
			case 'list-schools-2':
				assert.equal(data.code, 'list-schools-success');
				assert.ok(_.pluck(data.result, 'name').indexOf('Musterschule') != -1);
				emit('query', {
					type: 'logout',
					id: 'logout',
					key: key
				});
				break;
			case 'logout':
				assert.equal(data.code, 'logout-success');
				emit('query', {
					type: 'stock-search',
					id: 'stock-search-1',
					name: 'MSFT',
					key: key
				});
				break;
			case 'stock-search-1':
				assert.equal(data.code, 'not-logged-in');
				emit('query', {
					type: 'login',
					id: 'login-2',
					name: email,
					pw: password,
					stayloggedin: false
				});
				break;
			case 'login-2':
				assert.equal(data.code, 'login-success');
				key = data.key;
				emit('query', {
					type: 'stock-search',
					id: 'stock-search-2',
					name: 'MCD',
					key: key
				});
				break;
			case 'stock-search-2':
				assert.equal(data.code, 'stock-search-success');
				emit('query', {
					type: 'delete-user',
					id: 'delete-user',
					key: key
				});
				break;
			case 'delete-user':
				assert.equal(data.code, 'delete-user-success');
				emit('query', {
					type: 'login',
					id: 'login-3',
					name: email,
					pw: password,
					stayloggedin: true
				});
				break;
			case 'login-3':
				assert.equal(data.code, 'login-badname');
				emit('query', {
					type: 'ping',
					id: 'ping',
				});
				break;
			case 'ping':
				assert.equal(data.code, 'pong');
				console.log('Thank you for watching, please subscribe to my channel to view other tests');
				process.exit(0);
		}
	});

	emit('query', {
		type: 'list-schools',
		id: 'list-schools-1'
	});
});
})();
