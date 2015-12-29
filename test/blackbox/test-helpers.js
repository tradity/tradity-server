'use strict';

var setup = require('./test-setup.js');
var sotradeClient = require('../../sotrade-client.js');
var sha256 = require('../../lib/sha256.js');
var main = require('../../main.js');
var _ = require('lodash');
var Q = require('q');
var fs = require('fs');
var assert = require('assert');

var testPerformance = process.env.SOTRADE_PROFILE_PERFORMANCE;
var timingFile = process.env.SOTRADE_TIMING_FILE;

var startServer = _.memoize(function() {
  return setup.setupDatabase().then(() => {
    return setup.generateKeys();
  }).then(() => {
    return new main.Main().start();
  }).then(() => {
    // test connectivity
    
    return new sotradeClient.SoTradeConnection({logDevCheck: false});
  }).then(socket => {
    return socket.emit('ping').then(() => {
      console.error('Server connectivity established');
      return socket.raw().disconnect();
    });
  });
});

var getSocket = _.memoize(function() {
  return startServer().then(() => {
    var socket = new sotradeClient.SoTradeConnection({
      noSignByDefault: true,
      logDevCheck: false
    });
    
    if (testPerformance && timingFile) {
      socket.on('*', data => {
        var dt = data._dt;
        
        if (!dt)
          return; // probably an event
        
        var fields = [
          Date.now(),
          dt.cdelta,
          dt.sdelta,
          dt.inqueue,
          dt.outqueue,
          dt.scomp,
          dt.ccomp,
          data._resp_decsize,
          data._resp_encsize,
          data._reqsize,
          data.code,
          data.type,
        ];
        
        fs.appendFile(timingFile, fields.join('\t') + '\n', { mode: '0660' }, () => {});
      });
    }
    
    return socket.once('server-config').then(_.constant(socket));
  });
});

var getTestUser = _.memoize(function() {
  var name = 'mm' + Date.now() * (process.pid | 0x100) + String(parseInt(Math.random() * 1000));
  var password = sha256(name).substr(0, 12);
  var email = name + '@invalid.invalid';
  var uid = null;
  var gender;
  
  var schoolid = 'MegaMusterschule' + parseInt(Date.now() / 100000);
  var schoolname = schoolid;
  
  return getSocket().then(socket => {
    return socket.emit('list-schools').then(data => {
      assert.equal(data.code, 'list-schools-success');
      for (var i = 0; i < data.result.length; ++i) {
        assert.ok(data.result[i].banner === null || typeof data.result[i].banner == 'string');
        
        if (data.result[i].name == schoolid) {
          schoolid = data.result[i].id;
          break;
        }
      }
      
      return socket.emit('list-genders');
    }).then(data => {
      assert.equal(data.code, 'list-genders-success');
      
      gender = data.genders.genders[parseInt(Math.random() * data.genders.genders.length)];
      
      return socket.emit('register', {
        __sign__: true,
        name: name,
        giv_name: 'John',
        fam_name: 'Doe ' + Date.now() % 19,
        realnamepublish: false,
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
        dla_optin: 0,
        gender: gender
      });
    }).then(data => {
      assert.equal(data.code, 'reg-success');
      
      return socket.emit('login', {
        name: email,
        pw: password,
        stayloggedin: false
      });
    }).then(data => {
      assert.equal(data.code, 'login-success');
          
      return socket.emit('get-own-options');
    }).then(data => {
      assert.equal(data.code, 'get-own-options-success');
      assert.ok(!data.result.pwhash);
      assert.equal(data.result.uid, parseInt(data.result.uid));
      
      return {
        name: name,
        password: password,
        email: email,
        uid: data.result.uid,
        schoolname: schoolname,
        schoolid: schoolid
      };
    })
  });
});

var standardSetup = function() {
  var socket;
  
  return getSocket().then(socket_ => {
    socket = socket_;
    return getTestUser();
  }).then(user => {
    return { socket: socket, user: user };
  });
};

var standardTeardown = function() {
  return getSocket().then(socket => socket.raw().disconnect());
};

var standardReset = function() {
  return getSocket().then(socket => {
    return getTestUser().then(user => {
      if (testPerformance)
        return;
      
      return socket.emit('logout').then(() => {
        return socket.emit('login', { // login to reset privileges
          name: user.name,
          pw: user.password,
          stayloggedin: false
        });
      }).then(loginresult => {
        assert.equal(loginresult.code, 'login-success');
      });
    });
  });
};

var bufferEqual = function(a, b) {
  if (a.length != b.length)
    return false;
  
  for (var i = 0; i < a.length; ++i)
    if (a[i] != b[i])
      return false;
  
  return true;
}

exports.getSocket = getSocket;
exports.getTestUser = getTestUser;
exports.standardSetup = standardSetup;
exports.standardTeardown = standardTeardown;
exports.standardReset = standardReset;
exports.bufferEqual = bufferEqual;
exports.testPerformance = testPerformance;
