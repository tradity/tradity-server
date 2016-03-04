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
const testHelpers = require('./test-helpers.js');

describe('wordpress-feed', function() {
  let socket, user;
  
  before(function() {
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('process-wordpress-feed', function() {
    it('Should work', function() {
      return socket.emit('process-wordpress-feed', {
        __sign__: true
      }).then(res => {
        assert.equal(res.code, 'process-wordpress-feed-success');
      });
    });
  });
  
  describe('add-wordpress-feed', function() {
    it('Should add a wordpress feed entry which can later be removed', function() {
      const endpoint = 'https://example.com/' + Date.now();
      
      return socket.emit('add-wordpress-feed', {
        __sign__: true,
        endpoint: endpoint,
        category: null,
        schoolid: null,
        bloguser: user.uid
      }).then(res => {
        assert.equal(res.code, 'add-wordpress-feed-success');
        
        return socket.emit('list-wordpress-feeds');
      }).then(res => {
        assert.equal(res.code, 'list-wordpress-feeds-success');
        
        const recentEntry = res.results.filter(function(blog) {
          return blog.endpoint === endpoint;
        })[0];
        
        assert.ok(recentEntry);
        
        return socket.emit('remove-wordpress-feed', {
          blogid: recentEntry.blogid
        });
      }).then(res => {
        assert.equal(res.code, 'remove-wordpress-feed-success');
        
        return socket.emit('list-wordpress-feeds');
      }).then(res => {
        assert.equal(res.code, 'list-wordpress-feeds-success');
        
        assert.equal(_.map(res.results, 'endpoint').indexOf(endpoint), -1);
      });
    });
  });
});
