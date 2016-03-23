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

"use strict";

const assert = require('assert');
const WP = require('wordpress-rest-api');
const api = require('./api.js');
const debug = require('debug')('sotrade:wordpress-feed');

class ProcessBlogs extends api.Requestable {
  constructor() {
    super({
      url: '/wordpress/processFeed',
      transactional: true,
      methods: ['POST'],
      returns: [ { code: 204 } ],
      requiredAccess: 'wordpress',
      requiredLogin: false,
      description: 'Fetches all blog feeds and inserts corresponding feed entries.'
    });
  }
  
  handle(query, ctx) {
    debug('Received process-wordpress-feed');
    
    return ctx.query('SELECT feedblogs.blogid, endpoint, category, schoolid, bloguser, MAX(posttime) AS lastposttime ' +
      'FROM feedblogs ' + 
      'LEFT JOIN blogposts ON feedblogs.blogid = blogposts.blogid ' +
      'WHERE feedblogs.active ' +
      'GROUP BY blogid FOR UPDATE').then(res => {
      return Promise.all(res.map(bloginfo => {
        const wp = new WP({endpoint: bloginfo.endpoint});
        const catFilter = bloginfo.category ? {category_name: bloginfo.category} : null;
        
        debug('Fetching blog posts', bloginfo.endpoint, bloginfo.category);
        
        return Promise.resolve(wp.posts().namespace('').version('').filter(catFilter)).then(posts => {
          return Promise.all(posts.filter(post => {
            post.date_unix = new Date(post.date_gmt).getTime() / 1000;
            
            if (bloginfo.lastposttime === null) {
              return true;
            }
            
            return post.date_unix > bloginfo.lastposttime;
          }).map(post => {
            return ctx.query('INSERT INTO blogposts (blogid, posttime, postjson) ' +
              'VALUES (?, ?, ?)',
              [bloginfo.blogid, post.date_unix, JSON.stringify(post)]).then(r => {
              assert.ok(r.insertId);
              
              debug('Adding blog post', bloginfo.endpoint, bloginfo.category, post.title);
              
              return ctx.feed({
                type: 'blogpost',
                targetid: r.insertId,
                srcuser: bloginfo.bloguser,
                everyone: bloginfo.schoolid == null,
                feedschool: bloginfo.schoolid,
                time: post.date_unix
              });
            });
          }));
        });
      }));
    }).then(() => {
      debug('Done processing feeds');
      return { code: 204 };
    });
  }
}

class ListFeeds extends api.Requestable {
  constructor() {
    super({
      url: '/wordpress/feeds',
      requiredAccess: 'wordpress',
      description: 'Return a list of all blogs whose posts are inserted into feeds.'
    });
  }
  
  handle(query, ctx) {
    // compare schools.js
    return ctx.query('SELECT feedblogs.blogid, endpoint, category, schools.schoolid, path AS schoolpath, ' +
      'bloguser, COUNT(*) AS postcount, users.name ' +
      'FROM feedblogs ' + 
      'LEFT JOIN blogposts ON feedblogs.blogid = blogposts.blogid ' +
      'LEFT JOIN users ON feedblogs.bloguser = users.uid ' +
      'LEFT JOIN schools ON feedblogs.schoolid = schools.schoolid ' +
      'WHERE feedblogs.active ' +
      'GROUP BY blogid').then(res => {
      return { code: 200, data: res };
    });
  }
}

class AddFeed extends api.Requestable {
  constructor() {
    super({
      url: '/wordpress/addFeed',
      methods: ['POST'],
      requiredAccess: 'wordpress',
      writing: true,
      description: 'Add an associated blog for a given feed.',
      returns: [
        { code: 200 },
        { code: 404, identifier: 'missingdata',
          description: 'in case no general blog previous blog entry was found in order to choose endpoint' }
      ],
      schema: {
        type: 'object',
        properties: {
          endpoint: {
            type: ['string', 'null'],
            description: 'The Wordpress API endpoint'
          },
          category: {
            type: ['string', 'null'],
            description: 'The relevant Wordpress category slug'
          },
          schoolid: {
            type: ['integer', 'null'],
            description: 'The numerical school ID whose feed blogposts will be posted to'
          },
          bloguser: {
            type: ['integer', 'null'],
            description: 'The numerical ID of the user to whom the events will be attributed to (as srcuser)'
          }
        }
      }
    });
  }
  
  handle(query, ctx) {
    debug('Add feed', query.schoolid, query.category);
    
    return ctx.query('SELECT endpoint, bloguser FROM feedblogs WHERE schoolid IS NULL LIMIT 1').then(res => {
      if (res.length > 0) {
        assert.ok(res[0].endpoint);
        assert.equal(parseInt(res[0].bloguser), res[0].bloguser);
      }
      
      if ((!query.endpoint || query.bloguser === null) && res.length === 0) {
        throw new this.ClientError('missingdata');
      }
      
      const endpoint = query.endpoint ? String(query.endpoint) : res[0].endpoint;
      const bloguser = query.bloguser !== null ? parseInt(query.bloguser) : res[0].bloguser;
      
      assert.equal(bloguser, bloguser);
      
      debug('Insert feed', query.schoolid, query.category, endpoint, bloguser);
      
      return ctx.query('INSERT INTO feedblogs (endpoint, category, schoolid, bloguser, active) VALUES(?, ?, ?, ?, 1)',
        [endpoint, query.category, query.schoolid, bloguser]);
    }).then(() => {
      return { code: 200 };
    });
  }
}

class RemoveFeed extends api.Requestable {
  constructor() {
    super({
      url: '/wordpress/feeds/:blogid',
      methods: ['DELETE'],
      requiredAccess: 'wordpress',
      writing: true,
      description: 'Remove an associated blog from a given feed.',
      returns: [ { code: 204 } ],
      schema: {
        type: 'object',
        properties: {
          blogid: {
            type: 'integer',
            description: 'The blog’s numerical ID'
          }
        },
        required: ['blogid']
      }
    });
  }
  
  handle(query, ctx) {
    debug('Remove blog', query.blogid);

    return ctx.query('UPDATE feedblogs SET active = 0 WHERE blogid = ?', [query.blogid]).then(() => {
      return { code: 204 };
    });
  }
}

exports.components = [
  ProcessBlogs,
  AddFeed,
  ListFeeds,
  RemoveFeed
];
