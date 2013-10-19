(function () { "use strict";

var sio = require('socket.io-client');
var fs = require('fs');
var assert = require('assert');
var _ = require('underscore');

var cfg = require('./config.js').config;

var socket = sio.connect('http://localhost:' + cfg.wsport);
var authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString();
var key = '';
var schoolid = 'Musterschule';
var schoolname = schoolid;

socket.on('connect', function() {
	var t = new Date().getTime() * (process.id | 0x100);
	var email = t + '@invalid.invalid';
	var password = 'musterpw' + t;
	var own_uid = null;
	
	var emit = function (e, d) { console.log('outgoing', e, d); socket.emit(e, d); }
	socket.on('push', function (data) {
		console.log('incoming/push', data);
	});
	
	socket.on('response', function (data) {
		console.log('incoming', data);
		
		var handledRegister = false;
		switch(data['is-reply-to']) {
			case 'list-schools-1':
				assert.equal(data.code, 'list-schools-success');
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
					delayorderhist: false,
					password: password,
					email: email,
					school: schoolid,
					authorizationKey: authorizationKey,
					nomail: true,
					betakey: '1-a.skidulaqrniucznl',
					street: '',
					town: '',
					zipcode: '',
					wot: 0,
					tradersp: 0,
					traderse: 0,
					traditye: 0
				});
				break;
			case 'register':
				assert(data.code == 'reg-email-sending' || data.code == 'reg-success', 'Register return code should be email-sending or success');
				if (handledRegister) 
					break;
				handledRegister = true;
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
				
				fs.readFile('bob.jpg', function(err, data) {
					if (err) throw err;
					
					console.log('outgoing: publish');
					socket.emit('query', {
						type: 'publish',
						id: 'publish',
						base64: true,
						content: data.toString('base64'),
						role: 'profile.image',
						mime: 'image/jpeg',
						key: key,
						name: 'bob.jpg'
					});
				});
				break;
			case 'publish':
				assert.equal(data.code, 'publish-success');
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
					type: 'get-own-options',
					id: 'get-own-options',
					key: key
				});
				break;
			case 'get-own-options':
				assert.equal(data.code, 'own-options-success');
				assert.ok(!data.pwhash);
				own_uid = data.result.uid;
				emit('query', {
					type: 'prod',
					id: 'prod-1',
					authorizationKey: authorizationKey,
					key: key
				});
				break;
			case 'prod-1':
				assert.equal(data.code, 'prod-ready');
				emit('query', {
					type: 'stock-buy',
					id: 'stock-buy',
					key: key,
					amount: 5,
					value: null,
					stockid: 'MDO.F',
					leader: null,
					comment: 'There is no spoon',
					forceNow: true
				});
				break;
			case 'stock-buy':
				assert.equal(data.code, 'stock-buy-success');
				emit('query', {
					type: 'list-own-depot',
					id: 'list-own-depot',
					key: key
				});
				break;
			case 'list-own-depot':
				assert.equal(data.code, 'list-own-depot-success');
				emit('query', {
					type: 'get-user-info',
					id: 'get-user-info-1',
					lookfor: own_uid,
					key: key
				});
				break;
			case 'get-user-info-1':
				assert.equal(data.code, 'get-user-info-success');
				emit('query', {
					type: 'stock-buy',
					id: 'stock-sell-1',
					key: key,
					amount: -5,
					value: null,
					stockid: 'MDO.F',
					leader: null,
					comment: 'There is no spoon',
					forceNow: true
				});
				break;
			case 'stock-sell-1':
				assert.equal(data.code, 'stock-buy-success');
				emit('query', {
					type: 'stock-buy',
					id: 'stock-sell-2',
					key: key,
					amount: -5,
					value: null,
					stockid: 'MDO.F',
					leader: null,
					comment: 'There is no spoon',
					forceNow: true
				});
				break;
			case 'stock-sell-2':
				assert.equal(data.code, 'stock-buy-not-enough-stocks');
				emit('query', {
					type: 'get-user-info',
					id: 'get-user-info-2',
					lookfor: own_uid,
					key: key
				});
				break;
			case 'get-user-info-2':
				assert.equal(data.code, 'get-user-info-success');
				assert.equal(data.result.uid, own_uid);
				assert.equal(data.result.schoolname, schoolname);
				assert.ok(data.result.totalvalue);
				assert.ok(data.result.rank);
				emit('query', {
					type: 'get-ranking',
					id: 'get-ranking',
					rtype: 'general',
					key: key
				});
				break;
			case 'get-ranking':
				assert.equal(data.code, 'get-ranking-success');
				assert.ok(data.result.length > 0);
				emit('query', {
					'type': 'dquery',
					'id': 'dquery',
					'condition': 'stock::GEC.F::ask > 0 ∧ time > ' + ((new Date().getTime()/1000)+1),
					'query': {
						type: 'stock-buy',
						id: 'stock-buy-delayed',
						amount: 1,
						value: null,
						stockid: 'GEC.F',
						leader: null,
						comment: 'There was no spoon'
					},
					key: key,
				});
				break;
			case 'dquery':
				setTimeout(function() {
				emit('query', {
					type: 'delete-user',
					id: 'delete-user',
					key: key
				});
				}, 2000);
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
					type: 'prod',
					id: 'prod-2',
					authorizationKey: authorizationKey,
					uid: own_uid
				});
				break;
			case 'prod-2':
				assert.equal(data.code, 'prod-ready');
				emit('query', {
					type: 'ping',
					id: 'ping',
				});
				break;
			case 'ping':
				assert.equal(data.code, 'pong');
				emit('query', {
					type: 'get-config',
					id: 'get-config'
				});
				break;
			case 'get-config':
				assert.equal(data.code, 'get-config-success');
				assert.ok(data.config);
				assert.ok(data.config.normalLoginTime);
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
