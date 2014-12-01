#!/usr/bin/env node

(function () { "use strict";

Error.stackTraceLimit = Infinity;

var MailParser = new require('mailparser').MailParser;
var sotradeClient = require('./sotrade-client.js');
var socket = new sotradeClient.SoTradeConnection({ logDevCheck: false });

var mail = null, serverConfigReceived = false;
var diagnostic_code = '', messageId = '';

function notifyServer() {
	socket.emit('email-bounced', { diagnostic_code: diagnostic_code, messageId: messageId }).then(function() {
		process.exit(0);
	}).done();
}

var mailparser = new MailParser();

function handleMail(mail) {
	for (var i = 0; i < mail.attachments.length; ++i) (function() {
		var attachment = mail.attachments[i];
		
		var attachmentParser = new MailParser();
		
		attachmentParser.on('end', function(attachmentContent) {
			if (attachment.contentType == 'message/delivery-status') {
				var dsParser = new MailParser();
				
				dsParser.on('end', function(dsContent) {
					diagnostic_code = dsContent.headers['diagnostic-code'];
					
					if (messageId)
						notifyServer();
				});
				
				dsParser.end(attachmentContent.text);
			} else if (attachment.contentType == 'message/rfc822') {
				messageId = attachmentContent.headers['message-id'].replace(/^<|@.+$/g, '');
				
				if (diagnostic_code)
					notifyServer();
			}
		});
		
		attachmentParser.end(attachment.content);
	})();
}

mailparser.on('end', function(mail_) {
	mail = mail_;
	if (serverConfigReceived)
		handleMail(mail);
});

process.stdin.pipe(mailparser);

socket.once('server-config', function() {
	serverConfigReceived = true;
	if (mail)
		handleMail(mail);
});

})();
