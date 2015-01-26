#!/usr/bin/env node
(function () { "use strict";

Error.stackTraceLimit = Infinity;

var Q = require('q');
var fs = require('fs');
var assert = require('assert');
var util = require('util');
var _ = require('lodash');

var sotradeClient = require('./sotrade-client.js');

var socket = new sotradeClient.SoTradeConnection({logDevCheck: true});

var schoolid = 'Musterschule';
var schoolname = schoolid;

/* “global” variables */
var t = Date.now() * (process.id | 0x100); // Unique user name
var email = t + '@invalid.invalid';
var password = 'musterpw' + t;
var ownUid = null; // own user id as soon as available

socket.once('server-config').then(function() {
	return socket.emit('list-schools');
}).then(function(data) {
	assert.equal(data.code, 'list-schools-success');
	for (var i = 0; i < data.result.length; ++i) {
		assert.ok(data.result[i].banner === null || typeof data.result[i].banner == 'string');
		
		if (data.result[i].name == schoolid) {
			schoolid = data.result[i].id;
			break;
		}
	}
	
	return socket.emit('register', {
		name: 'mm' + t,
		giv_name: 'Max',
		fam_name: 'Mustermann der ' + (t % (1 << 17)) + '.',
		realnamepublish: true,
		delayorderhist: false,
		password: password,
		email: email,
		school: schoolid,
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
	
	return socket.emit('set-debug-mode', { debugMode: true });
}).then(function(data) {
	assert.equal(data.code, 'set-debug-mode-success');
	
	return socket.emit('login', {
		name: email,
		pw: password,
		stayloggedin: false
	});
}).then(function(data) {
	assert.equal(data.code, 'login-success');
	
	return socket.emit('list-schools', { search: 'ustersch' });
}).then(function(data) {
	assert.equal(data.code, 'list-schools-success');
	assert.ok(_.pluck(data.result, 'name').indexOf('Musterschule') != -1);
	
	return socket.emit('logout');
}).then(function(data) {
	assert.equal(data.code, 'logout-success');
	
	return socket.emit('stock-search', { name: 'MSFT', __dont_sign__: true });
}).then(function(data) {
	assert.equal(data.code, 'not-logged-in');
	
	return socket.emit('login', {
		name: email,
		pw: password,
		stayloggedin: false
	});
}).then(function(data) {
	assert.equal(data.code, 'login-success');
	
	return socket.emit('set-debug-mode', { debugMode: false });
}).then(function(data) {
	assert.equal(data.code, 'set-debug-mode-success');
			
	return Q.nfcall(fs.readFile, 'res/bob.jpg');
}).then(function(data) {
	return socket.emit('publish', {
		base64: true,
		content: data.toString('base64'),
		role: 'profile.image',
		mime: 'image/jpeg',
		name: 'bob.jpg'
	});
}).then(function(data) {
	assert.equal(data.code, 'publish-success');
	
	return socket.emit('stock-search', { name: 'DE0005658009', uid: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'stock-search-success');
	return socket.emit('get-own-options');
}).then(function(data) {
	assert.equal(data.code, 'get-own-options-success');
	assert.ok(!data.pwhash);
	ownUid = data.result.uid;
	
	return socket.emit('prod');
}).then(function(data) {
	assert.equal(data.code, 'prod-ready');
	
	return socket.emit('stock-buy', {
		amount: 5,
		value: null,
		stockid: 'CA7500801039',
		leader: null,
		forceNow: true
	});
}).then(function(data) {
	assert.ok(data.code == 'stock-buy-success' || data.code == 'stock-buy-over-pieces-limit');
	
	return socket.emit('list-own-depot');
}).then(function(data) {
	assert.equal(data.code, 'list-own-depot-success');
	
	return socket.emit('list-transactions');
}).then(function(data) {
	assert.equal(data.code, 'list-transactions-success');
	assert.ok(data.results);
	
	return socket.emit('get-user-info', { lookfor: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'get-user-info-success');
	
	return socket.emit('stock-buy', {
		amount: -5,
		value: null,
		stockid: 'CA7500801039',
		leader: null,
		forceNow: true
	});
}).then(function(data) {
	assert.ok(data.code == 'stock-buy-success' ||
			  data.code == 'stock-buy-over-pieces-limit' ||
			  data.code == 'stock-buy-not-enough-stocks');
	
	return socket.emit('stock-buy', {
		amount: -5,
		value: null,
		stockid: 'CA7500801039',
		leader: null,
		forceNow: true
	});
}).then(function(data) {
	assert.equal(data.code, 'stock-buy-not-enough-stocks');
	
	return socket.emit('get-user-info', { lookfor: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'get-user-info-success');
	assert.equal(data.result.uid, ownUid);
	assert.notEqual(_.pluck(data.result.schools, 'name').indexOf(schoolname), -1);
	assert.ok(data.result.totalvalue);
	
	return socket.emit('get-ranking');
}).then(function(data) {
	assert.equal(data.code, 'get-ranking-success');
	
	return socket.emit('get-ranking', {
		search: t
	});
}).then(function(data) {
	assert.equal(data.code, 'get-ranking-success');
	
	return socket.emit('dquery', {
		'condition': 'stock::DE000A1EWWW0::ask > 0 ∧ time > ' + ((Date.now()/1000)+1),
		'query': {
			type: 'stock-buy',
			id: 'stock-buy-delayed',
			amount: 1,
			value: null,
			stockid: 'DE000A1EWWW0',
			leader: null,
		}
	});
}).then(function(data) {
	assert.equal(data.code, 'dquery-success');
	
	return Q.delay(2000);
}).then(function() {
	return socket.emit('prod', { uid: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'prod-ready');
	
	
	return socket.emit('ping');
}).then(function(data) {
	assert.equal(data.code, 'pong');
	assert.notEqual(data.uid, null);
	
	return socket.emit('show-packet-log', { uid: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'show-packet-log-success');
	assert.ok(data.result);
	return socket.emit('get-server-statistics', { uid: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'get-server-statistics-success');
	assert.ok(data.servers && _.isArray(data.servers));
	return socket.emit('process-wordpress-feed', { uid: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'process-wordpress-feed-success');
	
	return socket.emit('reset-user', { uid: ownUid });
}).then(function(data) {
	assert.equal(data.code, 'reset-user-success');
	
	console.log('Thank you for watching, please subscribe to my channel to view other tests');
	process.exit(0);
}).done();

})();
