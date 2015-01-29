/**
 * Basic structure of queries passed from client to server.
 * @typedef Query
 * @type {object}
 * 
 * @property {string} type An identifier indicating the type of the query.
 */

/**
 * General format for client request handlers.
 * @callback QTCallback
 * 
 * @param {Query} query    The query, as presented by the client.
 * @param {module:qctx~QContext} ctx
 */
/**
 * General format for advanced client request handlers.
 * @callback QTXCallback
 * 
 * @param {Query} query    The query, as presented by the client.
 * @param {module:qctx~QContext} ctx
 * @param {object} xdata
 */

/**
 * Dummy module to represent the bus namespace
 * @namespace busreq
 */

/**
 * Dummy module to represent the namespace of client-to-server requests
 * @namespace c2s
 */

/**
 * Dummy module to represent the namespace of server-to-client event pushes
 * @namespace s2c
 */

/**
 * Basic game event structure.
 * These game events are only a subset of possible server-to-client events,
 * but represent a large share of the latter group.
 * 
 * See {@link s2c} for a comprehensive list of events.
 * 
 * @typedef Event
 * @type {object}
 * 
 * @property {int} eventid  The general numerical event identifier.
 * @property {string} type  A short, machine-readable event type identifier
 *                          (e.g. <code>user-reset</code>).
 * @property {?int} targetid  An identifier of the object this event relates to.
 *                           The precise interpretation depends on the event type.
 * @property {int} time  The unix timestamp of the event (in sec).
 * @property {int} srcuser  The event id of the user which caused the event.
 *                          Often, this will be accompanied by more information on this user
 *                          (e.g. a property <code>srcusername</code>).
 */

/**
 * Information for a single trade comment/pinboard entry/etc.
 * 
 * @typedef Comment
 * @type {object}
 * 
 * @property {int} commentid  A numerical identifier of this comment
 * @property {int} commenter  The numerical id of the comment author
 * @property {string} username  The user name chosen by the comment author
 * @property {?string} profilepic  A reference to a profile image for the comment
 *                                 author
 * @property {string} comment  The actual comment text
 * @property {boolean} trustedhtml  Whether <code>comment</code> contains
 *                                  HTML that can safely be displayed
 */
