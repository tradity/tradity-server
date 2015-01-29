'use strict';

var assert = require('assert');
var testHelpers = require('./test-helpers.js');
var socket, user;

before(function() {
	return testHelpers.standardSetup().then(function(data) {
		socket = data.socket;
		user = data.user;
	});
});

beforeEach(testHelpers.standardReset);
after(testHelpers.standardTeardown);

describe('emailsender', function() {
	it('Should directly bounce all e-mails in test mode', function() {
		return socket.emit('create-invite-link', {
			__sign__: true,
			email: user.email
		}).then(function(res) {
			assert.equal(res.code, 'create-invite-link-success');
			
			return socket.once('email-bounced');
		});
	});
});
