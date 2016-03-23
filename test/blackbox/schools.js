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
const fs = require('fs');
const testHelpers = require('./test-helpers.js');
const promiseUtil = require('../../lib/promise-util.js');
const readFile = promiseUtil.ncall(fs.readFile);

describe('schools', function() {
  let socket, user;

  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  const getOwnSchool = function() {
    return socket.get('/user/$self').then(res => {
      assert.ok(res._success);
      assert.ok(res.data.schools);
      assert.ok(res.data.schools.length > 0);
      return res.data.schools[0];
    });
  };

  describe('/school', function() {
    it('Should return information on a given school', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.data.name);
        assert.equal(school.schoolid, res.data.schoolid);
        
        return socket.get('school-exists', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.exists);
        assert.equal(res.data.path, school.path);
      });
    });
  });
  
  describe('/school-exists', function() {
    it('Should indicate whether a school exists (Query string version)', function() {
      return socket.get('/school-exists', {
        qs: { lookfor: '/nonexistent' }
      }).then(res => {
        assert.ok(res._success);
        assert.ok(!res.data.exists);
      });
    });
    
    it('Should indicate whether a school exists (URI param version)', function() {
      return socket.get('/school-exists/nonexistent').then(res => {
        assert.ok(res._success);
        assert.ok(!res.data.exists);
      });
    });
  });
  
  describe('/school/…/description', function() {
    it('Requires school admin privileges', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.put('/school/' + school.schoolid + '/description', {
          body: {
            descpage: 'Bla bla bla'
          }
        });
      }).then(res => {
        assert.equal(res.code, 403);
      });
    });
    
    it('Should change a school’s description text', function() {
      let school;
      const descpage = 'Blahlahblah';
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.put('/school/' + school.schoolid + '/description', {
          __sign__: true,
          body: {
            descpage: descpage
          }
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.strictEqual(res.data.descpage, descpage);
      });
    });
  });
  
  describe('/school/…/members/… (PUT)', function() {
    it('Should toggle admin status', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.put('/school/' + school.schoolid + '/members/' + user.uid, {
          __sign__: true,
          body: {
            status: 'admin',
          }
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.admins);
        assert.ok(res.data.admins.length > 0);
        assert.notEqual(res.data.admins.map(a => a.adminid).indexOf(user.uid), -1);
        
        return socket.put('/school/' + school.schoolid + '/members/' + user.uid, {
          __sign__: true,
          body: {
            status: 'member'
          }
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.admins);
        assert.equal(res.data.admins.map(a => a.adminid).indexOf(user.uid), -1);
      });
    });
  });
  
  describe('/school/…/comments/…', function() {
    it('Should delete a comment on a school pinboard', function() {
      let school;
      let eventid;
      const origCommentText = 'Some offensive text';
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.data.eventid);
        eventid = res.data.eventid;
        
        return socket.post('/events/' + eventid + '/comments', {
          body: {
            comment: origCommentText
          }
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        
        const comments = res.data.comments;
        assert.ok(comments);
        assert.ok(comments.length > 0);
        
        const comment = comments.sort((a, b) => { return b.time - a.time; })[0]; // most recent comment
        assert.equal(comment.comment, origCommentText);
        
        return socket.delete('/school/' + school.schoolid + '/comments/' + comment.commentid, {
          __sign__: true
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        
        const comments = res.data.comments;
        assert.ok(comments);
        assert.ok(comments.length > 0);
        
        const comment = comments.sort((a, b) => b.time - a.time)[0]; // most recent comment
        assert.strictEqual(comment.cstate, 'gdeleted');
        assert.ok(comment.isDeleted);
      });
    });
  });
  
  describe('/school/…/members/… (DELETE)', function() {
    it('Should remove the current user from their group', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.delete('/school/' + school.schoolid + '/members/' + user.uid, {
          __sign__: true
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/user/$self', {
          cache: false, __sign__: true
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.schools);
        assert.equal(res.data.schools.length, 0);
        
        return socket.get('/options');
      }).then(res => {
        assert.ok(res._success);
        res.data.school = school.schoolid;
        
        return socket.put('/options', {
          body: res.data
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/user/$self', {
          cache: false, __sign__: true
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.schools);
        assert.ok(res.data.schools.length > 0);
      });
    });
  });
  
  describe('/school (POST)', function() {
    it('Should refuse to create already-existing schools', function() {
      return getOwnSchool().then(school => {
        return socket.post('/school', {
          __sign__: true,
          body: {
            schoolname: 'Doublé',
            schoolpath: school.path
          }
        });
      }).then(res => {
        assert.equal(res.code, 403);
      });
    });
    
    it('Should not create schools with invalid paths', function() {
      return socket.post('/school', {
        __sign__: true,
        body: {
          schoolname: 'Nonexistent Students of the World',
          schoolpath: '/nonexistent/nsotw'
        }
      }).then(res => {
        assert.equal(res.code, 404);
      });
    });
    
    it('Should create schools', function() {
      let path;
      return socket.post('/school', {
        __sign__: true,
        body: {
          schoolname: 'S' + Date.now(),
        }
      }).then(res => {
        assert.ok(res._success);
        path = res.path;
        
        return socket.get('/school-exists', {
          qs: { lookfor: path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.exists);
        
        return socket.get('/schools');
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.notEqual(res.data.map(s => s.path).indexOf(path), -1);
      });
    });
  });
  
  describe('/school/…/banner', function() {
    it('Should provide schools with banners', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return readFile('res/bob.jpg');
      }).then(data => {
        return socket.put('/school/' + school.schoolid + '/banner', {
          __sign__: true,
          body: data,
          json: false,
          headers: {
            'Content-Type': 'image/jpeg'
          },
          qs: {
            name: 'bob.jpg'
          }
        });
      }).then(res => {
        assert.ok(res._success);
        
        return socket.get('/school', {
          qs: { lookfor: school.path }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data.banner);
      });
    });
  });
  
  describe('/create-invitelink', function() {
    it('Should assign school IDs to invitation links', function() {
      let school;
      
      return getOwnSchool().then(school_ => {
        school = school_;
        
        return socket.post('/school/' + school.schoolid + '/create-invitelink', {
          __sign__: true,
          body: {
            email: null
          }
        });
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.ok(res.data.key);
        
        return socket.get('/invitekey/' + res.data.key);
      }).then(res => {
        assert.ok(res._success);
        assert.ok(res.data);
        assert.equal(res.data.schoolid, school.schoolid);
      });
    });
    
    it('Fails for invalid emails', function() {
      return socket.post('/create-invitelink', {
        body: {
          email: 'invalid'
        }
      }).then(res => {
        assert.strictEqual(res.code, 403);
        assert.strictEqual(res.identifier, 'invalid-email');
      });
    });
  });
});
