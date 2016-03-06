// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

'use strict';

const setup = require('./test-setup.js');
const sotradeClient = require('../../sotrade-client.js');
const sha256 = require('../../lib/sha256.js');
const main = require('../../main.js');
const _ = require('lodash');
const assert = require('assert');

let server;

const startServer = _.memoize(function() {
  return setup.setupDatabase().then(() => {
    return setup.generateKeys();
  }).then(() => {
    server = new main.Main();
    return server.start();
  }).then(() => {
    // test connectivity
    
    return new sotradeClient.SoTradeConnection();
  }).then(socket => {
    return socket.get('/ping').then(() => {
      console.error('Server connectivity established');
    });
  });
});

const getSocket = _.memoize(function() {
  return startServer().then(() => {
    const socket = new sotradeClient.SoTradeConnection({
      noSignByDefault: true
    });
    
    socket.once = evname => server.load('PubSub').once(evname);
    
    return socket;
  });
});

const getTestUser = _.memoize(function() {
  const name = 'mm' + Date.now() * (process.pid | 0x100) + String(parseInt(Math.random() * 1000));
  const password = sha256(name).substr(0, 12);
  const email = name + '@invalid.invalid';
  let gender;
  
  let schoolid = 'MegaMusterschule' + parseInt(Date.now() / 100000);
  let schoolname = schoolid;
  
  return getSocket().then(socket => {
    return socket.get('/schools').then(result => {
      assert.ok(result._success);
      
      for (let i = 0; i < result.data.length; ++i) {
        assert.ok(result.data[i].banner === null || typeof result.data[i].banner === 'string');
        
        if (result.data[i].name === schoolid) {
          schoolid = result.data[i].schoolid;
          break;
        }
      }
      
      assert.ok(schoolid);
      return socket.get('/genders');
    }).then(result => {
      assert.ok(result._success);
      
      gender = result.data.genders[parseInt(Math.random() * result.data.genders.length)];
      
      return socket.post('/register', {
        __sign__: true,
        body: {
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
        }
      });
    }).then(result => {
      // console.log('User register result', result);
      assert.ok(result._success);
      
      return socket.post('/login', {
        body: {
          name: email,
          pw: password,
          stayloggedin: false
        }
      });
    }).then(data => {
      assert.ok(data._success);
      
      return socket.get('/options');
    }).then(result => {
      assert.ok(result._success);
      assert.ok(result.data);
      assert.ok(!result.data.pwhash);
      assert.equal(typeof result.data.uid, 'number');
      
      return {
        name: name,
        password: password,
        email: email,
        uid: result.data.uid,
        schoolname: schoolname,
        schoolid: schoolid
      };
    });
  });
});

const standardSetup = function() {
  let socket;
  
  return getSocket().then(socket_ => {
    socket = socket_;
    return getTestUser();
  }).then(user => {
    return { socket: socket, user: user };
  });
};

const standardTeardown = function() {
  return Promise.resolve();
};

const standardReset = function() {
  return getSocket().then(socket => {
    return getTestUser().then(user => {
      return socket.post('/logout').then(() => {
        return socket.post('/login', { // login to reset privileges
          body: {
            name: user.name,
            pw: user.password,
            stayloggedin: false
          }
        });
      }).then(loginresult => {
        assert.ok(loginresult._success);
      });
    });
  });
};

const bufferEqual = function(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  
  return true;
};

exports.getSocket = getSocket;
exports.getTestUser = getTestUser;
exports.standardSetup = standardSetup;
exports.standardTeardown = standardTeardown;
exports.standardReset = standardReset;
exports.bufferEqual = bufferEqual;
