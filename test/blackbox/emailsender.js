'use strict';

var assert = require('assert');
var testHelpers = require('./test-helpers.js');

if (!testHelpers.testPerformance)
describe('emailsender', function() {
  var socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  it('Should directly bounce all e-mails in test mode', function() {
    return socket.emit('create-invite-link', {
      __sign__: true,
      email: user.email
    }).then(res => {
      assert.equal(res.code, 'create-invite-link-success');
      
      return socket.once('email-bounced');
    });
  });
});
