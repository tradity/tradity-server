# The official Tradity server documentation

<a name="basic-information"></a>
## Basic information

Tradity (or, in the server code, called `sotrade` or similar),
follows a client-server architecture.

The server part of this software package is documented here,
as well as most data structures, event and request types which
are sent “over the wire”.

### Server structure

The server listens on a HTTP(S) port specified by the server configuration
(see {@link module:config}) and waits for incoming `socket.io` connections.

These connections are associated with a {@link module:connectiondata~ConnectionData}
object which contains all methods relevant to reading and writing
data from/to the client.

### Over the wire: Requests and events

Usually, communication to the client is request-based, i.e. the client
sends a `query` object with a `.type` property which is evaluated
and the query is passed on to a handler function which performs
actions like querying the underlying SQL database backend,
gathers the results and formulates a response with the `.code`
property indicating success or failure reasons.
Often, the success code is just the query type with `-success`
added, e.g. the success-indicating response to `get-user-info`
is `get-user-info-success`.

A complete list and documentation on all request types can be found
in the {@link c2s} namespace.

Occasionally, esp. when first establishing the connection,
events are sent from the server to the client without any
request having taken place.
There are various event types, which are documented in the {@link s2c}
namespace.

### The server bus

Internally, interaction between the modules usually does not
make use of requiring modules and calling methods on objects directly;
For decoupling, better logging support and (almost) network transparency,

Instead, an internal message bus is employed, supporting requests
and events. You usually do not need to know about internals
of this messaging system, since all instances of the
{@link module:buscomponent~BusComponent} class automatically have
own `.on` and `.emit` methods (which behave like you expect them to).

Additionally, you can use `.request` for response-based communication,
for example:

```js
this.request({name: 'sendTemplateMail', 
	template: 'invite-email.eml',
	variables: {'email': data.email}
	ctx: ctx,
}).then(function() {
	...
});
```

This is (a modified) example from the actual server code;
Note that the request type is specified via the `.name` property
and a number of arguments is passed in a dictionary-like manner.

While, in theory, there could be an event listener for the 
`sentTemplateMail` event which handles the event that has just been sent,
in practice the handler ({@link busreq~sendTemplateMail} in this example)
has been set up using the {@link module:buscomponent~provide} annotation
as in the following example:

```js
Mailer.prototype.sendTemplateMail = buscomponent.provide('sendTemplateMail',
	['variables', 'template', 'ctx', 'mailtype'],
	function(variables, template, ctx, mailtype) {
	...
});
```

You can find a list of bus request types in the {@link busreq} namespace.

Also, client requests are implemented as bus requests with the `client-`
prefix; There are shorthands for `provide` with the arguments `query` and `ctx`
(e.g. `provideQT` or, for handlers requiring database write access `provideWQT`).

### The query context

You may have noticed that, in the above examples, a `ctx` variable was
silently passed along. This is an instance of {@link module:qctx~QContext},
a class which provides information on the context in which the current
server code executes (user and access level) and shorthand methods
for frequently needed tasks (like SQL queries via `.query` and
insertion of events into the feed via `.feed`).
This has the additional advantage that SQL queries can be mapped to
clients, which in turn can be used for debugging, user-based query
throttling and/or similar technologies.

### Server processes and initial loading
The server code has been modified to allow multiple server instances
to run as multiple processes and even on different hosts.

When the server is started via invoking `main.js`, a group
of worker processes is forked and starts handling client queries.

A further process may be forked to handle regularly called
code, i.e. fetching current stock values, updating
the leader’s stock values and paying provisions.
This process’ main entry point is the {@link module:background-worker}
module.

The master process and all workers load a list of modules,
depending on their type. All exported instances of these modules
are checked for being bus components and are, if they are,
added to the local bus instance.
In the process of this, the handlers configured with `provide`
are installed and listen on the bus for events matching their name.

Communication between the master process and the workers
is performed over the message bus using the Node.js cluster
messaging.

Communication between servers on different hosts is done
via socket.io sockets (which initially connect like normal clients).

<a name="non-programmers"></a>
## Resources for non-programmers

Information about server internals that may be relevant to non-programmers:

* Calculation of provisions: See {@link busreq~updateProvisions}.
* Calculation of follower rankings: See {@link module:user~RankingEntry}.
* Ranking of popular stocks: See {@link c2s~list-popular-stocks}.
* Transaction log for financial transparency: See {@link c2s~list-transactions}.
