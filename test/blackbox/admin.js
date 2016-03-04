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

const assert = require('assert');
const _ = require('lodash');
const sha256 = require('../../lib/sha256.js');
const parentPath = require('../../lib/parentpath.js');
const testHelpers = require('./test-helpers.js');
const promiseUtil = require('../../lib/promise-util.js');
const spread = promiseUtil.spread;

describe('admin', function() {
  let user, socket;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      user = data.user;
      socket = data.socket;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('list-all-users', function() {
    it('Should fail for non-admin users', function() {
      return socket.emit('list-all-users').then(result => {
        assert.equal(result.code, 'permission-denied');
      });
    });
    
    it('Should provide a list of all users', function() {
      return socket.emit('list-all-users', { __sign__: true }).then(result => {
        assert.equal(result.code, 'list-all-users-success');
        
        assert.ok(result.results.length > 0);
        const ownUserEntry = result.results.filter(listedUser => {
          return listedUser.name === user.name;
        })[0];
        
        assert.ok(ownUserEntry);
        assert.equal(ownUserEntry.giv_name, 'John');
        assert.ok(ownUserEntry.registertime > Date.now()/1000 - 1000);
        assert.ok(ownUserEntry.registertime < Date.now()/1000);
      });
    });
  });
  
  describe('impersonate-user', function() {
    it('Should fail for non-admin users', function() {
      return socket.emit('impersonate-user').then(result => {
        assert.equal(result.code, 'permission-denied');
      });
    });
    
    it('Should fail for impersonating invalid users', function() {
      return socket.emit('impersonate-user', {
        __sign__: true,
        uid: 'ABC'
      }).then(result => {
        assert.equal(result.code, 'permission-denied');
      });
    });
    
    it('Should fail for impersonating nonexistent users', function() {
      return socket.emit('impersonate-user', {
        __sign__: true,
        uid: -1
      }).then(result => {
        assert.equal(result.code, 'impersonate-user-notfound');
      });
    });
    
    it('Should leave the session untouched when impersonating the active user', function() {
      return socket.emit('impersonate-user', {
        __sign__: true,
        uid: user.uid
      }).then(result => {
        assert.equal(result.code, 'impersonate-user-success');
        
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true
        });
      }).then(userInfo => {
        assert.equal(userInfo.code, 'get-user-info-success');
        
        assert.strictEqual(userInfo.result.uid, user.uid);
        assert.strictEqual(userInfo.result.name, user.name);
      });
    });
  });
  
  describe('change-user-email', function() {
    it('Should fail for invalid user ids', function() {
      return socket.emit('change-user-email', {
        __sign__: true,
        uid: 'Banana'
      }).then(result => {
        assert.equal(result.code, 'format-error');
      });
    });
    
    it('Should be able to change the active user’s mail address', function() {
      const email = 'nonexistent' + parseInt(Math.random() * 100000) + '@invalid.invalid';
      
      return socket.emit('change-user-email', {
        __sign__: true,
        uid: user.uid,
        emailverif: 1,
        email: email
      }).then(result => {
        user.email = email;
        assert.equal(result.code, 'change-user-email-success');
      });
    });
  });
  
  describe('change-comment-text', function() {
    it('Should be able to change the text of a recently made comment', function() {
      const newCommentText = '<a>New comment</a>';
      const newCState = 'Banananana';
      
      return socket.emit('get-user-info', {
        lookfor: '$self',
        noCache: true, __sign__: true
      }).then(userInfo => {
        assert.equal(userInfo.code, 'get-user-info-success');
        assert.ok(userInfo.result.registerevent);
        
        return socket.emit('comment', {
          eventid: userInfo.result.registerevent,
          comment: 'Old comment'
        });
      }).then(result => {
        assert.equal(result.code, 'comment-success');
        
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true
        });
      }).then(userInfo => {
        assert.equal(userInfo.code, 'get-user-info-success');
        
        assert.ok(userInfo.pinboard);
        assert.ok(userInfo.pinboard.length > 0);
        
        return socket.emit('change-comment-text', {
          __sign__: true,
          comment: newCommentText,
          trustedhtml: 1,
          commentid: userInfo.pinboard[0].commentid,
          cstate: newCState
        });
      }).then(result => {
        assert.equal(result.code, 'change-comment-text-success');
        
        return socket.emit('get-user-info', {
          lookfor: '$self',
          noCache: true, __sign__: true
        });
      }).then(userInfo => {
        assert.equal(userInfo.code, 'get-user-info-success');
        
        assert.ok(userInfo.pinboard);
        assert.ok(userInfo.pinboard.length > 0);
        assert.equal(userInfo.pinboard[0].comment, newCommentText);
        assert.equal(userInfo.pinboard[0].cstate, newCState);
      });
    });
  });
  
  describe('notify-unstick-all', function() {
    it('Should remove the sticky flag from all moderator notifications', function() {
      return socket.emit('notify-unstick-all', {
        __sign__: true
      }).then(result => {
        assert.equal(result.code, 'notify-unstick-all-success');
      });
    });
  });
  
  describe('notify-all', function() {
    it('Should write events to all feeds', function() {
      return socket.emit('notify-all', {
        __sign__: true,
        content: 'DON’T PANIC',
        sticky: 1,
      }).then(result => {
        assert.equal(result.code, 'notify-all-success');
        
        return socket.once('mod-notification');
      });
    });
  });
  
  describe('rename-school', function() {
    it('Should fail for nonexistent schools', function() {
      return socket.emit('rename-school', {
        __sign__: true,
        schoolid: -1,
        schoolname: 'SCHOOL 42',
        schoolpath: '/abcdef'
      }).then(res => {
        assert.equal(res.code, 'rename-school-notfound');
      });
    });
    
    it('Should change the name of a school', function() {
      let school;
      
      return socket.emit('list-schools').then(res => {
        assert.ok(res.result.length > 0);
        school = res.result.filter(s => parentPath(s) === '/')[0];
        
        return socket.emit('rename-school', {
          __sign__: true,
          schoolid: school.schoolid,
          schoolname: 'SCHOOL 42',
          schoolpath: '/nonexistent/invalidPath'
        });
      }).then(res => {
        assert.equal(res.code, 'rename-school-notfound');
        
        return socket.emit('rename-school', {
          __sign__: true,
          schoolid: school.schoolid,
          schoolname: 'SCHOOL 42',
          schoolpath: '/' + sha256(school.path)
        });
      }).then(res => {
        assert.equal(res.code, 'rename-school-success');
        
        // rename again without really changing the school path
        return socket.emit('rename-school', {
          __sign__: true,
          schoolid: school.schoolid,
          schoolname: 'SCHOOL 42',
          schoolpath: '/' + sha256(school.path)
        });
      }).then(res => {
        assert.equal(res.code, 'rename-school-already-exists');
        
        // do not give a school path this time
        return socket.emit('rename-school', {
          __sign__: true,
          schoolid: school.schoolid,
          schoolname: 'SCHOOL 42'
        });
      }).then(res => {
        assert.equal(res.code, 'rename-school-success');
      });
    });
  });
  
  describe('join-schools', function() {
    it('Should merge two schools together', function() {
      const prefix = 'S' + Date.now();
      let id1, id2;
      
      return Promise.all([prefix + 'Aj', prefix + 'Bj'].map(name => {
        return socket.emit('create-school', {
          __sign__: true,
          schoolname: name,
        }).then(res => {
          assert.equal(res.code, 'create-school-success');
          
          return socket.emit('school-exists', {
            lookfor: res.path
          });
        }).then(res => {
          assert.equal(res.code, 'school-exists-success');
          assert.ok(res.exists);
          assert.ok(res.path);
          assert.strictEqual(parseInt(res.schoolid), res.schoolid);
          
          return res.schoolid;
        });
      })).then(spread((id1_, id2_) => {
        id1 = id1_, id2 = id2_;
        
        return socket.emit('join-schools', {
          __sign__: true,
          masterschool: id1,
          subschool: id2
        });
      })).then(res => {
        assert.equal(res.code, 'join-schools-success');
        
        return socket.emit('list-schools');
      }).then(res => {
        assert.equal(res.code, 'list-schools-success');
        assert.ok(res.result);
        assert.notEqual(_.map(res.result, 'schoolid').indexOf(id1), -1);
        assert.equal   (_.map(res.result, 'schoolid').indexOf(id2), -1);
      });
    });
    
    it('Should fail if one of the schools does not exist', function() {
      return socket.emit('list-schools').then(res => {
        assert.equal(res.code, 'list-schools-success');
        assert.ok(res.result);
        
        const existentIDs = _.map(res.result, 'schoolid');
        const nonexistentID = (Math.max.apply(Math, existentIDs) || 0) + 1;
        
        return socket.emit('join-schools', {
          __sign__: true,
          masterschool: nonexistentID,
          subschool: nonexistentID + 1,
        });
      }).then(res => {
        assert.equal(res.code, 'join-schools-notfound');
      });
    });
  });
  
  describe('get-followers', function() {
    it('Should provide a list of followers', function() {
      let leader;
      const amount = 7;
      
      return socket.emit('list-all-users', {
        __sign__: true
      }).then(result => {
        assert.equal(result.code, 'list-all-users-success');
        
        assert.ok(result.results.length > 0);
        
        leader = result.results[0];
        
        return socket.emit('stock-buy', {
          amount: amount,
          value: null,
          stockid: null,
          leader: leader.uid,
          forceNow: true
        });
      }).then(result => {
        assert.equal(result.code, 'stock-buy-success');
        
        return socket.emit('get-followers', {
          __sign__: true,
          uid: leader.uid
        });
      }).then(result => {
        assert.equal(result.code, 'get-followers-success');
        assert.ok(result.results.length > 0);
        
        const ownUserFollowerEntry = result.results.filter(follower => follower.uid === user.uid)[0];
        
        assert.ok(ownUserFollowerEntry);
        assert.equal(ownUserFollowerEntry.amount, amount);
      });
    });
  });
  
  describe('get-server-statistics', function() {
    it('Should return a list of servers', function() {
      return socket.emit('get-server-statistics', {
        __sign__: true
      }).then(res => {
        assert.equal(res.code, 'get-server-statistics-success');
        assert.ok(res.servers.length > 0);
      });
    });
  });
  
  describe('get-ticks-statistics', function() {
    it('Should return a timeline of tick statistics', function() {
      return socket.emit('prod', { __sign__: true }).then(() => {
        return socket.emit('get-ticks-statistics', { __sign__: true });
      }).then(res => {
        assert.equal(res.code, 'get-ticks-statistics-success');
        assert.ok(res.results.length > 0);
        assert.ok(res.results[0].timeindex);
        assert.ok(res.results[0].ticksum);
      });
    });
  });
  
  describe('get-event-statistics', function() {
    it('Should return a histogram of event counts', function() {
      return socket.emit('get-event-statistics', {
        __sign__: true,
        ndays: 10000
      }).then(res => {
        assert.equal(res.code, 'get-event-statistics-success');
        assert.ok(res.result.length > 0);
        assert.ok(res.result[0].timeindex);
        
        // only days where events *happened* included
        // -> this should be okay
        assert.ok(res.result[0].nevents);
        assert.ok(res.result[0].nuser);
      });
    });
    
    it('Should return a histogram of event counts, filtered by type', function() {
      return socket.emit('get-event-statistics', {
        __sign__: true,
        ndays: 10000,
        types: ['comment']
      }).then(res => {
        assert.equal(res.code, 'get-event-statistics-success');
        assert.ok(res.result.length > 0);
        assert.ok(res.result[0].timeindex);
        
        // only days where events *happened* included
        // -> this should be okay
        assert.ok(res.result[0].nevents);
        assert.ok(res.result[0].nuser);
      });
    });
  });
  
  describe('list-all-events', function() {
    it('Should return all events within a given timespan', function() {
      return socket.emit('list-all-events', {
        __sign__: true,
        omitUidFilter: true,
        includeDeletedComments: true,
        since: 1446054731,
        upto: 1446054955 // events for these dates are in the test DB
      }).then(res => {
        assert.equal(res.code, 'list-all-events-success');
        assert.ok(res.results.length > 0);
        assert.ok(res.results[0].eventtime);
      });
    });
  });
});
