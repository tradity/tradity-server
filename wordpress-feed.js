(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var WP = require('wordpress-rest-api');
var buscomponent = require('./stbuscomponent.js');
var debug = require('debug')('sotrade:wordpress-feed');

/**
 * Provides methods for reading posts from a wordpress blog
 * into user and/or group feeds.
 * 
 * @public
 * @module wordpress-feed
 */

/**
 * Main object of the {@link module:wordpress-feed} module
 * @public
 * @constructor module:wordpress-feed~WordpressFeed
 * @augments module:stbuscomponent~STBusComponent
 */
class WordpressFeed extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

/**
 * Fetches all blog feeds and inserts corresponding feed entries.
 * 
 * @return {object} Returns with <code>process-wordpress-feed-success</code>
 *                  or a common error code.
 * 
 * @noreadonly
 * @loginignore
 * @function c2s~process-wordpress-feed
 */
WordpressFeed.prototype.processBlogs = buscomponent.provideTXQT('client-process-wordpress-feed', function(query, ctx) {
  if (ctx.access.has('wordpress') == -1)
    throw new this.PermissionDenied();
  
  debug('Received process-wordpress-feed');
  
  return ctx.query('SELECT feedblogs.blogid, endpoint, category, schoolid, bloguser, MAX(posttime) AS lastposttime ' +
    'FROM feedblogs ' + 
    'LEFT JOIN blogposts ON feedblogs.blogid = blogposts.blogid ' +
    'WHERE feedblogs.active ' +
    'GROUP BY blogid FOR UPDATE').then(function(res) {
    return Promise.all(res.map(function(bloginfo) {
      var wp = new WP({endpoint: bloginfo.endpoint});
      var catFilter = bloginfo.category ? {category_name: bloginfo.category} : null;
      
      debug('Fetching blog posts', bloginfo.endpoint, bloginfo.category);
      
      return Promise.resolve(wp.posts().filter(catFilter)).then(function(posts) {
        return Promise.all(posts.filter(function(post) {
          post.date_unix = new Date(post.date_gmt).getTime() / 1000;
          
          if (bloginfo.lastposttime === null)
            return true;
          return post.date_unix > bloginfo.lastposttime;
        }).map(function(post) {
          return ctx.query('INSERT INTO blogposts (blogid, posttime, postjson) ' +
            'VALUES (?, ?, ?)',
            [bloginfo.blogid, post.date_unix, JSON.stringify(post)]).then(function(r) {
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
  }).then(function() {
    debug('Done processing feeds');
    return { code: 'process-wordpress-feed-success' };
  });
});

/**
 * Return a list of all blogs whose posts are inserted into feeds.
 * 
 * @return {object} Returns with <code>list-wordpress-feeds-success</code>
 *                  or a common error code.
 * 
 * @function c2s~list-wordpress-feeds
 */
WordpressFeed.prototype.listWordpressFeeds = buscomponent.provideQT('client-list-wordpress-feeds', function(query, ctx) {
  if (ctx.access.has('wordpress') == -1)
    throw new this.PermissionDenied();
  
  // compare schools.js
  return ctx.query('SELECT feedblogs.blogid, endpoint, category, schools.schoolid, path AS schoolpath, ' +
    'bloguser, COUNT(*) AS postcount, users.name ' +
    'FROM feedblogs ' + 
    'LEFT JOIN blogposts ON feedblogs.blogid = blogposts.blogid ' +
    'LEFT JOIN users ON feedblogs.bloguser = users.uid ' +
    'LEFT JOIN schools ON feedblogs.schoolid = schools.schoolid ' +
    'WHERE feedblogs.active ' +
    'GROUP BY blogid').then(function(res) {
    return { code: 'list-wordpress-feeds-success', results: res };
  });
});

/**
 * Add an associated blog for a given feed.
 * 
 * @param {?string} query.endpoint  The Wordpress API endpoint
 * @param {?string} query.category  The relevant Wordpress category slug
 * @param {?int} query.schoolid  The numerical school ID whose feed blogposts
 *                               will be posted to
 * @param {?int} query.bloguser The numerical ID of the user to whom the events
 *                              will be attributed to (as srcuser)
 * 
 * @return {object} Returns with <code>add-wordpress-feed-success</code>,
 *                  <code>add-wordpress-feed-missingdata</code> in case no general
 *                  blog previous blog entry was found in order to choose endpoint and
 *                  bloguser, or a common error code.
 * 
 * @noreadonly
 * @function c2s~add-wordpress-feed
 */
WordpressFeed.prototype.addWordpressFeed = buscomponent.provideWQT('client-add-wordpress-feed', function(query, ctx) {
  var self = this;
  
  if (ctx.access.has('wordpress') == -1)
    throw new self.PermissionDenied();
    
  query.schoolid = query.schoolid ? parseInt(query.schoolid) : null;
  query.category = query.category ? String(query.category) : null;
  
  if (query.schoolid != query.schoolid)
    throw new self.FormatError();
  
  debug('Add feed', query.schoolid, query.category);
  
  return ctx.query('SELECT endpoint, bloguser FROM feedblogs WHERE schoolid IS NULL LIMIT 1').then(function(res) {
    if (res.length > 0) {
      assert.ok(res[0].endpoint);
      assert.ok(parseInt(res[0].bloguser) == res[0].bloguser);
    }
    
    if ((!query.endpoint || query.bloguser == null) && res.length == 0) {
      throw new self.SoTradeClientError('add-wordpress-feed-missingdata');
    }
    
    query.endpoint = query.endpoint ? String(query.endpoint) : res[0].endpoint;
    query.bloguser = query.bloguser != null ? parseInt(query.bloguser) : res[0].bloguser;
    if (query.bloguser != query.bloguser)
      throw new self.FormatError();
    
    debug('Insert feed', query.schoolid, query.category, query.endpoint, query.bloguser);
    
    return ctx.query('INSERT INTO feedblogs (endpoint, category, schoolid, bloguser, active) VALUES(?, ?, ?, ?, 1)',
      [query.endpoint, query.category, query.schoolid, query.bloguser]);
  }).then(function() {
    return { code: 'add-wordpress-feed-success' };
  });
});

/**
 * Remove an associated blog from a given feed.
 * 
 * @param {int} query.blogid  The blog’s numerical ID
 * 
 * @return {object} Returns with <code>remove-wordpress-feed-success</code>
 *                  or a common error code.
 * 
 * @noreadonly
 * @function c2s~remove-wordpress-feed
 */
WordpressFeed.prototype.removeWordpressFeed = buscomponent.provideWQT('client-remove-wordpress-feed', function(query, ctx) {
  if (ctx.access.has('wordpress') == -1)
    throw new this.PermissionDenied();
  
  query.blogid = parseInt(query.blogid);
  
  if (query.blogid != query.blogid)
    throw new this.FormatError();

  debug('Remove blog', query.blogid);

  return ctx.query('UPDATE feedblogs SET active = 0 WHERE blogid = ?', [query.blogid]).then(function() {
    return { code: 'remove-wordpress-feed-success' };
  });
});

exports.WordpressFeed = WordpressFeed;

})();
