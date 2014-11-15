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
 * @param {callback} reply
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
