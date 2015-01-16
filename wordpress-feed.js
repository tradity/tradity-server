(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var Q = require('q');
var WP = require('wordpress-rest-api');
var buscomponent = require('./stbuscomponent.js');

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
function WordpressFeed () {
	WordpressFeed.super_.apply(this, arguments);
};

util.inherits(WordpressFeed, buscomponent.BusComponent);

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
WordpressFeed.prototype.processBlogs = buscomponent.provideWQT('client-process-wordpress-feed', function(query, ctx, cb) {
	if (ctx.access.has('server') == -1)
		return cb('process-wordpress-feed-not-allowed');
	
	ctx.query('SELECT endpoint, category, schoolid, bloguser, MAX(posttime) AS lastposttime ' +
		'FROM feedblogs ' + 
		'JOIN feedposts ON feedblogs.blogid = feedposts.postid', [], function(res) {
		return Q.all(res.map(function(bloginfo) {
			var wp = new WP({endpoint: bloginfo.endpoint});
			
			return Q.nfcall(wp.posts().filter({category_name: bloginfo.category}).get).then(function(posts) {
				return Q.all(posts.filter(function(post) {
					post.date_unix = new Date(post.date_gmt).getTime() / 1000;
					return post.date_unix > bloginfo.lastposttime;
				}).map(function(post) {
					return ctx.query('INSERT INTO blogposts (posttime, link, title, excerpt) VALUES (?, ?, ?, ?)',
						[post.date_unix, post.link, post.title, post.excerpt], function(r) {
						return ctx.feed({
							type: 'blogpost',
							targetid: r.insertId,
							srcuser: bloginfo.bloguser,
							everyone: bloginfo.schoolid == null,
							feedschool: bloginfo.schoolid
						});
					});
				}));
			});
		})).done(function() {
			cb('process-wordpress-feed-success');
		});
	});
});

exports.WordpressFeed = WordpressFeed;

})();
