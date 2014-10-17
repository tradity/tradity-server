(function () { "use strict";

var sio = require('socket.io-client');
var fs = require('fs');
var assert = require('assert');
var util = require('util');
var _ = require('underscore');

var cfg = require('./config.js').config;

var socket = sio.connect('http://' + cfg.wshost + ':' + cfg.wsports[0]);
var authorizationKey = fs.readFileSync(cfg['auth-key-file']).toString();
var key = '';
var schoolid = 'Musterschule';
var schoolname = schoolid;

socket.on('connect', function() {
	var t = new Date().getTime() * (process.id | 0x100);
	var email = t + '@invalid.invalid';
	var password = 'musterpw' + t;
	var ownUid = null;
	
	var emit = function (e, d) { console.log('outgoing', e, JSON.stringify(d, null, 2)); socket.emit(e, d); }
	socket.on('push', function (data) {
		console.log('incoming/push', JSON.stringify(data, null, 2));
	});
	
	socket.on('response', function (rawData) {
		assert.equal(rawData.e, 'raw');
		var data = JSON.parse(rawData.s);
		
		console.log('incoming', util.inspect(data));
		
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
					traditye: 0
				});
				break;
			case 'register':
				assert(data.code == 'reg-success', 'Register return code should be email-success');
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
					key: key,
					search: 'ustersch'
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
				
				fs.readFile('res/bob.jpg', function(err, data) {
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
					name: 'DE0005658009',
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
				ownUid = data.result.uid;
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
					stockid: 'CA7500801039',
					leader: null,
					forceNow: true
				});
				break;
			case 'stock-buy':
				assert.ok(data.code == 'stock-buy-success' || data.code == 'stock-buy-over-pieces-limit');
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
					lookfor: ownUid,
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
					stockid: 'CA7500801039',
					leader: null,
					forceNow: true
				});
				break;
			case 'stock-sell-1':
				assert.ok(data.code == 'stock-buy-success' || data.code == 'stock-buy-over-pieces-limit' || data.code == 'stock-buy-not-enough-stocks');
				emit('query', {
					type: 'stock-buy',
					id: 'stock-sell-2',
					key: key,
					amount: -5,
					value: null,
					stockid: 'CA7500801039',
					leader: null,
					forceNow: true
				});
				break;
			case 'stock-sell-2':
				assert.equal(data.code, 'stock-buy-not-enough-stocks');
				emit('query', {
					type: 'get-user-info',
					id: 'get-user-info-2',
					lookfor: ownUid,
					key: key
				});
				break;
			case 'get-user-info-2':
				assert.equal(data.code, 'get-user-info-success');
				assert.equal(data.result.uid, ownUid);
				assert.notEqual(_.pluck(data.result.schools, 'name').indexOf(schoolname), -1);
				assert.ok(data.result.totalvalue);
				emit('query', {
					type: 'get-ranking',
					id: 'get-ranking-1',
					rtype: 'general',
					key: key,
					startindex: 0,
					endindex: 20000000
				});
				break;
			case 'get-ranking-1':
				assert.equal(data.code, 'get-ranking-success');
				emit('query', {
					type: 'get-ranking',
					id: 'get-ranking-2',
					rtype: 'general',
					key: key,
					search: t
				});
				break;
			case 'get-ranking-2':
				assert.equal(data.code, 'get-ranking-success');
				emit('query', {
					'type': 'dquery',
					'id': 'dquery',
					'condition': 'stock::DE000A1EWWW0::ask > 0 ∧ time > ' + ((new Date().getTime()/1000)+1),
					'query': {
						type: 'stock-buy',
						id: 'stock-buy-delayed',
						amount: 1,
						value: null,
						stockid: 'DE000A1EWWW0',
						leader: null,
					},
					key: key,
				});
				break;
			case 'dquery':
				assert.equal(data.code, 'dquery-success');
				setTimeout(function() {
				emit('query', {
					type: 'prod',
					id: 'prod-2',
					authorizationKey: authorizationKey,
					uid: ownUid
				});
				}, 2000);
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
				assert.equal(data.uid, null);
				emit('query', {
					type: 'show-packet-log',
					id: 'show-packet-log',
					authorizationKey: authorizationKey,
					uid: ownUid
				});
				break;
			case 'show-packet-log':
				assert.equal(data.code, 'show-packet-log-success');
				assert.ok(data.result);
				emit('query', {
					type: 'get-server-statistics',
					id: 'get-server-statistics',
					authorizationKey: authorizationKey,
					uid: ownUid
				});
				break;
			case 'get-server-statistics':
				assert.equal(data.code, 'get-server-statistics-success');
				assert.ok(data.servers && _.isArray(data.servers));
				emit('query', {
					type: 'server-config',
					id: 'server-config'
				});
				break;
			case 'server-config':
				assert.equal(data.code, 'server-config-success');
				assert.ok(data.config);
				assert.ok(data.config.normalLoginTime);
				emit('query', {
					type: 'reset-user',
					id: 'reset-user',
					authorizationKey: authorizationKey,
					uid: ownUid
				});
				break;
			case 'reset-user':
				assert.equal(data.code, 'reset-user-success');
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
